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
/* The footprints the five built-in Blocks declare, per density.
 *
 * Declared, never computed. `src/canvas/sizes.ts` explains why at length: an
 * explicit number per level cannot drift when someone changes a font, and it
 * answers the halving problem by construction - a block that is 8 wide at
 * Standard(12) states that it is 4 wide at Comfortable(6) rather than inviting
 * anyone to invent a fraction.
 *
 * A size may DECLINE a density by omitting it. A day-column calendar has no
 * legible form in six columns, so it is simply not offered there, and the
 * picker will not list it. The renderer's fallback (see footprintFor) then
 * lands on the nearest declared size rather than refusing to draw.
 *
 * The names are shared across types on purpose - small / wide / full mean the
 * same relative thing everywhere, so "same canvas, different blocks" stays
 * legible to whoever is authoring it.
 */

import {columnsFor, DENSITY_LEVELS, type DensityLevel} from '../canvas/density.ts';
import {
  buildRegistry,
  nearestDeclaredSize,
  resolveCells,
  type BlockTypeSpec,
  type SizeRegistry,
} from '../canvas/sizes.ts';
import type {Cells} from '../canvas/types.ts';

export const BLOCK_TYPES = ['clock', 'calendar', 'photo', 'weather', 'text'] as const;

export type BuiltInBlockType = (typeof BLOCK_TYPES)[number];

export function isBuiltInBlockType(value: unknown): value is BuiltInBlockType {
  return typeof value === 'string' && (BLOCK_TYPES as readonly string[]).includes(value);
}

export const BLOCK_TYPE_SPECS: readonly BlockTypeSpec[] = [
  {
    type: 'clock',
    sizes: [
      {name: 'small', cells: {comfortable: {w: 2, h: 1}, standard: {w: 3, h: 2}, dense: {w: 6, h: 3}}},
      {name: 'wide', cells: {comfortable: {w: 3, h: 2}, standard: {w: 6, h: 3}, dense: {w: 12, h: 5}}},
      {name: 'full', cells: {comfortable: {w: 6, h: 2}, standard: {w: 12, h: 3}, dense: {w: 24, h: 5}}},
    ],
  },
  {
    type: 'calendar',
    sizes: [
      /* up-next: the smallest amount of calendar that is still useful. */
      {name: 'small', cells: {comfortable: {w: 2, h: 2}, standard: {w: 3, h: 3}, dense: {w: 6, h: 5}}},
      /* agenda: the default, and the right one for a wall. */
      {name: 'wide', cells: {comfortable: {w: 4, h: 3}, standard: {w: 8, h: 5}, dense: {w: 16, h: 9}}},
      /* day columns. Declines Comfortable(6): four columns of events inside
       * six grid columns is unreadable at three metres. */
      {name: 'full', cells: {standard: {w: 12, h: 6}, dense: {w: 24, h: 11}}},
    ],
  },
  {
    type: 'photo',
    sizes: [
      {name: 'small', cells: {comfortable: {w: 2, h: 2}, standard: {w: 4, h: 3}, dense: {w: 8, h: 6}}},
      {name: 'wide', cells: {comfortable: {w: 4, h: 3}, standard: {w: 8, h: 5}, dense: {w: 16, h: 9}}},
      /* The ambient case: the photograph IS the screen. */
      {name: 'full', cells: {comfortable: {w: 6, h: 4}, standard: {w: 12, h: 7}, dense: {w: 24, h: 13}}},
    ],
  },
  {
    type: 'weather',
    sizes: [
      {name: 'small', cells: {comfortable: {w: 2, h: 1}, standard: {w: 3, h: 2}, dense: {w: 6, h: 4}}},
      {name: 'wide', cells: {comfortable: {w: 4, h: 2}, standard: {w: 6, h: 3}, dense: {w: 12, h: 5}}},
    ],
  },
  {
    type: 'text',
    sizes: [
      {name: 'small', cells: {comfortable: {w: 2, h: 1}, standard: {w: 3, h: 2}, dense: {w: 6, h: 4}}},
      {name: 'wide', cells: {comfortable: {w: 4, h: 2}, standard: {w: 6, h: 3}, dense: {w: 12, h: 5}}},
      {name: 'full', cells: {comfortable: {w: 6, h: 3}, standard: {w: 12, h: 4}, dense: {w: 24, h: 7}}},
    ],
  },
];

/* Built once at module load and frozen in practice: the registry is a constant
 * of this build, and validating it here means a bad footprint is a startup
 * error in a test rather than a wall display with a block hanging out of the
 * grid. */
const built = buildRegistry([...BLOCK_TYPE_SPECS]);
if (!built.ok) {
  throw new Error(`the built-in block registry is invalid: ${built.error.code} ${built.error.message}`);
}

export const BLOCK_REGISTRY: SizeRegistry = built.value;

/** How a footprint was arrived at. Emitted as a data attribute so a test can
 * tell a declared size from a rescue, and so an author can see that a size
 * they picked is not offered at the density they are looking at. */
export type FootprintOrigin = 'declared' | 'snapped' | 'fallback';

export type Footprint = {
  readonly cells: Cells;
  readonly origin: FootprintOrigin;
  /** The size actually used, which is not always the one asked for. */
  readonly name: string;
};

/* A block whose footprint cannot be resolved must still RENDER. This is the
 * whole per-block degradation rule applied to geometry: an unknown type, or a
 * size this build does not offer at this density, is a small block with a
 * label - never a missing block and never a blank page.
 *
 * Order of rescue:
 *   1. the declared cells for (type, size, density);
 *   2. the nearest size the type does declare at that density;
 *   3. a two-cell-wide default, clamped to the grid.
 */
export function footprintFor(
  type: unknown,
  namedSize: unknown,
  density: DensityLevel,
  registry: SizeRegistry = BLOCK_REGISTRY,
): Footprint {
  const typeName = typeof type === 'string' ? type : '';
  const sizeName = typeof namedSize === 'string' ? namedSize : '';

  const exact = resolveCells(registry, typeName, sizeName, density);
  if (exact.ok) return {cells: exact.value, origin: 'declared', name: sizeName};

  const near = nearestDeclaredSize(registry, typeName, density, {w: 2, h: 2});
  if (near.ok) return {cells: near.value.cells, origin: 'snapped', name: near.value.name};

  const columns = columnsFor(density);
  return {cells: {w: Math.min(2, columns), h: 2}, origin: 'fallback', name: sizeName};
}

/** Every density at which this type offers anything. Used by the footprint
 * tests to prove the five blocks are placeable everywhere they claim. */
export function densitiesOffering(type: string, registry: SizeRegistry = BLOCK_REGISTRY): DensityLevel[] {
  const spec = registry[type];
  if (spec === undefined) return [];
  return DENSITY_LEVELS.filter((level) => spec.sizes.some((size) => size.cells[level] !== undefined));
}
