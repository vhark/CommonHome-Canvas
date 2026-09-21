/* CommonHome Canvas — the reflow properties, across nesting.
 *
 * Wave 1 proved round-trip identity, idempotence, purity and element
 * preservation for a flat Grid. A layout is a tree, so every one of those has
 * to hold at every depth, and two more join them: ordered containers must
 * keep their order, and an unknown kind nested inside a known container must
 * round-trip untouched without stopping its siblings reflowing.
 *
 * The generator produces mixed trees of depth 3 to 4 — Rows and Tabs holding
 * Grids, AutoGrids, further containers, and occasionally a kind this build
 * has never heard of. Each property sweeps every seed at every authored
 * density, so a failure names the seed that produced it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {columnsFor, type DensityLevel} from './density.ts';
import {reflow, tryReflow} from './reflow.ts';
import {layoutFor, saveDocument, validateDocument} from './document.ts';
import {
  isAutoGridLayout,
  isGridLayout,
  isOrderedContainer,
  type CanvasDocument,
  type Layout,
} from './types.ts';
import {
  SEEDS,
  containerOrder,
  elementRefs,
  generateNestedDocument,
  maxDepth,
  sampleRegistry,
} from './testing.ts';

const registry = sampleRegistry();
const LEVELS: DensityLevel[] = ['comfortable', 'standard', 'dense'];

function contextOf(doc: CanvasDocument) {
  return {elements: doc.spec.elements, registry};
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

/* The sweep is only worth anything if the trees are actually nested and
 * actually mixed. Asserting that here means a later change to the generator
 * that quietly flattened it would fail loudly rather than turn every property
 * below into a restatement of Wave 1. */
test('the generator produces mixed trees nested at least three deep', () => {
  const kinds = new Set<string>();
  let deepest = 0;
  let withForeign = 0;
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateNestedDocument(seed, authored, registry);
      deepest = Math.max(deepest, maxDepth(doc.spec.layout));
      assert.ok(
        maxDepth(doc.spec.layout) >= 3,
        `seed ${seed} at ${authored}: tree is not nested deeply enough`,
      );
      collectKinds(doc.spec.layout, kinds);
      if (JSON.stringify(doc.spec.layout).includes('"Carousel"')) withForeign += 1;
      assert.ok(elementRefs(doc.spec.layout).length > 0, `seed ${seed}: tree holds no elements`);
    }
  }
  assert.ok(deepest >= 4, 'expected at least one tree four deep');
  for (const kind of ['Rows', 'Tabs', 'Grid', 'AutoGrid', 'Carousel']) {
    assert.ok(kinds.has(kind), `the sweep never generated a ${kind}`);
  }
  assert.ok(withForeign > 50, `only ${withForeign} trees carried an unknown nested kind`);
});

function collectKinds(layout: Layout, into: Set<string>): void {
  into.add(layout.kind);
  if (isOrderedContainer(layout) && Array.isArray(layout.children)) {
    for (const child of layout.children) collectKinds(child.layout, into);
  }
}

/* Property 1 — round-trip identity across nesting. Every leaf re-derives from
 * its own canonical, so returning to the authored density must restore the
 * whole tree exactly, not approximately. */
test('property: a nested tree round-trips through any other density unchanged', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateNestedDocument(seed, authored, registry);
      const context = contextOf(doc);
      const original = structuredClone(doc.spec.layout);
      for (const away of LEVELS) {
        if (away === authored) continue;
        const there = reflow(doc.spec.layout, away, context);
        const back = reflow(there, authored, context);
        assert.deepEqual(
          back,
          original,
          `seed ${seed}: ${authored} -> ${away} -> ${authored} did not return the authored tree`,
        );
      }
    }
  }
});

/* Property 2 — idempotence across nesting. Absent it, a tree drifts a little
 * at every level on every density change, and the deeper the tree the worse
 * the compounding. */
test('property: reflowing a nested tree twice to the same density changes nothing further', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateNestedDocument(seed, authored, registry);
      const context = contextOf(doc);
      for (const target of LEVELS) {
        const once = reflow(doc.spec.layout, target, context);
        const twice = reflow(once, target, context);
        assert.deepEqual(twice, once, `seed ${seed}: reflow to ${target} is not idempotent`);
      }
    }
  }
});

/* Property 3 — purity across nesting. The whole tree is deep-frozen, so any
 * write at any depth would throw; modules are strict, so a silent no-op is
 * not available either. */
test('property: reflow of a nested tree is pure at every depth', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateNestedDocument(seed, authored, registry);
      const context = deepFreeze(contextOf(structuredClone(doc)));
      const layout = deepFreeze(structuredClone(doc.spec.layout));
      const snapshot = JSON.stringify(layout);
      for (const target of LEVELS) {
        const a = reflow(layout, target, context);
        const b = reflow(layout, target, context);
        assert.deepEqual(b, a, `seed ${seed}: reflow to ${target} is not repeatable`);
        assert.equal(JSON.stringify(layout), snapshot, `seed ${seed}: reflow mutated its input`);
        assert.notEqual(a, layout);
        assert.notEqual(a, b);
        /* No node of the result may alias a node of the input, or a caller
         * editing one branch would reach back into the canonical. */
        assert.equal(sharesNode(a, layout), false, `seed ${seed}: result aliases the input tree`);
      }
    }
  }
});

function nodes(layout: Layout, into: Set<unknown>): Set<unknown> {
  into.add(layout);
  if (isOrderedContainer(layout) && Array.isArray(layout.children)) {
    for (const child of layout.children) {
      into.add(child);
      nodes(child.layout, into);
    }
  }
  return into;
}

function sharesNode(a: Layout, b: Layout): boolean {
  const left = nodes(a, new Set());
  for (const node of nodes(b, new Set())) if (left.has(node)) return true;
  return false;
}

/* Property 4 — element preservation across nesting. Reflow rewrites layout
 * only. The set AND the order of element references gathered over a full
 * traversal must be identical before and after, at every depth, and
 * spec.elements must be untouched. */
test('property: a nested reflow never adds, drops, renames or reorders elements', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateNestedDocument(seed, authored, registry);
      const context = contextOf(doc);
      const elementsBefore = JSON.stringify(doc.spec.elements);
      const refsBefore = elementRefs(doc.spec.layout);
      /* Names are allocated from one counter per tree, so a duplicate would
       * mean the traversal is visiting a branch twice and the comparison
       * below would be weaker than it looks. */
      assert.equal(new Set(refsBefore).size, refsBefore.length);
      for (const target of LEVELS) {
        const out = reflow(doc.spec.layout, target, context);
        assert.deepEqual(
          elementRefs(out),
          refsBefore,
          `seed ${seed} at ${target}: element references changed across the tree`,
        );
        assert.equal(
          JSON.stringify(doc.spec.elements),
          elementsBefore,
          `seed ${seed} at ${target}: element content changed`,
        );
        /* And through the document-level path, which is what callers use. */
        const viaDoc = layoutFor(doc, target, context);
        assert.deepEqual(elementRefs(viaDoc.layout), refsBefore);
        assert.equal(JSON.stringify(doc.spec.elements), elementsBefore);
      }
    }
  }
});

/* Property 5 — order stability. This is the entire value of Rows and Tabs: an
 * ordered list has nothing to scramble. Asserted on the full path of child
 * ids rather than on array length, so a swap that preserved the count would
 * still be caught. */
test('property: Rows and Tabs preserve child order exactly under reflow', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateNestedDocument(seed, authored, registry);
      const context = contextOf(doc);
      const orderBefore = containerOrder(doc.spec.layout);
      assert.ok(orderBefore.length > 0, `seed ${seed}: tree has no ordered containers`);
      for (const target of LEVELS) {
        const out = reflow(doc.spec.layout, target, context);
        assert.deepEqual(
          containerOrder(out),
          orderBefore,
          `seed ${seed} at ${target}: container order changed`,
        );
        /* Reflowing away and back, and chaining through an intermediate
         * density, must not perturb it either. */
        const chained = reflow(reflow(out, 'dense', context), 'comfortable', context);
        assert.deepEqual(containerOrder(chained), orderBefore);
      }
    }
  }
});

/* An ordered container's order is preserved even when its children are
 * deliberately hostile to sorting: reversed ids, and an unknown kind in the
 * middle. A sort keyed on anything but position would show up here. */
test('a container with adversarially ordered children keeps its order', () => {
  const layout: Layout = {
    kind: 'Rows',
    children: [
      {id: 'zebra', layout: {kind: 'Grid', authoredDensity: 'standard', items: []}},
      {id: 'apple', layout: {kind: 'Carousel', slides: []}},
      {id: 'mango', layout: {kind: 'AutoGrid', authoredDensity: 'standard', items: [], maxColumnCount: 4}},
      {id: 'banana', layout: {kind: 'Tabs', children: [
        {id: 'second', layout: {kind: 'Grid', authoredDensity: 'standard', items: []}},
        {id: 'first', layout: {kind: 'Grid', authoredDensity: 'standard', items: []}},
      ]}},
    ],
  };
  for (const target of LEVELS) {
    const out = reflow(layout, target);
    assert.deepEqual(
      (out as {children: {id: string}[]}).children.map((c) => c.id),
      ['zebra', 'apple', 'mango', 'banana'],
      `order changed at ${target}`,
    );
    assert.deepEqual(containerOrder(out), containerOrder(layout));
  }
});

/* Property 6 — an unknown kind nested inside a known container round-trips
 * unchanged and does not prevent its siblings reflowing. The second half is
 * the part that matters: preserving the unknown by refusing to reflow the
 * whole tree would be preservation at the cost of the feature. */
test('property: an unknown nested kind round-trips and does not block its siblings', () => {
  let checked = 0;
  let siblingsChecked = 0;
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateNestedDocument(seed, authored, registry, {foreignChance: 0.5});
      const context = contextOf(doc);
      const foreignBefore = foreignNodes(doc.spec.layout);
      if (foreignBefore.length === 0) continue;
      checked += 1;
      for (const target of LEVELS) {
        if (target === authored) continue;
        const out = reflow(doc.spec.layout, target, context);
        assert.deepEqual(
          foreignNodes(out),
          foreignBefore,
          `seed ${seed} at ${target}: an unknown nested kind was altered`,
        );
        /* Its siblings really did move: at a different density every known
         * leaf must now record the target density. Without this the
         * assertion above would pass on a reflow that did nothing at all. A
         * tree can legitimately be all-unknown, in which case there are no
         * siblings to check; the tally below insists that most are not. */
        const densities = knownLeafDensities(out);
        if (densities.length === 0) continue;
        siblingsChecked += 1;
        assert.ok(
          densities.every((level) => level === target),
          `seed ${seed}: siblings of an unknown kind did not reflow to ${target}`,
        );
      }
    }
  }
  assert.ok(checked > 100, `only ${checked} trees carried an unknown nested kind`);
  assert.ok(
    siblingsChecked > 100,
    `only ${siblingsChecked} cases had a known sibling beside an unknown kind`,
  );
});

function foreignNodes(layout: Layout): unknown[] {
  const out: unknown[] = [];
  const walk = (node: Layout): void => {
    if (isOrderedContainer(node) && Array.isArray(node.children)) {
      for (const child of node.children) walk(child.layout);
      return;
    }
    if (!isGridLayout(node) && !isAutoGridLayout(node)) out.push(structuredClone(node));
  };
  walk(layout);
  return out;
}

function knownLeafDensities(layout: Layout): string[] {
  const out: string[] = [];
  const walk = (node: Layout): void => {
    if (isOrderedContainer(node) && Array.isArray(node.children)) {
      for (const child of node.children) walk(child.layout);
      return;
    }
    if (isGridLayout(node) || isAutoGridLayout(node)) out.push(node.authoredDensity);
  };
  walk(layout);
  return out;
}

/* A tree whose every leaf is an unknown kind still reflows: the container is
 * rebuilt, nothing inside it is touched, and no error is raised. */
test('a container holding only unknown kinds reflows without error or change', () => {
  const layout: Layout = {
    kind: 'Tabs',
    children: [
      {id: 'a', layout: {kind: 'Carousel', slides: [{n: 1}]}},
      {id: 'b', layout: {kind: 'Masonry', gutter: 3, nested: {deep: [1, {two: true}]}}},
    ],
  };
  for (const target of LEVELS) {
    const out = reflow(layout, target);
    assert.deepEqual(out, layout, `an all-unknown tree changed at ${target}`);
    assert.notEqual(out, layout);
  }
});

/* A container tagged Rows or Tabs but shaped the way some newer build spells
 * it must pass through whole. Emptying it, or rejecting the document, are the
 * two ways TREE-02 gets broken in practice. */
test('a container whose payload this build does not recognise passes through intact', () => {
  const layout: Layout = {kind: 'Rows', rows: [{title: 'top', panels: []}], somethingNewer: true};
  const out = reflow(layout, 'dense');
  assert.deepEqual(out, layout);
  assert.notEqual(out, layout);
});

/* Nesting must not become a way to smuggle an uninterpretable layout past
 * validation: a frameless Grid four levels down is as unusable as one at the
 * top, and the error must name where it was found. */
test('an uninterpretable layout nested in a container is reported, not half-applied', () => {
  const layout: Layout = {
    kind: 'Rows',
    children: [
      {id: 'ok', layout: {kind: 'Grid', authoredDensity: 'standard', items: []}},
      {
        id: 'nested',
        layout: {
          kind: 'Tabs',
          children: [{id: 'bad', layout: {kind: 'Grid', items: []} as unknown as Layout}],
        },
      },
    ],
  };
  const attempt = tryReflow(layout, 'dense');
  assert.equal(attempt.ok, false);
  assert.equal(attempt.ok === false && attempt.error.code, 'missing_authored_density');

  const doc = {
    apiVersion: 'canvas.commonhome/v1alpha1',
    kind: 'Canvas',
    metadata: {uid: 'nested-bad'},
    spec: {elements: {}, layout},
  };
  const validated = validateDocument(doc);
  assert.equal(validated.ok, false);
  assert.equal(validated.ok === false && validated.error.code, 'missing_authored_density');
  assert.equal(
    validated.ok === false && validated.error.path,
    'spec.layout.children[1].layout.children[0].layout.authoredDensity',
  );
});

/* AutoGrid: density largely IS the column count, so maxColumnCount scales by
 * the same exact integer factor Grid uses, while the named modes do not move
 * — they are named precisely so they mean the same thing at every density. */
test('AutoGrid scales its column count and leaves its named modes alone', () => {
  const layout: Layout = {
    kind: 'AutoGrid',
    authoredDensity: 'standard',
    maxColumnCount: 3,
    columnWidthMode: 'wide',
    rowHeightMode: 'short',
    items: [{element: 'el-a0'}, {element: 'el-b0'}],
  };
  const dense = reflow(layout, 'dense') as {maxColumnCount: number; [k: string]: unknown};
  assert.equal(dense.maxColumnCount, 6);
  assert.equal(dense.columnWidthMode, 'wide');
  assert.equal(dense.rowHeightMode, 'short');
  assert.equal(dense.authoredDensity, 'dense');
  assert.deepEqual((dense.items as {element: string}[]).map((i) => i.element), ['el-a0', 'el-b0']);

  const comfortable = reflow(layout, 'comfortable') as {maxColumnCount: number};
  assert.equal(comfortable.maxColumnCount, 2);

  /* And it never exceeds the target grid, which is the bound the whole
   * layout is counted in. */
  const wide: Layout = {kind: 'AutoGrid', authoredDensity: 'comfortable', maxColumnCount: 6, items: []};
  const widened = reflow(wide, 'dense') as {maxColumnCount: number};
  assert.ok(widened.maxColumnCount <= columnsFor('dense'));
});

test('an AutoGrid without authoredDensity is rejected, never guessed at', () => {
  const frameless = {kind: 'AutoGrid', items: []} as unknown as Layout;
  const attempt = tryReflow(frameless, 'standard');
  assert.equal(attempt.ok, false);
  assert.equal(attempt.ok === false && attempt.error.code, 'missing_authored_density');
});

test('an AutoGrid mode outside its named set is rejected', () => {
  for (const [field, value, code] of [
    ['columnWidthMode', 'enormous', 'unknown_column_width_mode'],
    ['rowHeightMode', 'squat', 'unknown_row_height_mode'],
  ] as [string, string, string][]) {
    const layout = {kind: 'AutoGrid', authoredDensity: 'standard', items: [], [field]: value};
    const result = validateDocument({
      apiVersion: 'canvas.commonhome/v1alpha1',
      kind: 'Canvas',
      metadata: {uid: 'modes'},
      spec: {elements: {}, layout},
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, code);
  }
});

/* A projection nested any distance down must not reach the file: a reader
 * finding derivedFrom beside a layout could reasonably treat that layout as
 * canonical, and at depth it is harder to spot, not easier. */
test('property: no nested projection is ever persisted', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS.slice(0, 30)) {
      const doc = generateNestedDocument(seed, authored, registry);
      const context = contextOf(doc);
      for (const target of LEVELS) {
        if (target === authored) continue;
        const projected = structuredClone(doc);
        projected.spec.layout = reflow(doc.spec.layout, target, context);
        assert.ok(
          JSON.stringify(projected.spec.layout).includes('derivedFrom'),
          `seed ${seed}: expected the projection to carry its origin in memory`,
        );
        assert.equal(saveDocument(projected).includes('derivedFrom'), false, `seed ${seed}`);
      }
    }
  }
});

/* A nested tree is a valid document and survives load/save byte-stable, or
 * none of the properties above would survive contact with a file. */
test('property: nested documents validate and round-trip byte-stable', () => {
  for (const authored of LEVELS) {
    for (const seed of SEEDS) {
      const doc = generateNestedDocument(seed, authored, registry);
      const result = validateDocument(doc);
      assert.equal(
        result.ok,
        true,
        `seed ${seed}: ${result.ok === false ? result.error.message : ''}`,
      );
      const text = JSON.stringify(doc, null, 2);
      assert.equal(saveDocument(doc), text, `seed ${seed}: nested document is not byte-stable`);
    }
  }
});
