import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PrecisionError, divRound, fromScaled, toScaled, unit } from './decimal.ts';

test('toScaled: exact values at the venue precision', () => {
  assert.equal(toScaled('77108.1', 1), 771081n);
  assert.equal(toScaled('0.001', 5), 100n);
  assert.equal(toScaled('100', 6), 100_000_000n);
  assert.equal(toScaled('0.29', 2), 29n); // the float trap: 0.29 * 100 = 28.999…
  assert.equal(toScaled('-1.5', 3), -1500n);
});

test('toScaled: exact refuses to round; floor and ceil go the right way', () => {
  assert.throws(() => toScaled('0.0011', 3), PrecisionError);
  assert.equal(toScaled('0.0011', 3, 'floor'), 1n);
  assert.equal(toScaled('0.0011', 3, 'ceil'), 2n);
  assert.equal(toScaled('-0.0011', 3, 'floor'), -2n);
  assert.equal(toScaled('-0.0011', 3, 'ceil'), -1n);
  assert.equal(toScaled('0.0010', 3), 1n); // trailing zeros are not extra precision
});

test('toScaled: rejects anything that is not a plain decimal', () => {
  for (const bad of ['', '1e5', '0x10', '1.', '.5', 'NaN', '1,5']) {
    assert.throws(() => toScaled(bad, 2), /not a decimal/, bad);
  }
});

test('fromScaled: trims zeros, keeps sign, round-trips', () => {
  assert.equal(fromScaled(771081n, 1), '77108.1');
  assert.equal(fromScaled(100, 5), '0.001');
  assert.equal(fromScaled('100000000', 6), '100');
  assert.equal(fromScaled(0n, 6), '0');
  assert.equal(fromScaled(-5_000_000_000n, 6), '-5000');
  for (const v of ['0.00001', '123.45', '98765.4321', '-0.5']) {
    assert.equal(fromScaled(toScaled(v, 5), 5), v);
  }
  assert.equal(unit(3), '0.001');
});

test('divRound: half away from zero', () => {
  assert.equal(divRound(5n, 2n), 3n);
  assert.equal(divRound(-5n, 2n), -3n);
  assert.equal(divRound(4n, 3n), 1n);
  assert.throws(() => divRound(1n, 0n));
});
