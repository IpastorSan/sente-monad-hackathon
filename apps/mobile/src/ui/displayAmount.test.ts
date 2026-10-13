/** SEN-215: token amounts show at most four places. Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayAmount } from './displayAmount.ts';

test('rounds half-up to four places and drops trailing zeros', () => {
  assert.equal(displayAmount('0.013920066'), '0.0139');
  assert.equal(displayAmount('0.000159'), '0.0002');
  assert.equal(displayAmount('2.5'), '2.5');
  assert.equal(displayAmount('2.5000'), '2.5');
  assert.equal(displayAmount('0.00005'), '0.0001');
  assert.equal(displayAmount('0.99996'), '1');
  assert.equal(displayAmount('180'), '180');
});

test('a non-zero amount below four places says so instead of reading 0', () => {
  assert.equal(displayAmount('0.00004'), '<0.0001');
  assert.equal(displayAmount('-0.00004'), '-<0.0001');
  assert.equal(displayAmount('0'), '0');
  assert.equal(displayAmount('0.0000'), '0');
});

test('keeps the minimum places it is asked for, and groups thousands', () => {
  assert.equal(displayAmount('0', { minPlaces: 2 }), '0.00');
  assert.equal(displayAmount('1204.5', { minPlaces: 2, maxPlaces: 2 }), '1,204.50');
  assert.equal(displayAmount('1234567.12345'), '1,234,567.1235');
  assert.equal(displayAmount('1234567.12345', { group: false }), '1234567.1235');
  assert.equal(displayAmount('1,204.50'), '1,204.5');
});

test('keeps the sign it was given, and leaves anything else untouched', () => {
  assert.equal(displayAmount('-0.013920066'), '-0.0139');
  assert.equal(displayAmount('−2.50'), '−2.5');
  assert.equal(displayAmount('+1.23456'), '1.2346');
  assert.equal(displayAmount('—'), '—');
  assert.equal(displayAmount('1e-7'), '1e-7');
  assert.equal(displayAmount(''), '');
});
