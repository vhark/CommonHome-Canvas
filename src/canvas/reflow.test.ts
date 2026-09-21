/* CommonHome Canvas — property tests for density reflow.
 *
 * Property-based rather than example-based, because the failures this guards
 * against are drift and collision, and neither shows up in the examples
 * anyone thinks to write down. Each property is asserted over a fixed sweep
 * of seeds so a failure names the seed that produced it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {DENSITY, columnsFor, type DensityLevel} from './density.ts';
import {reflow, tryReflow, UninterpretableLayout} from './reflow.ts';
import {layoutFor} from './document.ts';
import {isGridLayout, type CanvasDocument, type GridItem, type Layout} from './types.ts';
import {SEEDS, generateDocument, sampleRegistry} from './testing.ts';

const registry = sampleRegistry();
const LEVELS: DensityLevel[] = ['comfortable', 'standard', 'dense'];

function contextOf(doc: CanvasDocument) {
  return {elements: doc.spec.elements, registry};
}

function items(layout: Layout): GridItem[] {
  assert.ok(isGridLayout(layout), 'expected a Grid layout');
  return layout.items;
}

function footprint(item: GridItem): {w: number; h: number} {
  return {
    w: typeof item.w === 'number' ? item.w : 1,
    h: typeof item.h === 'number' ? item.h : 1,
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

/* Property 1 — round-trip identity. Reflowing away from the authored density
 * and back must return the authored layout exactly, not approximately. This
 * is the payoff for choosing column counts that double. */
test('property: round-trip through any other density returns the authored layout', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateDocument(seed, authored, registry);
      const context = contextOf(doc);
      const original = structuredClone(doc.spec.layout);
      for (const away of LEVELS) {
        if (away === authored) continue;
        const there = reflow(doc.spec.layout, away, context);
        const back = reflow(there, authored, context);
        assert.deepEqual(
          back,
          original,
          `seed ${seed}: ${authored} -> ${away} -> ${authored} did not return the authored layout`,
        );
      }
    }
  }
});

/* Property 2 — idempotence. Its absence is how a layout drifts a little on
 * every density change until it is ruined. */
test('property: reflowing twice to the same density changes nothing further', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateDocument(seed, authored, registry);
      const context = contextOf(doc);
      for (const target of LEVELS) {
        const once = reflow(doc.spec.layout, target, context);
        const twice = reflow(once, target, context);
        assert.deepEqual(twice, once, `seed ${seed}: reflow to ${target} is not idempotent`);
      }
    }
  }
});

/* Property 3 — purity. Same input, same output; the input is deep-frozen so
 * any attempt to mutate it would throw in strict mode (modules are strict). */
test('property: reflow is pure — repeatable, and does not touch its input', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateDocument(seed, authored, registry);
      const context = deepFreeze(contextOf(structuredClone(doc)));
      const layout = deepFreeze(structuredClone(doc.spec.layout));
      const snapshot = JSON.stringify(layout);
      for (const target of LEVELS) {
        const a = reflow(layout, target, context);
        const b = reflow(layout, target, context);
        assert.deepEqual(b, a, `seed ${seed}: reflow to ${target} is not repeatable`);
        assert.equal(JSON.stringify(layout), snapshot, `seed ${seed}: reflow mutated its input`);
        /* The result must not alias the input, or a caller mutating the
         * result would reach back into the canonical. */
        assert.notEqual(a, layout);
        assert.notEqual(a, b);
      }
    }
  }
});

/* Property 4 — no overlap. If snapping a footprint causes a collision it is
 * resolved, never accepted. */
test('property: no two blocks occupy the same cell after reflow', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateDocument(seed, authored, registry);
      const context = contextOf(doc);
      for (const target of LEVELS) {
        const out = items(reflow(doc.spec.layout, target, context));
        const occupied = new Map<string, string>();
        for (const item of out) {
          const {w, h} = footprint(item);
          for (let r = item.row; r < item.row + h; r += 1) {
            for (let c = item.col; c < item.col + w; c += 1) {
              const key = `${r}:${c}`;
              const holder = occupied.get(key);
              assert.equal(
                holder,
                undefined,
                `seed ${seed} at ${target}: ${String(item.element)} overlaps ${String(holder)} at ${key}`,
              );
              occupied.set(key, String(item.element));
            }
          }
        }
      }
    }
  }
});

/* Property 5 — in bounds. Nothing may sit outside the target grid's columns,
 * and nothing may sit at a negative coordinate. */
test('property: every block sits inside the target density column count', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateDocument(seed, authored, registry);
      const context = contextOf(doc);
      for (const target of LEVELS) {
        const columns = columnsFor(target);
        for (const item of items(reflow(doc.spec.layout, target, context))) {
          const {w, h} = footprint(item);
          assert.ok(Number.isInteger(item.col) && item.col >= 0, 'col must be a whole number >= 0');
          assert.ok(Number.isInteger(item.row) && item.row >= 0, 'row must be a whole number >= 0');
          assert.ok(Number.isInteger(w) && w >= 1 && Number.isInteger(h) && h >= 1);
          assert.ok(
            item.col + w <= columns,
            `seed ${seed} at ${target}: ${String(item.element)} spans past column ${columns}`,
          );
        }
      }
    }
  }
});

/* Property 6 — element preservation. Reflow rewrites layout only. Nothing in
 * spec.elements may be added, dropped, renamed or reordered, and the layout's
 * element references must keep their order and multiplicity. */
test('property: reflow never adds, drops, renames or reorders elements', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateDocument(seed, authored, registry);
      const context = contextOf(doc);
      const elementsBefore = JSON.stringify(doc.spec.elements);
      const refsBefore = items(doc.spec.layout).map((item) => item.element);
      for (const target of LEVELS) {
        const out = reflow(doc.spec.layout, target, context);
        assert.equal(
          JSON.stringify(doc.spec.elements),
          elementsBefore,
          `seed ${seed} at ${target}: element content changed`,
        );
        assert.deepEqual(
          items(out).map((item) => item.element),
          refsBefore,
          `seed ${seed} at ${target}: element references were reordered or altered`,
        );
        /* And through the document-level path, which is what callers use. */
        const viaDoc = layoutFor(doc, target, context);
        assert.deepEqual(items(viaDoc.layout).map((item) => item.element), refsBefore);
        assert.equal(JSON.stringify(doc.spec.elements), elementsBefore);
      }
    }
  }
});

/* Every projection has to carry the target density, or the projected layout
 * would be exactly the frameless record KDE spent seven years regretting. */
test('property: a reflowed layout records the density it was reflowed to', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS.slice(0, 20)) {
      const doc = generateDocument(seed, authored, registry);
      const context = contextOf(doc);
      for (const target of LEVELS) {
        const out = reflow(doc.spec.layout, target, context);
        assert.ok(isGridLayout(out));
        assert.equal(out.authoredDensity, target);
      }
    }
  }
});

test('an unrecognised layout kind passes through reflow unchanged', () => {
  const foreign: Layout = {
    kind: 'Tabs',
    tabs: [{title: 'Morning', layout: {kind: 'Grid', authoredDensity: 'standard', items: []}}],
    somethingNewer: {deep: [1, 2, {three: true}]},
  };
  const snapshot = JSON.stringify(foreign);
  for (const target of Object.keys(DENSITY) as DensityLevel[]) {
    const out = reflow(foreign, target);
    assert.deepEqual(out, foreign, `an unimplemented kind must not be coerced at ${target}`);
    assert.notEqual(out, foreign, 'must still be a fresh value, not the caller’s object');
  }
  assert.equal(JSON.stringify(foreign), snapshot);
});

test('a Grid layout without authoredDensity is rejected, never guessed at', () => {
  const frameless = {kind: 'Grid', items: [{element: 'a', col: 0, row: 0}]} as unknown as Layout;
  const attempt = tryReflow(frameless, 'standard');
  assert.equal(attempt.ok, false);
  assert.equal(attempt.ok === false && attempt.error.code, 'missing_authored_density');
  assert.throws(() => reflow(frameless, 'standard'), UninterpretableLayout);
});

test('reflow to an unknown density is rejected', () => {
  const layout: Layout = {kind: 'Grid', authoredDensity: 'standard', items: []};
  const attempt = tryReflow(layout, 'roomy' as DensityLevel);
  assert.equal(attempt.ok, false);
  assert.equal(attempt.ok === false && attempt.error.code, 'unknown_density');
});

test('a size not offered at the target density snaps to a declared one', () => {
  /* forecast/compact is declared at standard and dense but not at
   * comfortable, so reflowing it down must land on a size the type really
   * declares rather than on 1.5 cells. */
  const doc: CanvasDocument = {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'snap'},
    spec: {
      elements: {weather: {type: 'forecast', namedSize: 'compact'}},
      layout: {kind: 'Grid', authoredDensity: 'standard', items: [{element: 'weather', col: 4, row: 0}]},
    },
  };
  const out = items(reflow(doc.spec.layout, 'comfortable', contextOf(doc)))[0]!;
  assert.equal(out.snappedSize, 'tiny');
  assert.deepEqual(footprint(out), {w: 2, h: 2});
  assert.ok(out.col + 2 <= columnsFor('comfortable'));
  /* The element itself keeps its authored size: reflow does not rewrite
   * content, so returning to standard restores the compact forecast. */
  assert.equal(doc.spec.elements.weather!.namedSize, 'compact');
});

/* Chaining through an intermediate density must not compound the loss. A
 * projection carries its origin, so the second hop re-derives from the
 * canonical rather than from the already-degraded intermediate. */
test('property: chaining densities agrees with going there directly', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateDocument(seed, authored, registry);
      const context = contextOf(doc);
      for (const middle of LEVELS) {
        for (const target of LEVELS) {
          const chained = reflow(reflow(doc.spec.layout, middle, context), target, context);
          const direct = reflow(doc.spec.layout, target, context);
          assert.deepEqual(
            chained,
            direct,
            `seed ${seed}: ${authored} -> ${middle} -> ${target} differs from ${authored} -> ${target}`,
          );
        }
      }
    }
  }
});
