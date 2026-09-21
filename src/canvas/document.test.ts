/* CommonHome Canvas — document load/save, unknown-content preservation, and
 * the canonical/override split. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contextFor,
  layoutFor,
  loadDocument,
  saveDocument,
  toShareable,
  validateDocument,
  withOverride,
  withoutOverride,
} from './document.ts';
import {reflow} from './reflow.ts';
import {isGridLayout, type CanvasDocument, type Layout} from './types.ts';
import {SEEDS, generateDocument, sampleRegistry} from './testing.ts';

const registry = sampleRegistry();

function expectDoc(result: ReturnType<typeof loadDocument>): CanvasDocument {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as {ok: true; value: CanvasDocument}).value;
}

/* Property 7 — unknown round-trip. An unknown block type, unknown fields on a
 * known block, unknown top-level and metadata fields, and an unknown layout
 * kind all survive load then save with the text unchanged. An older editor
 * must never silently strip what a newer one wrote. */
const FUTURE = `{
  "apiVersion": "canvas.commonhome/v1alpha1",
  "kind": "Canvas",
  "metadata": {
    "uid": "kitchen-wall",
    "generation": 7,
    "labels": {
      "room": "kitchen"
    }
  },
  "spec": {
    "elements": {
      "el-a": {
        "type": "clock",
        "namedSize": "small",
        "config": {
          "timezone": "Europe/London"
        },
        "conditionalRendering": {
          "when": "weekday-morning"
        }
      },
      "el-b": {
        "type": "aquarium-cam",
        "namedSize": "panoramic",
        "streamUrl": "rtsp://tank.local/1",
        "nested": {
          "deep": [
            1,
            2,
            {
              "three": true
            }
          ]
        }
      }
    },
    "layout": {
      "kind": "Tabs",
      "tabs": [
        {
          "title": "Morning",
          "layout": {
            "kind": "Grid",
            "authoredDensity": "standard",
            "items": [
              {
                "element": "el-a",
                "col": 0,
                "row": 0
              }
            ]
          }
        }
      ]
    },
    "annotations": {
      "author": "someone with a newer build"
    }
  },
  "local": {
    "densityOverrides": {
      "dense": {
        "kind": "Tabs",
        "tabs": []
      }
    },
    "lastViewedDensity": "dense"
  },
  "futureTopLevelField": [
    "kept"
  ]
}`;

test('property: unknown types, unknown fields and unknown layout kinds round-trip byte-stable', () => {
  const doc = expectDoc(loadDocument(FUTURE));
  assert.equal(saveDocument(doc), FUTURE);
  /* And stable under repeated cycles, not merely once. */
  assert.equal(saveDocument(expectDoc(loadDocument(saveDocument(doc)))), FUTURE);
  assert.equal(doc.spec.elements['el-b']!.type, 'aquarium-cam');
  assert.equal((doc as Record<string, unknown>).futureTopLevelField !== undefined, true);
});

test('property: generated documents round-trip byte-stable through load and save', () => {
  for (const authored of ['comfortable', 'standard', 'dense'] as const) {
    for (const seed of SEEDS) {
      const text = JSON.stringify(generateDocument(seed, authored, registry), null, 2);
      assert.equal(saveDocument(expectDoc(loadDocument(text))), text, `seed ${seed}`);
    }
  }
});

test('a projection is never persisted over the canonical it came from', () => {
  const doc = generateDocument(1, 'standard', registry);
  const projected = reflow(doc.spec.layout, 'dense', contextFor(doc, registry));
  assert.ok(isGridLayout(projected) && projected.derivedFrom !== undefined);
  const saved = withOverride(doc, 'dense', projected);
  assert.equal(saved.ok, true);
  const text = saveDocument((saved as {ok: true; value: CanvasDocument}).value);
  assert.equal(text.includes('derivedFrom'), false);
});

test('a document missing apiVersion, kind or uid is rejected', () => {
  const base = generateDocument(3, 'standard', registry);
  for (const [mutate, code] of [
    [(d: CanvasDocument) => (d.apiVersion = 'canvas.commonhome/v9'), 'unsupported_api_version'],
    [(d: CanvasDocument) => (d.kind = 'Dashboard'), 'unsupported_kind'],
    [(d: CanvasDocument) => delete (d.metadata as Record<string, unknown>).uid, 'missing_uid'],
  ] as [(d: CanvasDocument) => void, string][]) {
    const doc = structuredClone(base);
    mutate(doc);
    const result = validateDocument(doc);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, code);
  }
});

test('a layout with no authoredDensity is rejected at load, canonical or override', () => {
  const doc = generateDocument(5, 'standard', registry);
  const frameless = {kind: 'Grid', items: [{element: 'el-a0', col: 0, row: 0}]} as unknown as Layout;

  const canonical = structuredClone(doc);
  canonical.spec.layout = frameless;
  const a = validateDocument(canonical);
  assert.equal(a.ok, false);
  assert.equal(a.ok === false && a.error.code, 'missing_authored_density');
  assert.equal(a.ok === false && a.error.path, 'spec.layout.authoredDensity');

  const b = withOverride(doc, 'dense', frameless);
  assert.equal(b.ok, false);
  assert.equal(b.ok === false && b.error.code, 'missing_authored_density');

  const withLocal = structuredClone(doc);
  withLocal.local = {densityOverrides: {dense: frameless}};
  const c = validateDocument(withLocal);
  assert.equal(c.ok, false);
  assert.equal(c.ok === false && c.error.code, 'missing_authored_density');
});

test('an override is preferred over computed reflow and does not touch the canonical', () => {
  const doc = generateDocument(11, 'standard', registry);
  const before = JSON.stringify(doc);
  const moved: Layout = {
    kind: 'Grid',
    authoredDensity: 'dense',
    items: [{element: 'el-a0', col: 7, row: 3}],
  };

  const applied = withOverride(doc, 'dense', moved);
  assert.equal(applied.ok, true);
  const next = (applied as {ok: true; value: CanvasDocument}).value;

  assert.equal(JSON.stringify(doc), before, 'withOverride must not mutate its argument');
  assert.deepEqual(next.spec.layout, doc.spec.layout, 'the canonical layout must be untouched');

  const chosen = layoutFor(next, 'dense', contextFor(next, registry));
  assert.equal(chosen.source, 'override');
  assert.deepEqual(chosen.layout, moved);

  /* An unseen density still computes from canonical. */
  const unseen = layoutFor(next, 'comfortable', contextFor(next, registry));
  assert.equal(unseen.source, 'computed');

  /* And the override survives a save/load cycle. */
  const reloaded = expectDoc(loadDocument(saveDocument(next)));
  assert.deepEqual(reloaded.local?.densityOverrides?.dense, moved);

  /* Clearing it returns to computed, and removes the empty local section so
   * an un-fiddled document is textually identical to one never fiddled. */
  const cleared = withoutOverride(next, 'dense');
  assert.equal(cleared.local, undefined);
  assert.equal(saveDocument(cleared), saveDocument(doc));
  assert.equal(layoutFor(cleared, 'dense', contextFor(cleared, registry)).source, 'computed');
});

test('share carries canonical only; overrides never travel', () => {
  const doc = generateDocument(13, 'standard', registry);
  const applied = withOverride(doc, 'dense', {
    kind: 'Grid',
    authoredDensity: 'dense',
    items: [{element: 'el-a0', col: 1, row: 1}],
  });
  assert.equal(applied.ok, true);
  const next = (applied as {ok: true; value: CanvasDocument}).value;

  const shared = toShareable(next);
  assert.equal(shared.local, undefined);
  assert.equal(JSON.stringify(shared).includes('densityOverrides'), false);
  assert.deepEqual(shared.spec, next.spec, 'share must not alter the canonical');
  /* A shared document is still a valid document to its recipient. */
  assert.equal(validateDocument(shared).ok, true);
  /* And the source is unchanged. */
  assert.notEqual(next.local, undefined);
});

test('an override at an unknown density level is rejected', () => {
  const doc = generateDocument(17, 'standard', registry);
  const bad = structuredClone(doc);
  bad.local = {densityOverrides: {roomy: {kind: 'Grid', authoredDensity: 'standard', items: []}}};
  const result = validateDocument(bad);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'unknown_density');
});

test('an element without type or namedSize is rejected, unknown ones are not', () => {
  const doc = generateDocument(19, 'standard', registry);

  const unknownType = structuredClone(doc);
  unknownType.spec.elements['el-a0'] = {type: 'aquarium-cam', namedSize: 'panoramic'};
  assert.equal(validateDocument(unknownType).ok, true, 'an unknown type must be accepted');

  const untyped = structuredClone(doc);
  delete (untyped.spec.elements['el-a0'] as Record<string, unknown>).type;
  const a = validateDocument(untyped);
  assert.equal(a.ok, false);
  assert.equal(a.ok === false && a.error.code, 'missing_element_type');

  const unsized = structuredClone(doc);
  delete (unsized.spec.elements['el-a0'] as Record<string, unknown>).namedSize;
  const b = validateDocument(unsized);
  assert.equal(b.ok, false);
  assert.equal(b.ok === false && b.error.code, 'missing_named_size');
});

test('malformed JSON and malformed positions are reported, not thrown', () => {
  const broken = loadDocument('{not json');
  assert.equal(broken.ok, false);
  assert.equal(broken.ok === false && broken.error.code, 'invalid_json');

  const doc = generateDocument(23, 'standard', registry);
  const negative = structuredClone(doc);
  (negative.spec.layout as {items: unknown[]}).items = [{element: 'el-a0', col: -1, row: 0}];
  const result = validateDocument(negative);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'invalid_position');
});
