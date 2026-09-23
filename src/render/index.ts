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
/* THE renderer. One function, three surfaces.
 *
 * `/d/` (a paired wall display), `/s/` (a share link) and `/c/` (the owner's
 * preview) all call `renderCanvasFragment` and receive the SAME BYTES for the
 * same document and the same data. That is asserted structurally in the tests by
 * comparing the three fragments, not claimed in a comment - three renderers that
 * agree today drift by next month, and a block that looks right on the TV and
 * wrong on a phone is the bug a shared renderer makes impossible to introduce
 * accidentally.
 *
 * WHAT DIFFERS BETWEEN THE SURFACES IS THE DATA, NOT THE RENDERER. A shared
 * canvas is handed calendar events that were SHAPED at the shared level, so the
 * private fields are not in the renderer's input at all. The renderer then
 * strips them again on the way out (see blocks.ts, rule 3), because this is the
 * layer at which bytes become visible to a visitor.
 *
 * THIS MODULE FETCHES NOTHING AND IS PURE. Given a document, a `now` and a bag
 * of feeds it returns a string. That is what makes it testable without a
 * network, safe to call on a request path, and identical across surfaces.
 *
 * PLACEMENT IS NOT REIMPLEMENTED HERE. `src/canvas/reflow.ts` is the one
 * placement algorithm; this module calls it and consumes its output. Footprints
 * come from the declared named sizes in `src/render/registry.ts`, so a block
 * occupies exactly the cells its type declared for the density being rendered.
 */

import {DENSITY_LEVELS, isDensityLevel, columnsFor, type DensityLevel} from '../canvas/density.ts';
import type {ShareLevel} from '../calendar/shape.ts';
import {tryReflow} from '../canvas/reflow.ts';
import type {
  AutoGridLayout,
  Block,
  CanvasDocument,
  GridLayout,
  Layout,
  LayoutChild,
} from '../canvas/types.ts';
import {
  hasWalkableChildren,
  isAutoGridLayout,
  isGridLayout,
  isTabsLayout,
} from '../canvas/types.ts';
import {renderBlockBody, type BlockContext} from './blocks.ts';
import type {RenderData} from './data.ts';
import {escapeHtml} from './escape.ts';
import {BLOCK_REGISTRY, footprintFor} from './registry.ts';
import {CANVAS_STYLESHEET_PATH} from './style.ts';

export type RenderOptions = {
  /** One instant for the whole page: two clocks on one canvas must agree. */
  readonly now?: Date;
  readonly timeZone?: string;
  readonly locale?: string;
  /** Which density to render at. Defaults to the layout's authored density,
   * which is the only density a document states an opinion about. */
  readonly density?: DensityLevel;
  readonly data?: RenderData;
  /** What THIS SURFACE is entitled to publish. `/s/` passes 'shared'; `/d/` and
   * `/c/` pass 'private'. Never read from the document or the request: a viewer
   * arriving over a share link must not be able to ask for the private shaping.
   * Defaults to 'shared', the safe direction to be wrong in. */
  readonly shareLevel?: ShareLevel;
  /** Rendered as a quiet heading. Off for surfaces that supply their own. */
  readonly showName?: boolean;
};

export const DEFAULT_TIME_ZONE = 'UTC';
export const DEFAULT_LOCALE = 'en-GB';

type Resolved = {
  readonly ctx: BlockContext;
  readonly density: DensityLevel;
  readonly elements: {[name: string]: Block};
  readonly placed: Set<string>;
};

function authoredDensityOf(layout: Layout): DensityLevel {
  const declared = (layout as {authoredDensity?: unknown}).authoredDensity;
  if (isDensityLevel(declared)) return declared;
  /* A Rows or Tabs container has no density of its own - its children do - so
   * the first child that states one decides. A layout with none anywhere is
   * rendered at Standard, which is the middle of the three and the only choice
   * that cannot be more wrong than the alternatives. */
  if (hasWalkableChildren(layout)) {
    for (const child of layout.children) {
      if (child !== null && typeof child === 'object' && typeof child.layout === 'object') {
        const inner = authoredDensityOf(child.layout as Layout);
        if (inner !== 'standard') return inner;
      }
    }
  }
  return 'standard';
}

function toInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/* ------------------------------------------------------------------ block -- */

/* The wrapper every block shares, carrying its identity, its resolved state and
 * its footprint. The data attributes are the renderer's testable surface: a
 * footprint assertion reads `data-cells`, a degradation assertion reads
 * `data-state`, and neither has to parse CSS to find out what happened. */
function renderBlock(
  name: string,
  block: Block | undefined,
  resolved: Resolved,
  placement: string,
): string {
  if (block === undefined) {
    /* A layout referencing an element that is not in the table. Not an error
     * and not a gap: a labelled placeholder holding the space, so an author can
     * see that the reference is dangling. */
    return `<div class="ch-block" data-block="${escapeHtml(name)}" data-type="" `
      + `data-state="unknown"${placement}>`
      + '<p class="ch-block-label">Missing block</p>'
      + `<p class="ch-unknown-type">${escapeHtml(name)}</p></div>`;
  }
  resolved.placed.add(name);
  const type = typeof block.type === 'string' ? block.type : '';
  const namedSize = typeof block.namedSize === 'string' ? block.namedSize : '';
  const footprint = footprintFor(type, namedSize, resolved.density, BLOCK_REGISTRY);
  const body = renderBlockBody(block, resolved.ctx);
  const typeClass = type === '' ? '' : ` ch-${escapeHtml(type)}`;
  return [
    `<div class="ch-block${typeClass}"`,
    ` data-block="${escapeHtml(name)}"`,
    ` data-type="${escapeHtml(type)}"`,
    ` data-size="${escapeHtml(namedSize)}"`,
    ` data-state="${body.state}"`,
    ` data-footprint="${footprint.origin}"`,
    ` data-cells="${footprint.cells.w}x${footprint.cells.h}"`,
    placement,
    '>\n',
    body.html,
    '\n</div>',
  ].join('');
}

/* ----------------------------------------------------------------- layouts -- */

function renderGrid(layout: GridLayout, resolved: Resolved): string {
  const columns = columnsFor(resolved.density);
  const items = Array.isArray(layout.items) ? layout.items : [];
  const cells = items.map((item) => {
    const name = typeof item.element === 'string' ? item.element : '';
    const block = resolved.elements[name];
    const footprint = footprintFor(block?.type, block?.namedSize, resolved.density, BLOCK_REGISTRY);
    /* The width is clamped to the grid a second time here even though the
     * declared sizes are validated against the column count: a document may
     * name a size from a newer build, and a block hanging out of the grid is a
     * horizontal scrollbar on a television. */
    const w = Math.min(Math.max(1, footprint.cells.w), columns);
    const col = Math.min(toInt(item.col), Math.max(0, columns - w));
    const row = toInt(item.row);
    const placement = ` style="grid-column:${col + 1} / span ${w};`
      + `grid-row:${row + 1} / span ${Math.max(1, footprint.cells.h)}"`;
    return renderBlock(name, block, resolved, placement);
  });
  return [
    `<div class="ch-grid" data-density="${resolved.density}" data-columns="${columns}">`,
    ...cells,
    '</div>',
  ].join('\n');
}

function renderAutoGrid(layout: AutoGridLayout, resolved: Resolved): string {
  const items = Array.isArray(layout.items) ? layout.items : [];
  const widthMode = typeof layout.columnWidthMode === 'string' ? layout.columnWidthMode : 'standard';
  const heightMode = typeof layout.rowHeightMode === 'string' ? layout.rowHeightMode : 'standard';
  const maxColumns = toInt(layout.maxColumnCount);
  /* maxColumnCount is expressed as a cap on the auto-fill, not as a fixed
   * template: "at most 3 across" must still collapse to one on a phone. */
  const cap = maxColumns > 0
    ? ` style="max-width:calc(${maxColumns} * 22rem)"`
    : '';
  return [
    `<div class="ch-autogrid" data-density="${resolved.density}"`
      + ` data-width-mode="${escapeHtml(widthMode)}"`
      + ` data-height-mode="${escapeHtml(heightMode)}"`
      + `${maxColumns > 0 ? ` data-max-columns="${maxColumns}"` : ''}${cap}>`,
    ...items.map((item) => {
      const name = typeof item.element === 'string' ? item.element : '';
      return renderBlock(name, resolved.elements[name], resolved, '');
    }),
    '</div>',
  ].join('\n');
}

function childLabel(child: LayoutChild, index: number): string {
  const title = typeof (child as {title?: unknown}).title === 'string'
    ? (child as {title: string}).title
    : typeof (child as {label?: unknown}).label === 'string'
      ? (child as {label: string}).label
      : '';
  return title === '' ? `Section ${index + 1}` : title;
}

/* Rows and Tabs are the same record - an ordered list of nested layouts - and
 * differ only in presentation, so they share this walker. The ordering
 * guarantee is these kinds' entire value, so the children are emitted by index
 * and never sorted. */
function renderContainer(layout: Layout, resolved: Resolved): string {
  const tabs = isTabsLayout(layout);
  const children = hasWalkableChildren(layout) ? layout.children : [];
  return [
    `<div class="${tabs ? 'ch-tabs' : 'ch-rows'}" data-kind="${escapeHtml(String(layout.kind))}">`,
    ...children.map((child, index) => {
      const inner = child !== null && typeof child === 'object'
        ? renderLayout(child.layout as Layout, resolved)
        : '';
      const id = typeof child?.id === 'string' ? child.id : String(index);
      return [
        `<section class="${tabs ? 'ch-tab' : 'ch-row'}" data-child="${escapeHtml(id)}">`,
        /* A Tabs child is labelled because stacking it without its name loses
         * the only information the Tabs kind carried. A Rows child is not: rows
         * are positional and a heading per row is noise on a wall. */
        tabs ? `<p class="ch-tab-label">${escapeHtml(childLabel(child, index))}</p>` : '',
        inner,
        '</section>',
      ].filter((part) => part !== '').join('\n');
    }),
    '</div>',
  ].join('\n');
}

/* A layout kind this build does not implement. The document model carries it
 * opaquely through a save; here it becomes a labelled region holding the blocks
 * it referenced, if it referenced any recognisably. A wall display must not go
 * blank because a newer editor introduced a container. */
function renderForeignLayout(layout: Layout, resolved: Resolved): string {
  const items = Array.isArray((layout as {items?: unknown}).items)
    ? ((layout as {items: unknown[]}).items)
    : [];
  const named = items
    .filter((item): item is {element: string} =>
      item !== null && typeof item === 'object' && typeof (item as {element?: unknown}).element === 'string')
    .map((item) => item.element);
  return [
    `<div class="ch-autogrid ch-foreign-layout" data-kind="${escapeHtml(String(layout.kind))}"`
      + ' data-width-mode="standard" data-height-mode="standard">',
    ...named.map((name) => renderBlock(name, resolved.elements[name], resolved, '')),
    '</div>',
  ].join('\n');
}

function renderLayout(layout: Layout, resolved: Resolved): string {
  if (layout === null || typeof layout !== 'object') return '';
  if (isGridLayout(layout)) return renderGrid(layout, resolved);
  if (isAutoGridLayout(layout)) return renderAutoGrid(layout, resolved);
  if (hasWalkableChildren(layout)) return renderContainer(layout, resolved);
  return renderForeignLayout(layout, resolved);
}

/* ---------------------------------------------------------------- fragment -- */

/** The canvas content and nothing else: no id, no token, no link, no control.
 * This is the string all three surfaces embed, and the string `/d/<token>/view`
 * hands back for a revision swap. */
export function renderCanvasFragment(
  doc: CanvasDocument,
  options: RenderOptions = {},
): string {
  const layout = (doc.spec?.layout ?? {kind: 'Grid', authoredDensity: 'standard', items: []}) as Layout;
  const elements = (doc.spec?.elements ?? {}) as {[name: string]: Block};
  const density = options.density !== undefined && isDensityLevel(options.density)
    ? options.density
    : authoredDensityOf(layout);

  const resolved: Resolved = {
    ctx: {
      now: options.now ?? new Date(),
      timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
      locale: options.locale ?? DEFAULT_LOCALE,
      shareLevel: options.shareLevel ?? 'shared',
      data: options.data ?? {},
    },
    density,
    elements,
    placed: new Set<string>(),
  };

  /* Placement comes from the one pure reflow, never from arithmetic here. A
   * layout that cannot be interpreted at all (a Grid with no authoredDensity,
   * which validation should already have refused) renders from the layout as
   * authored rather than not at all - per-block degradation applied to the
   * layout itself. */
  const reflowed = tryReflow(layout, density, {elements, registry: BLOCK_REGISTRY});
  const effective = reflowed.ok ? reflowed.value : layout;

  const name = typeof doc.metadata?.name === 'string' ? doc.metadata.name : '';
  const head = options.showName === false || name === ''
    ? ''
    : `<p class="ch-canvas-name">${escapeHtml(name)}</p>`;

  const body = renderLayout(effective, resolved);

  /* Any element the layout never referenced is still rendered, after the
   * layout, rather than silently dropped. A block that exists in a document but
   * appears nowhere on the screen is indistinguishable from data loss, and this
   * is the case a hand-edited or newer-build document actually produces. */
  const orphans = Object.keys(elements).filter((key) => !resolved.placed.has(key));
  const unplaced = orphans.length === 0 ? '' : [
    '<div class="ch-autogrid ch-unplaced" data-width-mode="standard" data-height-mode="standard">',
    ...orphans.map((key) => renderBlock(key, elements[key], resolved, '')),
    '</div>',
  ].join('\n');

  return [
    `<div class="ch-canvas" data-density="${density}" data-layout="${escapeHtml(String(effective.kind))}">`,
    head,
    '<div class="ch-region">',
    body,
    unplaced,
    '</div>',
    '</div>',
  ].filter((part) => part !== '').join('\n');
}

/* -------------------------------------------------------------------- page -- */

export type PageOptions = RenderOptions & {
  /** Placed inside <title>. Never the canvas name by default: a browser tab
   * title ends up in screenshots and in browsing history. */
  readonly title?: string;
  /** Extra markup after the canvas - a staleness note, a share footer. The
   * CALLER owns this, and it is the only thing a surface may add, which is what
   * keeps the canvas fragment itself identical everywhere. */
  readonly extraBody?: string;
  /** Attributes for the element wrapping the fragment, e.g. the kiosk's
   * `id="screen-view" data-revision="..."`. */
  readonly mainAttributes?: string;
  /** A module script URL. Must be same-origin: the CSP says script-src 'self'. */
  readonly scriptPath?: string;
};

/** The shell. Every byte is a constant except the fragment and what the caller
 * passed, and there is deliberately nothing in it that could be mistaken for a
 * control: no form, no input, no button, no textarea, no contenteditable, no
 * drag handle. */
export function renderCanvasHtmlPage(doc: CanvasDocument, options: PageOptions = {}): string {
  const title = options.title ?? 'CommonHome Canvas';
  const main = options.mainAttributes === undefined ? '' : ` ${options.mainAttributes}`;
  const script = options.scriptPath === undefined
    ? ''
    : `<script type="module" src="${escapeHtml(options.scriptPath)}"></script>`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${CANVAS_STYLESHEET_PATH}">
<main${main}>
${renderCanvasFragment(doc, options)}
</main>
${options.extraBody ?? ''}
${script}
</html>
`;
}

export {BLOCK_REGISTRY, BLOCK_TYPES, BLOCK_TYPE_SPECS, footprintFor, isBuiltInBlockType} from './registry.ts';
export {CANVAS_STYLESHEET, CANVAS_STYLESHEET_PATH} from './style.ts';
export {escapeHtml, safeImageUrl, safeLinkUrl} from './escape.ts';
export {
  attributionFrom,
  conditionText,
  creditText,
  degraded,
  ready,
  shortenAttribution,
  type Attribution,
  type CalendarFeed,
  type Feed,
  type PhotoImage,
  type RenderData,
  type WeatherReading,
} from './data.ts';
export {DENSITY_LEVELS};
