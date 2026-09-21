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
/* CommonHome Canvas — load, save, and the canonical/override split.
 *
 * Two rules govern this file.
 *
 * Nothing is dropped. A document written by a newer build — an unknown block
 * type, an unknown field on a known block, an unknown layout kind — must come
 * back out of `saveDocument` exactly as it went in. Grafana does this with
 * `getPanelPluginNotFound()`, which keeps the unknown panel's position, id,
 * title and untouched JSON so the dashboard round-trips. Dropping unknown
 * content is how a shared template becomes untrustworthy, and it is the one
 * decision that determines whether old documents survive new versions.
 * Validation therefore refuses only what is *uninterpretable*, never what is
 * merely unrecognised.
 *
 * Canonical is authoritative. `spec.layout` is the author's intent; every
 * other density is a pure projection of it. `local.densityOverrides` records
 * the household's own fiddling at a given density, is preferred when
 * re-entering that density, and never modifies the canonical. `local` is a
 * single delimited section so Share is an allowlist — emit apiVersion, kind,
 * metadata and spec — rather than a growing list of fields to remember to
 * strip.
 */

import {isDensityLevel, type DensityLevel} from './density.ts';
import {reflow, type ReflowContext} from './reflow.ts';
import {
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
  ok,
  type CanvasDocument,
  type Layout,
  type Result,
} from './types.ts';

/* `local` must be absent rather than empty when there is nothing in it, or a
 * document that has never been fiddled with would not round-trip byte-stable
 * against the file an author hand-wrote. */
export function loadDocument(text: string): Result<CanvasDocument> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return err('invalid_json', `document is not JSON: ${(cause as Error).message}`);
  }
  return validateDocument(parsed);
}

export function saveDocument(doc: CanvasDocument): string {
  return JSON.stringify(stripDerived(doc), null, 2);
}

export function validateDocument(value: unknown): Result<CanvasDocument> {
  if (!isRecord(value)) return err('not_an_object', 'a canvas document must be an object');
  if (value.apiVersion !== API_VERSION) {
    return err(
      'unsupported_api_version',
      `expected apiVersion ${API_VERSION}, got ${String(value.apiVersion)}`,
      'apiVersion',
    );
  }
  if (value.kind !== KIND) {
    return err('unsupported_kind', `expected kind ${KIND}, got ${String(value.kind)}`, 'kind');
  }
  if (!isRecord(value.metadata) || typeof value.metadata.uid !== 'string' || value.metadata.uid === '') {
    return err('missing_uid', 'metadata.uid is required and must be a non-empty string', 'metadata.uid');
  }
  if (!isRecord(value.spec)) return err('missing_spec', 'spec is required', 'spec');
  if (!isRecord(value.spec.elements)) {
    return err('missing_elements', 'spec.elements is required', 'spec.elements');
  }
  for (const [name, element] of Object.entries(value.spec.elements)) {
    if (!isRecord(element)) {
      return err('invalid_element', `element ${name} must be an object`, `spec.elements.${name}`);
    }
    /* `type` and `namedSize` are required even when this build recognises
     * neither, because they are what lets an unknown block be rendered as a
     * labelled placeholder in the right-sized slot instead of vanishing. */
    if (typeof element.type !== 'string' || element.type === '') {
      return err('missing_element_type', `element ${name} has no type`, `spec.elements.${name}.type`);
    }
    if (typeof element.namedSize !== 'string' || element.namedSize === '') {
      return err(
        'missing_named_size',
        `element ${name} has no namedSize`,
        `spec.elements.${name}.namedSize`,
      );
    }
  }
  const layout = validateLayout(value.spec.layout, 'spec.layout');
  if (!layout.ok) return layout as Result<CanvasDocument>;

  if (value.local !== undefined) {
    if (!isRecord(value.local)) return err('invalid_local', 'local must be an object', 'local');
    const overrides = value.local.densityOverrides;
    if (overrides !== undefined) {
      if (!isRecord(overrides)) {
        return err(
          'invalid_overrides',
          'local.densityOverrides must be an object keyed by density level',
          'local.densityOverrides',
        );
      }
      for (const [level, override] of Object.entries(overrides)) {
        if (!isDensityLevel(level)) {
          return err(
            'unknown_density',
            `local.densityOverrides has no density level named ${level}`,
            `local.densityOverrides.${level}`,
          );
        }
        const checked = validateLayout(override, `local.densityOverrides.${level}`);
        if (!checked.ok) return checked as Result<CanvasDocument>;
      }
    }
  }
  return ok(value as CanvasDocument);
}

export function validateLayout(value: unknown, path: string): Result<Layout> {
  if (!isRecord(value)) return err('invalid_layout', `${path} must be an object`, path);
  if (typeof value.kind !== 'string' || value.kind === '') {
    return err('missing_layout_kind', `${path} has no kind`, `${path}.kind`);
  }
  switch (value.kind) {
    case 'Grid':
      return validateGrid(value, path);
    case 'AutoGrid':
      return validateAutoGrid(value, path);
    case 'Rows':
    case 'Tabs':
      return validateContainer(value, path);
    default:
      /* An unrecognised kind is carried opaquely rather than rejected: a kind
       * this build has never heard of must be able to arrive without a
       * document migration (TREE-02). Only kinds this build claims to
       * understand are checked. */
      return ok(value as Layout);
  }
}

function validateGrid(value: Record<string, unknown>, path: string): Result<Layout> {
  if (!isDensityLevel(value.authoredDensity)) {
    return err(
      'missing_authored_density',
      `${path} has no authoredDensity; a layout without its grid dimensions is uninterpretable and will not be guessed at`,
      `${path}.authoredDensity`,
    );
  }
  if (!Array.isArray(value.items)) {
    return err('invalid_items', `${path}.items must be an array`, `${path}.items`);
  }
  for (let index = 0; index < value.items.length; index += 1) {
    const item: unknown = value.items[index];
    const itemPath = `${path}.items[${index}]`;
    if (!isRecord(item)) return err('invalid_item', `${itemPath} must be an object`, itemPath);
    if (typeof item.element !== 'string' || item.element === '') {
      return err('missing_element_ref', `${itemPath} has no element`, `${itemPath}.element`);
    }
    if (!isWholeNumber(item.col) || !isWholeNumber(item.row)) {
      return err('invalid_position', `${itemPath} needs whole, non-negative col and row`, itemPath);
    }
  }
  return ok(value as Layout);
}

/* An AutoGrid needs its frame of reference for the same reason a Grid does:
 * `maxColumnCount: 3` is meaningless without knowing which grid those columns
 * were counted in. The modes are checked against their named sets because an
 * unnamed mode is not a mode — that is the whole point of naming them. */
function validateAutoGrid(value: Record<string, unknown>, path: string): Result<Layout> {
  if (!isDensityLevel(value.authoredDensity)) {
    return err(
      'missing_authored_density',
      `${path} has no authoredDensity; a layout without its grid dimensions is uninterpretable and will not be guessed at`,
      `${path}.authoredDensity`,
    );
  }
  if (!Array.isArray(value.items)) {
    return err('invalid_items', `${path}.items must be an array`, `${path}.items`);
  }
  for (let index = 0; index < value.items.length; index += 1) {
    const item: unknown = value.items[index];
    const itemPath = `${path}.items[${index}]`;
    if (!isRecord(item)) return err('invalid_item', `${itemPath} must be an object`, itemPath);
    if (typeof item.element !== 'string' || item.element === '') {
      return err('missing_element_ref', `${itemPath} has no element`, `${itemPath}.element`);
    }
  }
  if (value.maxColumnCount !== undefined && !isWholeNumber(value.maxColumnCount)) {
    return err(
      'invalid_max_column_count',
      `${path}.maxColumnCount must be a whole number`,
      `${path}.maxColumnCount`,
    );
  }
  if (value.columnWidthMode !== undefined && !isAutoGridColumnWidthMode(value.columnWidthMode)) {
    return err(
      'unknown_column_width_mode',
      `${path}.columnWidthMode must be one of ${AUTO_GRID_COLUMN_WIDTH_MODES.join(', ')}`,
      `${path}.columnWidthMode`,
    );
  }
  if (value.rowHeightMode !== undefined && !isAutoGridRowHeightMode(value.rowHeightMode)) {
    return err(
      'unknown_row_height_mode',
      `${path}.rowHeightMode must be one of ${AUTO_GRID_ROW_HEIGHT_MODES.join(', ')}`,
      `${path}.rowHeightMode`,
    );
  }
  return ok(value as Layout);
}

/* A Rows or Tabs whose payload this build does not recognise — no `children`
 * array at all — is carried opaquely rather than rejected. The tag alone does
 * not promise this build's shape, and refusing a document because a newer
 * build spelled its container differently is exactly the silent data loss
 * TREE-02 exists to prevent. Once there IS a `children` array, it is checked
 * in full and recursively, because at that point the document is claiming a
 * shape this build will act on. */
function validateContainer(value: Record<string, unknown>, path: string): Result<Layout> {
  if (!Array.isArray(value.children)) return ok(value as Layout);
  for (let index = 0; index < value.children.length; index += 1) {
    const child: unknown = value.children[index];
    const childPath = `${path}.children[${index}]`;
    if (!isRecord(child)) {
      return err('invalid_container_child', `${childPath} must be an object`, childPath);
    }
    if (typeof child.id !== 'string' || child.id === '') {
      return err('missing_child_id', `${childPath} has no id`, `${childPath}.id`);
    }
    const nested = validateLayout(child.layout, `${childPath}.layout`);
    if (!nested.ok) return nested;
  }
  return ok(value as Layout);
}

/* The one place the canonical/override priority is decided. Entering a
 * density with a remembered arrangement restores it; entering an unseen one
 * computes from canonical. This is Folder View's `changedPositions` with its
 * `visitedResolutions` set, minus the replay-once bookkeeping: an override is
 * written when the user moves something, so "seen" and "has an override" are
 * the same question. */
export function layoutFor(
  doc: CanvasDocument,
  density: DensityLevel,
  context?: ReflowContext,
): {layout: Layout; source: 'override' | 'computed'} {
  const override = doc.local?.densityOverrides?.[density];
  if (override !== undefined) {
    return {layout: structuredClone(override), source: 'override'};
  }
  const ctx = context ?? contextFor(doc);
  return {layout: reflow(doc.spec.layout, density, ctx), source: 'computed'};
}

/* Returns a new document. The canonical is untouched, which is the whole
 * point: an override is remembered fiddling, not a new intent. */
export function withOverride(
  doc: CanvasDocument,
  density: DensityLevel,
  layout: Layout,
): Result<CanvasDocument> {
  if (!isDensityLevel(density)) {
    return err('unknown_density', `no density level named ${String(density)}`);
  }
  const checked = validateLayout(layout, `local.densityOverrides.${density}`);
  if (!checked.ok) return checked as Result<CanvasDocument>;
  const next = structuredClone(doc);
  const local = next.local ?? {};
  const overrides = {...(local.densityOverrides ?? {})};
  overrides[density] = stripDerivedLayout(structuredClone(layout));
  next.local = {...local, densityOverrides: overrides};
  return ok(next);
}

export function withoutOverride(doc: CanvasDocument, density: DensityLevel): CanvasDocument {
  const next = structuredClone(doc);
  if (next.local?.densityOverrides === undefined) return next;
  const overrides = {...next.local.densityOverrides};
  delete overrides[density];
  if (Object.keys(overrides).length === 0) {
    const local = {...next.local};
    delete local.densityOverrides;
    if (Object.keys(local).length === 0) delete next.local;
    else next.local = local;
  } else {
    next.local = {...next.local, densityOverrides: overrides};
  }
  return next;
}

/* Share carries the canonical only. An override is one household's fiddling,
 * on one screen, at one density; shipping it would make a template render
 * differently for the recipient than it did for the author. Written as a
 * positive allowlist so a future local field is omitted by default rather
 * than leaking until someone remembers to add it to a strip list. */
export function toShareable(doc: CanvasDocument): CanvasDocument {
  const {local: _local, ...rest} = structuredClone(stripDerived(doc));
  return rest as CanvasDocument;
}

export function contextFor(doc: CanvasDocument, registry = {}): ReflowContext {
  return {elements: doc.spec.elements, registry};
}

/* `derivedFrom` is an in-memory aid for reflow and must never reach the file:
 * persisting a projection's origin alongside it invites a later reader to
 * treat the projection as canonical. */
function stripDerived(doc: CanvasDocument): CanvasDocument {
  const next = structuredClone(doc);
  next.spec.layout = stripDerivedLayout(next.spec.layout);
  const overrides = next.local?.densityOverrides;
  if (overrides !== undefined) {
    for (const level of Object.keys(overrides)) {
      overrides[level] = stripDerivedLayout(overrides[level]!);
    }
  }
  return next;
}

/* Nested layouts are stripped too: a projection buried three containers deep
 * is no less dangerous than one at the top. */
function stripDerivedLayout(layout: Layout): Layout {
  if (hasWalkableChildren(layout)) {
    return {
      ...layout,
      children: layout.children.map((child) =>
        isRecord(child) && isRecord(child.layout)
          ? {...child, layout: stripDerivedLayout(child.layout as Layout)}
          : child,
      ),
    };
  }
  if (!isGridLayout(layout) && !isAutoGridLayout(layout)) return layout;
  if (layout.derivedFrom === undefined) return layout;
  const next = {...layout};
  delete next.derivedFrom;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWholeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
