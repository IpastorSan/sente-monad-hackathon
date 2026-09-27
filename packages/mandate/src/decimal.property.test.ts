/**
 * Property tests for the mandate's exact decimal comparison (SEN-139).
 *
 * `compareDecimal` decides whether an order is over the notional cap, so it
 * is checked against a bigint oracle: both sides are generated FROM exact
 * integers at independent scales, and the comparison must agree with
 * comparing those integers brought to a common scale. Seeded and bounded.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { compareDecimal, isDecimal } from './decimal.ts';

// Why a fixed seed: a red run in CI must reproduce locally from the same numbers.
const RUNS = { numRuns: 1_000, seed: 139 };

/** `n / 10^places` in canonical form (no leading zeros), plus `pad` trailing zeros. */
function exactDecimal(n: bigint, places: number, pad = 0): string {
  const digits = n.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places) + '0'.repeat(pad);
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A value near a cap, so equal and off-by-one-atom pairs come up often. */
const amount = fc.record({
  n: fc.oneof(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.bigInt({ min: 249_000n, max: 251_000n })),
  places: fc.integer({ min: 0, max: 20 }),
  pad: fc.integer({ min: 0, max: 3 }),
});

test('compareDecimal agrees with a bigint comparison at a common scale', () => {
  fc.assert(
    fc.property(amount, amount, (a, b) => {
      const scale = Math.max(a.places, b.places);
      const x = a.n * 10n ** BigInt(scale - a.places);
      const y = b.n * 10n ** BigInt(scale - b.places);
      const expected = x < y ? -1 : x > y ? 1 : 0;
      const left = exactDecimal(a.n, a.places, a.pad);
      const right = exactDecimal(b.n, b.places, b.pad);
      assert.ok(isDecimal(left) && isDecimal(right));
      assert.equal(compareDecimal(left, right), expected, `${left} vs ${right}`);
      assert.equal(compareDecimal(right, left), -expected || 0);
    }),
    RUNS,
  );
});

test('one atom above a cap compares greater at any extra precision', () => {
  fc.assert(
    fc.property(amount, fc.integer({ min: 1, max: 20 }), (cap, extra) => {
      const places = cap.places + extra;
      const scaled = cap.n * 10n ** BigInt(extra);
      const capText = exactDecimal(cap.n, cap.places, cap.pad);
      assert.equal(compareDecimal(exactDecimal(scaled + 1n, places), capText), 1);
      if (scaled > 0n) assert.equal(compareDecimal(exactDecimal(scaled - 1n, places), capText), -1);
    }),
    RUNS,
  );
});
