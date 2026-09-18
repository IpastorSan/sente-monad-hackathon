/** Decimal parsing and formatting. Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatAtoms, formatFixedAtoms, normalizeDecimal, parseAmount } from './amounts.ts';

test('normalizeDecimal canonicalises what a person types', () => {
  assert.equal(normalizeDecimal(' 250.50 '), '250.5');
  assert.equal(normalizeDecimal('.5'), '0.5');
  assert.equal(normalizeDecimal('7.'), '7');
  assert.equal(normalizeDecimal('007'), '7');
  assert.equal(normalizeDecimal('00.50'), '0.5');
  assert.equal(normalizeDecimal('0.0'), '0');
});

test('normalizeDecimal refuses signs, exponents, commas and blanks', () => {
  for (const bad of ['', ' ', '.', '-1', '+1', '1e3', '1,5', 'abc', '1.2.3', 'Infinity']) {
    assert.equal(normalizeDecimal(bad), null, bad);
  }
});

test('parseAmount scales to atoms exactly', () => {
  assert.equal(parseAmount('1000', 6), 1_000_000_000n);
  assert.equal(parseAmount('0.000001', 6), 1n);
  assert.equal(parseAmount('5', 18), 5_000_000_000_000_000_000n);
  assert.equal(parseAmount('12345678901234567890.5', 18), 12345678901234567890500000000000000000n);
});

test('parseAmount refuses more decimals than the token has, instead of rounding', () => {
  assert.equal(parseAmount('0.0000001', 6), null);
  assert.equal(parseAmount('1.5', 0), null);
  assert.equal(parseAmount('abc', 6), null);
});

test('formatAtoms groups thousands and drops trailing zeros', () => {
  assert.equal(formatAtoms(1_234_567_890n, 6), '1,234.56789');
  assert.equal(formatAtoms(1_234_567_890n, 6, { group: false }), '1234.56789');
  assert.equal(formatAtoms(5_000_000_000_000_000_000n, 18), '5');
  assert.equal(formatAtoms(0n, 6), '0');
  assert.equal(formatAtoms(-1_500_000n, 6), '-1.5');
});

test('formatFixedAtoms keeps the decimals a balance column needs', () => {
  // A zero balance still reads as money, which is what the home screen shows
  // at sign-in before anything has been funded.
  assert.equal(formatFixedAtoms(0n, 6, { places: 2 }), '0.00');
  assert.equal(formatFixedAtoms(1_204_500_000n, 6, { places: 2 }), '1,204.50');
  assert.equal(formatFixedAtoms(2_500_000_000_000_000_000n, 18, { places: 4 }), '2.5000');
  assert.equal(formatFixedAtoms(1_204_500_000n, 6, { places: 2, group: false }), '1204.50');
  assert.equal(formatFixedAtoms(-1_500_000n, 6, { places: 2 }), '-1.50');
});

test('formatFixedAtoms truncates toward zero rather than rounding a balance up', () => {
  // 0.009 AUSD shown as "0.01" claims a hundredth the user cannot spend.
  assert.equal(formatFixedAtoms(9_000n, 6, { places: 2 }), '0.00');
  assert.equal(formatFixedAtoms(1_999_999n, 6, { places: 2 }), '1.99');
  assert.equal(formatFixedAtoms(-1_999_999n, 6, { places: 2 }), '-1.99');
  assert.equal(formatFixedAtoms(999_999_999_999_999_999n, 18, { places: 4 }), '0.9999');
});

test('formatFixedAtoms defaults to the token precision and clamps silly places', () => {
  assert.equal(formatFixedAtoms(1_204_500_000n, 6), '1,204.500000');
  assert.equal(formatFixedAtoms(1_204_500_000n, 6, { places: 99 }), '1,204.500000');
  assert.equal(formatFixedAtoms(1_204_500_000n, 6, { places: 0 }), '1,204');
  assert.equal(formatFixedAtoms(42n, 0, { places: 2 }), '42');
});

test('formatAtoms without grouping reads back through parseAmount exactly', () => {
  for (const [atoms, decimals] of [
    [1n, 6],
    [1_000_000_000n, 6],
    [123_456_789_012_345_678_901n, 18],
    [42n, 0],
  ] as const) {
    assert.equal(parseAmount(formatAtoms(atoms, decimals, { group: false }), decimals), atoms);
  }
});
