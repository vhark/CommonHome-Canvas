/* CommonHome Canvas — named sizes: the declared set is the whole set. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {DENSITY_LEVELS} from './density.ts';
import {
  buildRegistry,
  declaredSizes,
  isDeclaredSize,
  nearestDeclaredSize,
  resolveCells,
  validateBlockType,
} from './sizes.ts';
import {CATALOGUE, sampleRegistry} from './testing.ts';

const registry = sampleRegistry();

test('an undeclared size is rejected with a structured error, not corrected', () => {
  const result = resolveCells(registry, 'clock', 'enormous', 'standard');
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'undeclared_size');
  assert.equal(result.ok === false && result.error.path, 'clock.enormous');
  /* The message names what is available, because this error surfaces to
   * whoever hand-edited the document. */
  assert.match(result.ok === false ? result.error.message : '', /small, medium/);
  assert.equal(isDeclaredSize(registry, 'clock', 'enormous'), false);
});

test('an unknown block type is reported as such rather than as a bad size', () => {
  const result = resolveCells(registry, 'aquarium-cam', 'panoramic', 'standard');
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'unknown_block_type');
});

test('the picker offers exactly the sizes declared at that density', () => {
  assert.deepEqual(declaredSizes(registry, 'forecast'), ['compact', 'full', 'tiny']);
  /* forecast declines comfortable for compact and full: a block may simply
   * not be offered at a density where it cannot stay legible. */
  assert.deepEqual(declaredSizes(registry, 'forecast', 'comfortable'), ['tiny']);
  assert.deepEqual(declaredSizes(registry, 'forecast', 'dense'), ['compact', 'full', 'tiny']);
  assert.deepEqual(declaredSizes(registry, 'aquarium-cam'), []);
});

test('declared sizes fit their own density and are whole cells', () => {
  for (const spec of CATALOGUE) {
    for (const size of spec.sizes) {
      for (const level of DENSITY_LEVELS) {
        const cells = size.cells[level];
        if (cells === undefined) continue;
        assert.ok(Number.isInteger(cells.w) && cells.w >= 1);
        assert.ok(Number.isInteger(cells.h) && cells.h >= 1);
      }
    }
  }
});

test('a block type declaring a footprint wider than its grid is rejected', () => {
  const result = validateBlockType({
    type: 'billboard',
    sizes: [{name: 'huge', cells: {comfortable: {w: 8, h: 2}}}],
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'size_exceeds_density');
});

test('malformed block type declarations are rejected', () => {
  const cases: [Parameters<typeof validateBlockType>[0], string][] = [
    [{type: '', sizes: []}, 'invalid_block_type'],
    [{type: 'x', sizes: []}, 'no_declared_sizes'],
    [{type: 'x', sizes: [{name: '', cells: {standard: {w: 1, h: 1}}}]}, 'invalid_size_name'],
    [
      {
        type: 'x',
        sizes: [
          {name: 'a', cells: {standard: {w: 1, h: 1}}},
          {name: 'a', cells: {standard: {w: 2, h: 1}}},
        ],
      },
      'duplicate_size_name',
    ],
    [{type: 'x', sizes: [{name: 'a', cells: {}}]}, 'size_offered_nowhere'],
    [{type: 'x', sizes: [{name: 'a', cells: {standard: {w: 1.5, h: 1}}}]}, 'invalid_size_cells'],
    [{type: 'x', sizes: [{name: 'a', cells: {standard: {w: 0, h: 1}}}]}, 'invalid_size_cells'],
  ];
  for (const [spec, code] of cases) {
    const result = validateBlockType(spec);
    assert.equal(result.ok, false, `${code} should have been rejected`);
    assert.equal(result.ok === false && result.error.code, code);
  }
});

test('a duplicate block type is rejected when building a registry', () => {
  const result = buildRegistry([CATALOGUE[0]!, CATALOGUE[0]!]);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'duplicate_block_type');
});

test('snapping picks the nearest declared size, breaking ties toward the smaller', () => {
  /* Halving forecast/compact (3x2 at standard) gives a desired 2x1 at
   * comfortable. forecast declares only tiny (2x2) there, so that is the
   * answer regardless of the height mismatch — width is compared first
   * because the column count is the bounded axis. */
  const snapped = nearestDeclaredSize(registry, 'forecast', 'comfortable', {w: 2, h: 1});
  assert.equal(snapped.ok, true);
  assert.equal(snapped.ok === true && snapped.value.name, 'tiny');

  /* clock declares small (1x1) and medium (2x1) at comfortable. A desired
   * 1.5-wide is equidistant; the tie breaks toward the smaller footprint. */
  const tie = nearestDeclaredSize(registry, 'clock', 'comfortable', {w: 1.5, h: 1});
  assert.equal(tie.ok, true);
  assert.equal(tie.ok === true && tie.value.name, 'small');

  /* Snapping is a pure lookup: same arguments, same answer, every time. */
  for (let i = 0; i < 5; i += 1) {
    const again = nearestDeclaredSize(registry, 'clock', 'comfortable', {w: 1.5, h: 1});
    assert.deepEqual(again, tie);
  }
});

test('snapping fails cleanly for a type that offers nothing at the density', () => {
  const built = buildRegistry([
    {type: 'ticker', sizes: [{name: 'wide', cells: {dense: {w: 6, h: 1}}}]},
  ]);
  assert.equal(built.ok, true);
  const result = nearestDeclaredSize(
    (built as {ok: true; value: ReturnType<typeof sampleRegistry>}).value,
    'ticker',
    'comfortable',
    {w: 3, h: 1},
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'no_size_at_density');
});
