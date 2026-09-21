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
/* CommonHome Canvas — the canvas model's public surface.
 *
 * Everything a caller outside this directory should need. Importing the
 * individual modules works too; this exists so the seam between the model and
 * its eventual UI is one import rather than five.
 */

export {
  DENSITY,
  DENSITY_LEVELS,
  columnsFor,
  isDensityLevel,
  scaleFactor,
  type DensityLevel,
} from './density.ts';

export {
  buildRegistry,
  declaredSizes,
  isDeclaredSize,
  nearestDeclaredSize,
  resolveCells,
  validateBlockType,
  type BlockTypeSpec,
  type NamedSize,
  type SizeRegistry,
} from './sizes.ts';

export {
  UninterpretableLayout,
  reflow,
  tryReflow,
  type ReflowContext,
} from './reflow.ts';

export {
  contextFor,
  layoutFor,
  loadDocument,
  saveDocument,
  toShareable,
  validateDocument,
  validateLayout,
  withOverride,
  withoutOverride,
} from './document.ts';

export {
  API_VERSION,
  AUTO_GRID_COLUMN_WIDTH_MODES,
  AUTO_GRID_ROW_HEIGHT_MODES,
  KIND,
  err,
  hasWalkableChildren,
  isAutoGridColumnWidthMode,
  isAutoGridLayout,
  isAutoGridRowHeightMode,
  isGridLayout,
  isOrderedContainer,
  isRowsLayout,
  isTabsLayout,
  ok,
  type AutoGridColumnWidthMode,
  type AutoGridItem,
  type AutoGridLayout,
  type AutoGridRowHeightMode,
  type Block,
  type CanvasDocument,
  type CanvasError,
  type CanvasLocal,
  type CanvasMetadata,
  type Cells,
  type ForeignLayout,
  type GridItem,
  type GridLayout,
  type Layout,
  type LayoutChild,
  type OrderedContainerLayout,
  type Result,
  type RowsLayout,
  type TabsLayout,
} from './types.ts';
