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
/* CommonHome Canvas — named block sizes.
 *
 * A block type declares a bounded set of named sizes; a block instance names
 * one of them. There is no free resize anywhere in this API, and an
 * undeclared size is rejected with a structured error rather than quietly
 * corrected — a silent correction is indistinguishable, from the author's
 * seat, from the editor losing their work.
 *
 * The declared set is queryable because the resize affordance is a picker
 * over exactly that set. That is what moves "is this legible at this size?"
 * from the author to the block author, where it can actually be answered.
 *
 * Footprints are stated explicitly per density rather than derived by
 * doubling. Plasma derived its base grid unit from font metrics, found it
 * unstable, and ended up hardcoding it while the documentation still claimed
 * otherwise. An explicit number per level cannot drift when someone changes a
 * font, and it answers the halving problem by construction: a size that is
 * 3 cells wide at Standard states what it is at Comfortable instead of
 * inviting anyone to invent 1.5.
 */

import {DENSITY_LEVELS, columnsFor, type DensityLevel} from './density.ts';
import {err, ok, type Cells, type Result} from './types.ts';

export type NamedSize = {
  name: string;
  /* A density may be omitted, which means the type declines to be offered at
   * that density — a full forecast has no legible form at Comfortable(6).
   * Declining to offer is simpler than refusing a placement and sufficient:
   * the picker simply does not list it. */
  cells: {[level: string]: Cells};
};

export type BlockTypeSpec = {
  type: string;
  sizes: NamedSize[];
};

export type SizeRegistry = {[type: string]: BlockTypeSpec};

export function buildRegistry(specs: BlockTypeSpec[]): Result<SizeRegistry> {
  const registry: SizeRegistry = {};
  for (const spec of specs) {
    const check = validateBlockType(spec);
    if (!check.ok) return check as Result<SizeRegistry>;
    if (Object.hasOwn(registry, spec.type)) {
      return err('duplicate_block_type', `block type ${spec.type} declared twice`, spec.type);
    }
    registry[spec.type] = spec;
  }
  return ok(registry);
}

export function validateBlockType(spec: BlockTypeSpec): Result<BlockTypeSpec> {
  if (typeof spec.type !== 'string' || spec.type === '') {
    return err('invalid_block_type', 'block type needs a non-empty type name');
  }
  if (!Array.isArray(spec.sizes) || spec.sizes.length === 0) {
    return err('no_declared_sizes', `block type ${spec.type} declares no sizes`, spec.type);
  }
  const seen = new Set<string>();
  for (const size of spec.sizes) {
    if (typeof size.name !== 'string' || size.name === '') {
      return err('invalid_size_name', `block type ${spec.type} has a size with no name`, spec.type);
    }
    if (seen.has(size.name)) {
      return err(
        'duplicate_size_name',
        `block type ${spec.type} declares size ${size.name} twice`,
        `${spec.type}.${size.name}`,
      );
    }
    seen.add(size.name);
    let offered = 0;
    for (const level of DENSITY_LEVELS) {
      const cells = size.cells[level];
      if (cells === undefined) continue;
      offered += 1;
      const path = `${spec.type}.${size.name}.${level}`;
      if (!isPositiveInt(cells.w) || !isPositiveInt(cells.h)) {
        return err('invalid_size_cells', `${path} must be positive whole cells`, path);
      }
      /* A footprint wider than its own grid can never be placed in bounds, so
       * it is a declaration error rather than a placement error. */
      if (cells.w > columnsFor(level)) {
        return err(
          'size_exceeds_density',
          `${path} is ${cells.w} wide but ${level} has ${columnsFor(level)} columns`,
          path,
        );
      }
    }
    if (offered === 0) {
      return err(
        'size_offered_nowhere',
        `${spec.type}.${size.name} declares no density`,
        `${spec.type}.${size.name}`,
      );
    }
  }
  return ok(spec);
}

/* The picker's contents: the sizes this type offers, at this density. */
export function declaredSizes(
  registry: SizeRegistry,
  type: string,
  density?: DensityLevel,
): string[] {
  const spec = registry[type];
  if (spec === undefined) return [];
  return spec.sizes
    .filter((size) => density === undefined || size.cells[density] !== undefined)
    .map((size) => size.name);
}

export function isDeclaredSize(registry: SizeRegistry, type: string, name: string): boolean {
  const spec = registry[type];
  return spec !== undefined && spec.sizes.some((size) => size.name === name);
}

export function resolveCells(
  registry: SizeRegistry,
  type: string,
  name: string,
  density: DensityLevel,
): Result<Cells> {
  const spec = registry[type];
  if (spec === undefined) {
    return err('unknown_block_type', `no block type ${type} in this build`, type);
  }
  const size = spec.sizes.find((candidate) => candidate.name === name);
  if (size === undefined) {
    return err(
      'undeclared_size',
      `block type ${type} does not declare size ${name}; it declares ${declaredSizes(registry, type).join(', ')}`,
      `${type}.${name}`,
    );
  }
  const cells = size.cells[density];
  if (cells === undefined) {
    return err(
      'size_not_offered_at_density',
      `block type ${type} does not offer size ${name} at ${density}`,
      `${type}.${name}.${density}`,
    );
  }
  return ok({w: cells.w, h: cells.h});
}

/* Used when a caller holds a footprint that has been scaled arithmetically
 * and landed between declared sizes — halving a 3-wide block gives 1.5.
 * Rather than inventing a fractional size, land on a declared one.
 *
 * Distance is width first, then height, because the column count is the
 * bounded axis and a wrong width is what pushes neighbours out of the grid.
 * Ties break toward the SMALLER size: a block that shrinks can only free
 * space, whereas one that grows can displace a neighbour, and a stable rule
 * matters more here than an optimal one. Remaining ties break on declaration
 * order, which is stable across runs because it comes from the type's own
 * declaration rather than from iteration of a hash.
 */
export function nearestDeclaredSize(
  registry: SizeRegistry,
  type: string,
  density: DensityLevel,
  desired: Cells,
): Result<{name: string; cells: Cells}> {
  const spec = registry[type];
  if (spec === undefined) {
    return err('unknown_block_type', `no block type ${type} in this build`, type);
  }
  let best: {name: string; cells: Cells} | null = null;
  let bestScore: [number, number, number] | null = null;
  for (const size of spec.sizes) {
    const cells = size.cells[density];
    if (cells === undefined) continue;
    const score: [number, number, number] = [
      Math.abs(cells.w - desired.w),
      Math.abs(cells.h - desired.h),
      cells.w * cells.h,
    ];
    if (bestScore === null || lessThan(score, bestScore)) {
      best = {name: size.name, cells: {w: cells.w, h: cells.h}};
      bestScore = score;
    }
  }
  if (best === null) {
    return err(
      'no_size_at_density',
      `block type ${type} offers no size at ${density}`,
      `${type}.${density}`,
    );
  }
  return ok(best);
}

function lessThan(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
