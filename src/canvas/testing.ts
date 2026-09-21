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
/* CommonHome Canvas — deterministic generators for the property tests.
 *
 * Test support, not product code; nothing under src/canvas ships importing
 * this. Hand-rolled rather than taking a property-testing dependency: the
 * project has no runtime dependencies and a seeded PRNG plus a shrink-free
 * sweep over fixed seeds is enough to make the failures reproducible, which
 * is the property that actually matters here.
 */

import {DENSITY_LEVELS, columnsFor, type DensityLevel} from './density.ts';
import {buildRegistry, resolveCells, type BlockTypeSpec, type SizeRegistry} from './sizes.ts';
import {
  API_VERSION,
  AUTO_GRID_COLUMN_WIDTH_MODES,
  AUTO_GRID_ROW_HEIGHT_MODES,
  KIND,
  isAutoGridLayout,
  isGridLayout,
  isOrderedContainer,
  type AutoGridItem,
  type Block,
  type CanvasDocument,
  type GridLayout,
  type Layout,
  type LayoutChild,
} from './types.ts';

/* mulberry32: small, dependency-free, and identical on every run and every
 * machine, so a failing seed reported in CI reproduces locally. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CATALOGUE: BlockTypeSpec[] = [
  {
    type: 'clock',
    sizes: [
      {name: 'small', cells: {comfortable: {w: 1, h: 1}, standard: {w: 2, h: 1}, dense: {w: 4, h: 2}}},
      {name: 'medium', cells: {comfortable: {w: 2, h: 1}, standard: {w: 4, h: 2}, dense: {w: 8, h: 4}}},
    ],
  },
  {
    type: 'forecast',
    sizes: [
      /* Deliberately not offered at comfortable: a full forecast has no
       * legible form in six columns, which is what makes the snapping path
       * reachable from the generator. */
      {name: 'compact', cells: {standard: {w: 3, h: 2}, dense: {w: 6, h: 4}}},
      {name: 'full', cells: {standard: {w: 6, h: 3}, dense: {w: 12, h: 6}}},
      {name: 'tiny', cells: {comfortable: {w: 2, h: 2}, standard: {w: 4, h: 4}, dense: {w: 8, h: 8}}},
    ],
  },
  {
    type: 'photo',
    sizes: [
      {name: 'square', cells: {comfortable: {w: 2, h: 2}, standard: {w: 4, h: 4}, dense: {w: 8, h: 8}}},
      {name: 'banner', cells: {comfortable: {w: 6, h: 2}, standard: {w: 12, h: 4}, dense: {w: 24, h: 8}}},
    ],
  },
  {
    type: 'agenda',
    sizes: [
      {name: 'column', cells: {comfortable: {w: 3, h: 4}, standard: {w: 6, h: 8}, dense: {w: 12, h: 16}}},
      {name: 'strip', cells: {comfortable: {w: 1, h: 2}, standard: {w: 2, h: 4}, dense: {w: 4, h: 8}}},
    ],
  },
];

export function sampleRegistry(): SizeRegistry {
  const built = buildRegistry(CATALOGUE);
  if (!built.ok) throw new Error(`sample catalogue is invalid: ${built.error.message}`);
  return built.value;
}

/* Element names are alphabetic on purpose. JSON.parse preserves insertion
 * order except for integer-like keys, which are hoisted and reordered, so an
 * element named "12" would break byte-stable round-tripping for reasons that
 * have nothing to do with this model. */
export function elementName(index: number): string {
  return `el-${String.fromCharCode(97 + (index % 26))}${Math.floor(index / 26)}`;
}

export function generateDocument(
  seed: number,
  authoredDensity: DensityLevel,
  registry: SizeRegistry,
): CanvasDocument {
  const rng = makeRng(seed);
  const columns = columnsFor(authoredDensity);
  const count = 1 + Math.floor(rng() * 8);
  const elements: {[name: string]: Block} = {};
  const items: GridLayout['items'] = [];
  const occupied = new Set<string>();

  for (let index = 0; index < count; index += 1) {
    const candidates = offeredAt(registry, authoredDensity);
    const pick = candidates[Math.floor(rng() * candidates.length)]!;
    const cells = resolveCells(registry, pick.type, pick.size, authoredDensity);
    if (!cells.ok) continue;
    const name = elementName(index);
    elements[name] = {type: pick.type, namedSize: pick.size};
    const spot = place(cells.value.w, cells.value.h, columns, occupied, rng);
    items.push({element: name, col: spot.col, row: spot.row});
  }

  return {
    apiVersion: API_VERSION,
    kind: KIND,
    metadata: {uid: `canvas-${seed}`},
    spec: {elements, layout: {kind: 'Grid', authoredDensity, items}},
  };
}

function offeredAt(
  registry: SizeRegistry,
  density: DensityLevel,
): {type: string; size: string}[] {
  const out: {type: string; size: string}[] = [];
  for (const spec of Object.values(registry)) {
    for (const size of spec.sizes) {
      if (size.cells[density] !== undefined) out.push({type: spec.type, size: size.name});
    }
  }
  return out;
}

function place(
  w: number,
  h: number,
  columns: number,
  occupied: Set<string>,
  rng: () => number,
): {col: number; row: number} {
  const wantCol = Math.floor(rng() * Math.max(1, columns - w + 1));
  const wantRow = Math.floor(rng() * 6);
  for (let row = wantRow; ; row += 1) {
    const start = row === wantRow ? wantCol : 0;
    for (let col = start; col <= columns - w; col += 1) {
      if (free(col, row, w, h, occupied)) {
        for (let r = row; r < row + h; r += 1) {
          for (let c = col; c < col + w; c += 1) occupied.add(`${r}:${c}`);
        }
        return {col, row};
      }
    }
  }
}

function free(col: number, row: number, w: number, h: number, occupied: Set<string>): boolean {
  for (let r = row; r < row + h; r += 1) {
    for (let c = col; c < col + w; c += 1) if (occupied.has(`${r}:${c}`)) return false;
  }
  return true;
}

export const SEEDS: readonly number[] = Array.from({length: 120}, (_, i) => i * 2654435761 + 7);

/* ---- Nested trees -------------------------------------------------------
 *
 * The flat generator above is kept exactly as it was so the Wave 1 property
 * tests keep sweeping the same cases; nesting is an extension of it rather
 * than a second generator, and both share `place`, `offeredAt` and the same
 * PRNG. Element names are allocated from one counter for the whole tree, so
 * a reference is unique document-wide and the element-preservation property
 * can be asserted as a flat list of names gathered in traversal order.
 */

export type NestOptions = {
  /* Minimum depth of the deepest path, counting the root as depth 1. The
   * plan requires >= 2; the tests ask for 3 so a container nested inside a
   * container is routinely exercised and not merely possible. */
  minDepth?: number;
  maxDepth?: number;
  /* Probability that any given child is a layout kind this build does not
   * implement. Without one of these in the tree, the "unknown nested kind
   * does not stop its siblings reflowing" property would only ever be tested
   * by hand-written examples. */
  foreignChance?: number;
};

const DEFAULT_NEST: Required<NestOptions> = {minDepth: 3, maxDepth: 4, foreignChance: 0.2};

/* A kind no build understands, carrying a plausible payload including a
 * nested Grid. Reflow must leave every byte of this alone, including the
 * Grid inside it: an unknown container's internals are not ours to
 * interpret, and a Grid we can read is still one we were not invited to
 * touch. */
function foreignLayout(index: number, density: DensityLevel): Layout {
  return {
    kind: 'Carousel',
    intervalSeconds: 30,
    slides: [
      {title: `slide-${index}`, layout: {kind: 'Grid', authoredDensity: density, items: []}},
    ],
    somethingNewer: {deep: [1, 2, {three: true}]},
  };
}

type Nested = {layout: Layout; elements: {[name: string]: Block}};

export function generateNestedLayout(
  seed: number,
  authoredDensity: DensityLevel,
  registry: SizeRegistry,
  options: NestOptions = {},
): Nested {
  const settings = {...DEFAULT_NEST, ...options};
  const rng = makeRng(seed);
  const counter = {next: 0};
  const elements: {[name: string]: Block} = {};
  const layout = buildNode(rng, authoredDensity, registry, elements, counter, 1, settings, true);
  return {layout, elements};
}

export function generateNestedDocument(
  seed: number,
  authoredDensity: DensityLevel,
  registry: SizeRegistry,
  options: NestOptions = {},
): CanvasDocument {
  const {layout, elements} = generateNestedLayout(seed, authoredDensity, registry, options);
  return {
    apiVersion: API_VERSION,
    kind: KIND,
    metadata: {uid: `canvas-nested-${seed}`},
    spec: {elements, layout},
  };
}

function buildNode(
  rng: () => number,
  density: DensityLevel,
  registry: SizeRegistry,
  elements: {[name: string]: Block},
  counter: {next: number},
  depth: number,
  settings: Required<NestOptions>,
  /* The deepest path must actually reach minDepth, so one child per level is
   * forced to keep descending. Leaving it to chance would let a seed produce
   * a shallow tree and quietly stop testing nesting at all. */
  mustDescend: boolean,
): Layout {
  const canContain = depth < settings.maxDepth;
  const forced = mustDescend && depth < settings.minDepth;
  const wantsContainer = forced || (canContain && rng() < 0.5);

  if (wantsContainer) {
    const kind = rng() < 0.5 ? 'Rows' : 'Tabs';
    const count = 2 + Math.floor(rng() * 2);
    const descendAt = forced ? Math.floor(rng() * count) : -1;
    const children: LayoutChild[] = [];
    for (let index = 0; index < count; index += 1) {
      if (index !== descendAt && rng() < settings.foreignChance) {
        children.push({id: `${kind.toLowerCase()}-${depth}-${index}`, layout: foreignLayout(index, density)});
        continue;
      }
      children.push({
        id: `${kind.toLowerCase()}-${depth}-${index}`,
        layout: buildNode(
          rng,
          density,
          registry,
          elements,
          counter,
          depth + 1,
          settings,
          index === descendAt,
        ),
      });
    }
    return {kind, children} as Layout;
  }

  return rng() < 0.25
    ? buildAutoGrid(rng, density, registry, elements, counter)
    : buildGrid(rng, density, registry, elements, counter);
}

function buildGrid(
  rng: () => number,
  authoredDensity: DensityLevel,
  registry: SizeRegistry,
  elements: {[name: string]: Block},
  counter: {next: number},
): Layout {
  const columns = columnsFor(authoredDensity);
  const count = 1 + Math.floor(rng() * 4);
  const items: GridLayout['items'] = [];
  const occupied = new Set<string>();
  const candidates = offeredAt(registry, authoredDensity);
  for (let i = 0; i < count; i += 1) {
    const pick = candidates[Math.floor(rng() * candidates.length)]!;
    const cells = resolveCells(registry, pick.type, pick.size, authoredDensity);
    if (!cells.ok) continue;
    const name = elementName(counter.next);
    counter.next += 1;
    elements[name] = {type: pick.type, namedSize: pick.size};
    const spot = place(cells.value.w, cells.value.h, columns, occupied, rng);
    items.push({element: name, col: spot.col, row: spot.row});
  }
  return {kind: 'Grid', authoredDensity, items};
}

function buildAutoGrid(
  rng: () => number,
  authoredDensity: DensityLevel,
  registry: SizeRegistry,
  elements: {[name: string]: Block},
  counter: {next: number},
): Layout {
  const count = 1 + Math.floor(rng() * 4);
  const items: AutoGridItem[] = [];
  const candidates = offeredAt(registry, authoredDensity);
  for (let i = 0; i < count; i += 1) {
    const pick = candidates[Math.floor(rng() * candidates.length)]!;
    const name = elementName(counter.next);
    counter.next += 1;
    elements[name] = {type: pick.type, namedSize: pick.size};
    items.push({element: name});
  }
  const widths = AUTO_GRID_COLUMN_WIDTH_MODES;
  const heights = AUTO_GRID_ROW_HEIGHT_MODES;
  return {
    kind: 'AutoGrid',
    authoredDensity,
    maxColumnCount: 1 + Math.floor(rng() * columnsFor(authoredDensity)),
    columnWidthMode: widths[Math.floor(rng() * widths.length)]!,
    rowHeightMode: heights[Math.floor(rng() * heights.length)]!,
    items,
  };
}

/* Every element reference in the tree, in traversal order: children in
 * declared order, then a leaf's items in declared order. This is the list the
 * preservation and order-stability properties compare, and deliberately does
 * NOT descend into an unknown kind — its internals are opaque by definition,
 * so counting references inside one would be claiming to understand it. */
export function elementRefs(layout: Layout): string[] {
  const out: string[] = [];
  walkRefs(layout, out);
  return out;
}

function walkRefs(layout: Layout, out: string[]): void {
  if (isOrderedContainer(layout) && Array.isArray(layout.children)) {
    for (const child of layout.children) walkRefs(child.layout, out);
    return;
  }
  if (isGridLayout(layout) || isAutoGridLayout(layout)) {
    for (const item of layout.items) out.push(String(item.element));
  }
}

/* The id path of every ordered container entry, in order, e.g.
 * "rows-1-0/tabs-2-1". Order stability is asserted on this rather than on
 * array indices, so a reordering that happened to keep the array length would
 * still be caught. */
export function containerOrder(layout: Layout, prefix = ''): string[] {
  const out: string[] = [];
  if (isOrderedContainer(layout) && Array.isArray(layout.children)) {
    for (const child of layout.children) {
      const path = `${prefix}${layout.kind}:${child.id}`;
      out.push(path);
      out.push(...containerOrder(child.layout, `${path}/`));
    }
  }
  return out;
}

export function maxDepth(layout: Layout): number {
  if (isOrderedContainer(layout) && Array.isArray(layout.children)) {
    let deepest = 1;
    for (const child of layout.children) {
      deepest = Math.max(deepest, 1 + maxDepth(child.layout));
    }
    return deepest;
  }
  return 1;
}

export {DENSITY_LEVELS};
