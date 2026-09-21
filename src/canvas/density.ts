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
/* CommonHome Canvas — density levels.
 *
 * Density is a bounded named set, never a free integer column count. Named
 * levels are what let a block declare "I am legible at Standard" without the
 * author reasoning about cell counts, and what keeps the stored layout
 * interpretable: `authoredDensity: "standard"` means something in ten years,
 * `columns: 12` means only what the reader assumes.
 *
 * The counts double deliberately. Exact integer scaling between adjacent
 * levels is the whole reason round-trip identity is achievable rather than
 * approximate (notes/density-reflow-kde-lessons.md).
 */

export const DENSITY = {comfortable: 6, standard: 12, dense: 24} as const;

export type DensityLevel = keyof typeof DENSITY;

/* Ordered coarse-to-fine. Order is part of the API: a "nearest known density"
 * search needs a defined neighbour relation. */
export const DENSITY_LEVELS: readonly DensityLevel[] = [
  'comfortable',
  'standard',
  'dense',
];

export function isDensityLevel(value: unknown): value is DensityLevel {
  return typeof value === 'string' && Object.hasOwn(DENSITY, value);
}

export function columnsFor(level: DensityLevel): number {
  return DENSITY[level];
}

/* Always a power of two in either direction, given the doubling counts. */
export function scaleFactor(from: DensityLevel, to: DensityLevel): number {
  return DENSITY[to] / DENSITY[from];
}
