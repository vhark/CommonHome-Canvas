/* CommonHome Canvas — density levels are a closed, doubling set. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DENSITY,
  DENSITY_LEVELS,
  columnsFor,
  isDensityLevel,
  scaleFactor,
} from './density.ts';

test('density is a closed named set with doubling column counts', () => {
  assert.deepEqual(Object.keys(DENSITY), ['comfortable', 'standard', 'dense']);
  assert.deepEqual([...DENSITY_LEVELS], Object.keys(DENSITY));
  /* Doubling is what makes reflow exact integer arithmetic; if this ever
   * changes, round-trip identity stops being achievable. */
  for (let i = 1; i < DENSITY_LEVELS.length; i += 1) {
    assert.equal(columnsFor(DENSITY_LEVELS[i]!), columnsFor(DENSITY_LEVELS[i - 1]!) * 2);
  }
});

test('every scale factor between levels is an exact power of two', () => {
  for (const from of DENSITY_LEVELS) {
    for (const to of DENSITY_LEVELS) {
      const factor = scaleFactor(from, to);
      assert.equal(scaleFactor(to, from), 1 / factor);
      assert.ok(Number.isInteger(Math.log2(factor)), `${from}->${to} is not a power of two`);
    }
  }
});

test('an unrecognised density name is not a level', () => {
  for (const value of ['roomy', '', '12', 12, null, undefined, {}]) {
    assert.equal(isDensityLevel(value), false, `${String(value)} should not be a level`);
  }
  for (const level of DENSITY_LEVELS) assert.equal(isDensityLevel(level), true);
  /* Inherited property names must not pass as levels. */
  assert.equal(isDensityLevel('toString'), false);
  assert.equal(isDensityLevel('constructor'), false);
});
