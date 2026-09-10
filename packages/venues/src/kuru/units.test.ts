/**
 * Unit-domain conversions. Plain node, no network. `./units.ts` is imported
 * with its extension because node's type stripping resolves specifiers
 * literally.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromUnits, KuruUnitsError, precisionDecimals, ratioToDecimal, toUnits } from './units.ts';

test('toUnits parses exactly, padding the fraction', () => {
  assert.equal(toUnits('1', 6), 1_000_000n);
  assert.equal(toUnits('0.000001', 6), 1n);
  assert.equal(toUnits('12.34', 6), 12_340_000n);
  assert.equal(toUnits('0', 18), 0n);
});

test('toUnits accepts trailing zeros beyond the precision — they carry no value', () => {
  assert.equal(toUnits('1.50', 1), 15n);
  assert.equal(toUnits('2.000000000', 6), 2_000_000n);
});

test('toUnits refuses to round away real precision', () => {
  // viem's parseUnits would silently round this to 2; an order must not.
  assert.throws(() => toUnits('1.55', 1), KuruUnitsError);
  assert.throws(() => toUnits('0.0000001', 6), KuruUnitsError);
});

test('toUnits rejects anything that is not a non-negative decimal', () => {
  for (const bad of ['-1', '1e6', '', '.5', '1.', 'abc', '0x10', '1,000']) {
    assert.throws(() => toUnits(bad, 6), KuruUnitsError, bad);
  }
});

test('fromUnits is exact and drops trailing zeros', () => {
  assert.equal(fromUnits(1_500_000n, 6), '1.5');
  assert.equal(fromUnits(10_000_000_000n, 6), '10000');
  assert.equal(fromUnits(1n, 8), '0.00000001');
});

test('precisionDecimals reads powers of ten and refuses anything else', () => {
  assert.equal(precisionDecimals(1n), 0);
  assert.equal(precisionDecimals(1_000_000n), 6);
  assert.equal(precisionDecimals(10_000_000_000n), 10);
  assert.throws(() => precisionDecimals(250n), KuruUnitsError);
  assert.throws(() => precisionDecimals(0n), KuruUnitsError);
});

test('ratioToDecimal truncates toward zero at the requested scale', () => {
  assert.equal(ratioToDecimal(1n, 3n, 6), '0.333333');
  assert.equal(ratioToDecimal(2n, 3n, 6), '0.666666');
  assert.equal(ratioToDecimal(-1n, 3n, 6), '-0.333333');
  assert.equal(ratioToDecimal(1n, -3n, 6), '-0.333333');
  assert.equal(ratioToDecimal(0n, 5n), '0');
  assert.equal(ratioToDecimal(-1n, 10n ** 20n, 6), '0'); // no "-0"
  assert.throws(() => ratioToDecimal(1n, 0n), KuruUnitsError);
});
