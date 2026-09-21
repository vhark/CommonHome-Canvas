/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. It is distributed WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
 * PURPOSE. See the GNU Affero General Public License for details, and the
 * LICENSE file distributed with this program.
 */
/* CommonHome Canvas — density reflow.
 *
 * `reflow` is a PURE function: it reads nothing but its arguments, touches no
 * clock, no randomness, no module-level mutable state and no I/O, and returns
 * freshly built values so the caller cannot alias its way into the input.
 * Plasma's coalescing timers, `relayoutLock` and startup-suppression all exist
 * because their relayout is not pure; none of that machinery is needed here.
 *
 * Dispatch is on `layout.kind`, and recurses: `Rows` and `Tabs` hold nested
 * layouts, so every property proven of a flat layout has to hold at every
 * depth. An unrecognised kind is returned unchanged rather than thrown on or
 * coerced, for the same reason an unknown block type is preserved: an older
 * build must never silently strip what a newer one wrote — and an unknown
 * kind nested inside a known container must not stop its siblings reflowing.
 *
 * Reflow rewrites LAYOUT ONLY. It reads `elements` to learn a block's
 * footprint and never writes to it. A container in particular reorders and
 * rewrites nothing but its own children's layouts; it has no business
 * reaching into block configuration, and the moment it needs to, purity and
 * the cheapness of per-density overrides are both gone.
 */

import {DENSITY, columnsFor, isDensityLevel, type DensityLevel} from './density.ts';
import {nearestDeclaredSize, resolveCells, type SizeRegistry} from './sizes.ts';
import {
  err,
  hasWalkableChildren,
  isAutoGridLayout,
  isGridLayout,
  ok,
  type AutoGridItem,
  type AutoGridLayout,
  type Block,
  type Cells,
  type GridItem,
  type GridLayout,
  type Layout,
  type LayoutChild,
  type OrderedContainerLayout,
  type Result,
} from './types.ts';

/* Footprints live with the block type, not with the layout item, so reflow
 * needs the element table and the type registry to know how much space an
 * item occupies. Supplying no context treats every item as a single cell,
 * which is the right degenerate answer for a caller that only cares about
 * ordering. */
export type ReflowContext = {
  elements: {[name: string]: Block};
  registry: SizeRegistry;
};

/* Thrown only for a layout that cannot be interpreted at all — in practice a
 * Grid with no `authoredDensity`. Documents are validated on load, so
 * reaching this means a layout was constructed in code without its frame of
 * reference. Callers holding untrusted input should use `tryReflow`. */
export class UninterpretableLayout extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UninterpretableLayout';
    this.code = code;
  }
}

export function reflow(layout: Layout, target: DensityLevel, context?: ReflowContext): Layout {
  const result = tryReflow(layout, target, context);
  if (!result.ok) throw new UninterpretableLayout(result.error.code, result.error.message);
  return result.value;
}

export function tryReflow(
  layout: Layout,
  target: DensityLevel,
  context?: ReflowContext,
): Result<Layout> {
  if (!isDensityLevel(target)) {
    return err('unknown_density', `no density level named ${String(target)}`);
  }
  if (isGridLayout(layout)) return reflowGrid(layout, target, context);
  if (isAutoGridLayout(layout)) return reflowAutoGrid(layout, target, context);
  if (hasWalkableChildren(layout)) return reflowContainer(layout, target, context);
  /* TREE-02. An unimplemented kind — or a container whose payload this build
   * cannot recognise — passes through intact rather than being coerced or
   * emptied, so a document authored against a newer build survives a load and
   * save here. */
  return ok(clone(layout));
}

/* Rows and Tabs: reflow each child's layout in place and change nothing else.
 * The child array is rebuilt by index, so order is preserved by construction
 * rather than by a sort that could be got wrong — the ordering guarantee is
 * the entire reason these kinds are cheap, so it should not depend on
 * arithmetic at all.
 *
 * A child whose nested layout fails to reflow fails the whole container: a
 * layout that cannot be interpreted is reported, never half-applied. That is
 * distinct from a child of an UNKNOWN kind, which reflows successfully and
 * unchanged (see tryReflow above) and so does not disturb its siblings. */
function reflowContainer(
  layout: OrderedContainerLayout,
  target: DensityLevel,
  context: ReflowContext | undefined,
): Result<Layout> {
  const children: LayoutChild[] = new Array(layout.children.length);
  for (let index = 0; index < layout.children.length; index += 1) {
    const child = layout.children[index]!;
    if (!isRecord(child) || !isRecord(child.layout)) {
      return err(
        'invalid_container_child',
        'a Rows or Tabs child must be an object carrying a layout',
        `layout.children[${index}]`,
      );
    }
    const inner = tryReflow(child.layout as Layout, target, context);
    if (!inner.ok) return inner;
    const next = clone(child);
    next.layout = inner.value;
    children[index] = next;
  }
  const projection = clone(layout) as OrderedContainerLayout;
  projection.children = children;
  return ok(projection);
}

/* AutoGrid places its own items, so density largely IS the column count and
 * there is nothing positional to preserve or scramble. Reflow therefore
 * rewrites two things: the recorded density, and `maxColumnCount` scaled by
 * the same exact integer factor the Grid kind uses — an author who asked for
 * "at most 3 across" at Comfortable(6) meant half the width, and half the
 * width at Dense(24) is 12.
 *
 * The width and height modes are deliberately untouched. They are named, not
 * numeric, precisely so that they mean the same thing at every density; a
 * reflow that rewrote them would be reintroducing the raw-number problem the
 * names exist to avoid. */
function reflowAutoGrid(
  layout: AutoGridLayout,
  target: DensityLevel,
  context: ReflowContext | undefined,
): Result<Layout> {
  const canonical = isAutoGridLayout(layout.derivedFrom ?? layout)
    ? ((layout.derivedFrom ?? layout) as AutoGridLayout)
    : layout;

  if (!isDensityLevel(canonical.authoredDensity)) {
    return err(
      'missing_authored_density',
      'an AutoGrid layout without authoredDensity is uninterpretable and will not be guessed at',
      'layout.authoredDensity',
    );
  }
  if (!Array.isArray(canonical.items)) {
    return err('invalid_items', 'an AutoGrid layout needs an items array', 'layout.items');
  }

  const source = canonical.authoredDensity;
  if (source === target) {
    const restored = clone(canonical) as AutoGridLayout;
    delete restored.derivedFrom;
    return ok(restored);
  }

  const projection = clone(canonical) as AutoGridLayout;
  projection.authoredDensity = target;
  /* Items are carried through by index and untouched: an AutoGrid item holds
   * no coordinates, so there is nothing in it for a density change to mean. */
  projection.items = canonical.items.map((item) => clone(item) as AutoGridItem);
  if (isPositiveInt(canonical.maxColumnCount)) {
    const factor = DENSITY[target] / DENSITY[source];
    projection.maxColumnCount = clamp(
      Math.max(1, Math.round(canonical.maxColumnCount * factor)),
      1,
      columnsFor(target),
    );
  }
  const origin = clone(canonical) as AutoGridLayout;
  delete origin.derivedFrom;
  projection.derivedFrom = origin;
  return ok(projection);
}

function reflowGrid(
  layout: GridLayout,
  target: DensityLevel,
  context: ReflowContext | undefined,
): Result<Layout> {
  /* Always re-derive from the canonical, never from a projection. Scaling to
   * a coarser density loses information (two adjacent columns merge into
   * one), so chaining projections would degrade a layout a little on every
   * density change — exactly the drift the idempotence property exists to
   * forbid. */
  const canonical = isGridLayout(layout.derivedFrom ?? layout)
    ? ((layout.derivedFrom ?? layout) as GridLayout)
    : layout;

  if (!isDensityLevel(canonical.authoredDensity)) {
    return err(
      'missing_authored_density',
      'a Grid layout without authoredDensity is uninterpretable and will not be guessed at',
      'layout.authoredDensity',
    );
  }
  if (!Array.isArray(canonical.items)) {
    return err('invalid_items', 'a Grid layout needs an items array', 'layout.items');
  }

  const source = canonical.authoredDensity;
  if (source === target) {
    /* Returning to the authored density restores the authored record exactly.
     * This is what makes round-trip identity hold as an equality rather than
     * an approximation. */
    const restored = clone(canonical) as GridLayout;
    delete restored.derivedFrom;
    return ok(restored);
  }

  const factor = DENSITY[target] / DENSITY[source];
  const columns = columnsFor(target);
  const placements: Placement[] = [];

  for (let index = 0; index < canonical.items.length; index += 1) {
    const item = canonical.items[index]!;
    const footprint = footprintFor(item, source, target, factor, context);
    const width = Math.min(footprint.w, columns);
    placements.push({
      index,
      item,
      w: width,
      h: footprint.h,
      size: footprint.size,
      snapped: footprint.snapped,
      desiredCol: clamp(Math.floor(toNumber(item.col) * factor), 0, columns - width),
      desiredRow: Math.max(0, Math.floor(toNumber(item.row) * factor)),
    });
  }

  /* Reading order — row, then column, then the element name — decides who
   * gets to keep its preferred cell when two blocks want it. Element name is
   * the final tie-break because it is stable across runs and across machines,
   * where array index would silently change meaning if a document were ever
   * re-serialised in a different order. Determinism matters more here than
   * optimality: a rule that always produces the same arrangement is one a
   * family can learn, and one a property test can pin down. */
  placements.sort(compareReadingOrder);

  const occupied = new Set<string>();
  const items: GridItem[] = new Array(canonical.items.length);

  for (const placement of placements) {
    const spot = firstFreeSpot(placement, columns, occupied);
    for (let row = spot.row; row < spot.row + placement.h; row += 1) {
      for (let col = spot.col; col < spot.col + placement.w; col += 1) {
        occupied.add(`${row}:${col}`);
      }
    }
    const next = clone(placement.item);
    next.col = spot.col;
    next.row = spot.row;
    /* The resolved footprint is reported on the projection so a renderer need
     * not re-resolve it, and so no-overlap is checkable from the layout
     * alone. It is never written back to the element: content is not
     * reflow's to rewrite. */
    if (placement.size !== null) {
      next.w = placement.w;
      next.h = placement.h;
      if (placement.snapped) next.snappedSize = placement.size;
    }
    items[placement.index] = next;
  }

  const projection = clone(canonical) as GridLayout;
  projection.authoredDensity = target;
  projection.items = items;
  const origin = clone(canonical) as GridLayout;
  delete origin.derivedFrom;
  projection.derivedFrom = origin;
  return ok(projection);
}

type Placement = {
  index: number;
  item: GridItem;
  w: number;
  h: number;
  size: string | null;
  snapped: boolean;
  desiredCol: number;
  desiredRow: number;
};

function compareReadingOrder(a: Placement, b: Placement): number {
  if (a.desiredRow !== b.desiredRow) return a.desiredRow - b.desiredRow;
  if (a.desiredCol !== b.desiredCol) return a.desiredCol - b.desiredCol;
  const an = toText(a.item.element);
  const bn = toText(b.item.element);
  if (an !== bn) return an < bn ? -1 : 1;
  return a.index - b.index;
}

/* Scan from the preferred cell in reading order and take the first position
 * where the whole footprint fits. Rows are unbounded, so this always
 * terminates; columns are not, which is why the footprint is clamped to the
 * grid width before we get here. */
function firstFreeSpot(
  placement: Placement,
  columns: number,
  occupied: Set<string>,
): {col: number; row: number} {
  for (let row = placement.desiredRow; ; row += 1) {
    const startCol = row === placement.desiredRow ? placement.desiredCol : 0;
    for (let col = startCol; col <= columns - placement.w; col += 1) {
      if (fits(col, row, placement.w, placement.h, occupied)) return {col, row};
    }
  }
}

function fits(col: number, row: number, w: number, h: number, occupied: Set<string>): boolean {
  for (let r = row; r < row + h; r += 1) {
    for (let c = col; c < col + w; c += 1) {
      if (occupied.has(`${r}:${c}`)) return false;
    }
  }
  return true;
}

/* Named sizes declare their cells per density, so the usual case is a lookup
 * rather than arithmetic and nothing fractional can arise. The fractional
 * case only appears when a type does not offer its current size at the target
 * density: then the arithmetic result is the *desired* footprint and we snap
 * to the nearest size the type actually declares there (sizes.ts documents
 * the tie-break). An unknown type or undeclared size keeps a single-cell slot
 * rather than being dropped — an unknown block must survive, placeholder and
 * all. */
function footprintFor(
  item: GridItem,
  source: DensityLevel,
  target: DensityLevel,
  factor: number,
  context: ReflowContext | undefined,
): {w: number; h: number; size: string | null; snapped: boolean} {
  if (context === undefined) return UNIT;
  const element = context.elements[toText(item.element)];
  if (element === undefined) return UNIT;
  const name = toText(element.namedSize);

  const direct = resolveCells(context.registry, element.type, name, target);
  if (direct.ok) return {w: direct.value.w, h: direct.value.h, size: name, snapped: false};

  const atSource = resolveCells(context.registry, element.type, name, source);
  if (!atSource.ok) return UNIT;

  const desired: Cells = {
    w: Math.max(1, Math.round(atSource.value.w * factor)),
    h: Math.max(1, Math.round(atSource.value.h * factor)),
  };
  const snapped = nearestDeclaredSize(context.registry, element.type, target, desired);
  if (!snapped.ok) return UNIT;
  return {
    w: snapped.value.cells.w,
    h: snapped.value.cells.h,
    size: snapped.value.name,
    snapped: true,
  };
}

const UNIT = {w: 1, h: 1, size: null, snapped: false} as const;

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(high, Math.max(low, value));
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
