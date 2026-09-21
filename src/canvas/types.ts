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
/* CommonHome Canvas — the canonical document model.
 *
 * This is the product model. spikes/model.ts is a disposable experiment with
 * different semantics and is not related to anything here.
 *
 * Two shapes govern everything below:
 *
 *   1. An apiVersion + kind envelope rather than an integer schema version.
 *      Grafana froze theirs at 42 with the comment "DO NOT increment this
 *      number", because a monotonic integer cannot be branched and they
 *      needed a second, parallel schema. An apiVersion string can branch.
 *
 *   2. Content separated from layout. `elements` holds what a block IS,
 *      keyed by a stable name; `layout` holds where it SITS and references
 *      elements by that name. Density reflow then rewrites layout alone and
 *      can never disturb block content, and a per-density override is simply
 *      an alternate layout over identical elements rather than a bolted-on
 *      position cache.
 *
 * Every record carries an index signature. Unknown fields written by a newer
 * editor must survive a load/save cycle by an older one; dropping them is how
 * hand-edited documents and shared templates become untrustworthy.
 */

import type {DensityLevel} from './density.ts';

export const API_VERSION = 'canvas.commonhome/v1alpha1';
export const KIND = 'Canvas';

export type Cells = {w: number; h: number};

/* A placeable element is a Block. "Widget" is reserved for third-party embed
 * code and must not leak into this vocabulary. */
export type Block = {
  type: string;
  namedSize: string;
  [key: string]: unknown;
};

export type GridItem = {
  element: string;
  col: number;
  row: number;
  [key: string]: unknown;
};

export type GridLayout = {
  kind: 'Grid';
  /* The non-negotiable field. KDE's Folder View stored (stripe, position)
   * indices with no record of the column count, and every resolution change
   * re-wrapped every icon; bug 354802 took from 2015 to 2022 to fix. A layout
   * without its frame of reference is uninterpretable, so a layout lacking
   * this is rejected rather than guessed at. */
  authoredDensity: DensityLevel;
  items: GridItem[];
  /* A projection remembers the canonical it was derived from. Scaling to a
   * coarser density is lossy — column 3 at Standard is 1.5 at Comfortable —
   * so reflowing a projection onward must re-derive from the canonical
   * rather than from the projection, or every visit to a coarser density
   * would degrade the layout a little further. This is Grafana's
   * `_skipOnLayoutChange` rule made structural: a derived view is never
   * treated as a source. The field is in-memory only; saveDocument strips it
   * so a projection can never be persisted over its own canonical. */
  derivedFrom?: GridLayout;
  [key: string]: unknown;
};

/* An entry in an ordered container. `id` exists so the eventual UI has a key
 * that survives reordering, and so order stability is assertable against
 * something other than array position. */
export type LayoutChild = {
  id: string;
  layout: Layout;
  [key: string]: unknown;
};

/* Rows and Tabs differ only in how they are presented; as records they are
 * the same thing — an ordered list of nested layouts. They therefore share
 * the `children` key rather than each naming its own (`rows`, `tabs`), so
 * traversal, validation and the ordering guarantee are implemented once
 * instead of once per container kind. The ordering guarantee is these kinds'
 * entire value: an ordered list has nothing to scramble, which is why
 * Plasma's panels, storing only AppletOrder, never suffered the reflow bugs
 * its coordinate-storing desktop did. */
export type RowsLayout = {
  kind: 'Rows';
  children: LayoutChild[];
  [key: string]: unknown;
};

export type TabsLayout = {
  kind: 'Tabs';
  children: LayoutChild[];
  [key: string]: unknown;
};

export type OrderedContainerLayout = RowsLayout | TabsLayout;

/* Named modes, not raw numbers. Grafana reached the same shape after a decade
 * of raw 24-column integers: a stored `columnWidth: 7` means only what its
 * reader assumes, whereas `wide` still means something in ten years and is
 * the same instruction at every density. */
export const AUTO_GRID_COLUMN_WIDTH_MODES = ['narrow', 'standard', 'wide'] as const;
export const AUTO_GRID_ROW_HEIGHT_MODES = ['short', 'standard', 'tall'] as const;

export type AutoGridColumnWidthMode = (typeof AUTO_GRID_COLUMN_WIDTH_MODES)[number];
export type AutoGridRowHeightMode = (typeof AUTO_GRID_ROW_HEIGHT_MODES)[number];

/* No col/row: an AutoGrid places its items itself, in order. The item is a
 * reference and whatever a newer build hung off it. */
export type AutoGridItem = {
  element: string;
  [key: string]: unknown;
};

export type AutoGridLayout = {
  kind: 'AutoGrid';
  /* Required for the same reason a Grid's is: `maxColumnCount: 6` is
   * uninterpretable without knowing which grid those columns are counted in,
   * and guessing is what cost Folder View seven years. */
  authoredDensity: DensityLevel;
  maxColumnCount?: number;
  columnWidthMode?: AutoGridColumnWidthMode;
  rowHeightMode?: AutoGridRowHeightMode;
  items: AutoGridItem[];
  derivedFrom?: AutoGridLayout;
  [key: string]: unknown;
};

/* A layout kind this build does not implement. Held as opaque JSON so a
 * document authored against a newer build round-trips unchanged. */
export type ForeignLayout = {
  kind: string;
  [key: string]: unknown;
};

export type Layout =
  | GridLayout
  | AutoGridLayout
  | RowsLayout
  | TabsLayout
  | ForeignLayout;

export type CanvasMetadata = {
  /* Portable across households. Any instance-local numeric key lives
   * elsewhere and never leaves the instance. */
  uid: string;
  [key: string]: unknown;
};

/* Overrides are one household's fiddling on one screen at one density. They
 * live inside the document so the export path can strip them reliably — a
 * side store cannot be stripped by a document-shaped operation — but in a
 * section delimited clearly enough that Share is an allowlist ("emit spec")
 * rather than a growing list of fields to remember to remove. */
export type CanvasLocal = {
  densityOverrides?: {[level: string]: Layout};
  [key: string]: unknown;
};

export type CanvasDocument = {
  apiVersion: string;
  kind: string;
  metadata: CanvasMetadata;
  spec: {
    elements: {[name: string]: Block};
    layout: Layout;
    [key: string]: unknown;
  };
  local?: CanvasLocal;
  [key: string]: unknown;
};

export type CanvasError = {
  code: string;
  message: string;
  path?: string;
};

export type Result<T> = {ok: true; value: T} | {ok: false; error: CanvasError};

export function ok<T>(value: T): Result<T> {
  return {ok: true, value};
}

export function err<T>(code: string, message: string, path?: string): Result<T> {
  return {ok: false, error: path === undefined ? {code, message} : {code, message, path}};
}

export function isGridLayout(layout: Layout): layout is GridLayout {
  return layout.kind === 'Grid';
}

export function isAutoGridLayout(layout: Layout): layout is AutoGridLayout {
  return layout.kind === 'AutoGrid';
}

export function isRowsLayout(layout: Layout): layout is RowsLayout {
  return layout.kind === 'Rows';
}

export function isTabsLayout(layout: Layout): layout is TabsLayout {
  return layout.kind === 'Tabs';
}

export function isOrderedContainer(layout: Layout): layout is OrderedContainerLayout {
  return layout.kind === 'Rows' || layout.kind === 'Tabs';
}

/* The guards above test the tag only, matching `isGridLayout`. Whether a
 * container's payload is one this build can walk is a separate question,
 * because a container tagged `Rows` whose children this build cannot
 * recognise must be carried opaquely rather than rejected or emptied. */
export function hasWalkableChildren(
  layout: Layout,
): layout is OrderedContainerLayout {
  return isOrderedContainer(layout) && Array.isArray((layout as OrderedContainerLayout).children);
}

export function isAutoGridColumnWidthMode(value: unknown): value is AutoGridColumnWidthMode {
  return typeof value === 'string' && (AUTO_GRID_COLUMN_WIDTH_MODES as readonly string[]).includes(value);
}

export function isAutoGridRowHeightMode(value: unknown): value is AutoGridRowHeightMode {
  return typeof value === 'string' && (AUTO_GRID_ROW_HEIGHT_MODES as readonly string[]).includes(value);
}
