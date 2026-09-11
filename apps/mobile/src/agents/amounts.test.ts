/** Decimal parsing and formatting. Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatAtoms, normalizeDecimal, parseAmount } from './amounts.ts';

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
