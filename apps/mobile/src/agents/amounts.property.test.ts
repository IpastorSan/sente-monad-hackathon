/**
 * Property tests for the phone's typed-amount parsing and balance formatting
 * (SEN-139). Plain node, seeded and bounded.
 *
 * Every amount a person types into the mandate form or the fund sheet goes
 * through `parseAmount`, and every balance on screen through
 * `formatFixedAtoms`, so both are checked against a bigint oracle: the typed
 * string is generated FROM an exact integer, dressed the ways a person might
 * type it, and must parse back to that integer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { formatAtoms, formatFixedAtoms, normalizeDecimal, parseAmount } from './amounts.ts';

// Why a fixed seed: a red run in CI must reproduce locally from the same numbers.
const RUNS = { numRuns: 500, seed: 139 };

const decimals = fc.integer({ min: 0, max: 24 });
const atoms = fc.bigInt({ min: 0n, max: 10n ** 30n });
const signed = fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n });

/** `n / 10^places` as an exact decimal string, independent of the code under test. */
function exactDecimal(n: bigint, places: number): string {
  const digits = n.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return fraction ? `${whole}.${fraction}` : whole;
}

/** The harmless ways a person types the same number: spaces, leading and trailing zeros. */
const dressing = fc.record({
  before: fc.constantFrom('', ' ', '  '),
  after: fc.constantFrom('', ' '),
  leadingZeros: fc.integer({ min: 0, max: 3 }),
  trailingZeros: fc.integer({ min: 0, max: 3 }),
});

function dress(text: string, d: typeof dressing extends fc.Arbitrary<infer T> ? T : never) {
  const withTrailing = d.trailingZeros
    ? `${text}${text.includes('.') ? '' : '.'}${'0'.repeat(d.trailingZeros)}`
    : text;
  return `${d.before}${'0'.repeat(d.leadingZeros)}${withTrailing}${d.after}`;
}

test('formatAtoms (ungrouped) reads back through parseAmount exactly', () => {
  fc.assert(
    fc.property(atoms, decimals, (a, d) => {
      assert.equal(parseAmount(formatAtoms(a, d, { group: false }), d), a);
    }),
    RUNS,
  );
});

test('parseAmount reads any dressing of an exact amount back to its atoms', () => {
  fc.assert(
    fc.property(atoms, decimals, dressing, (a, d, how) => {
      assert.equal(parseAmount(dress(exactDecimal(a, d), how), d), a);
    }),
    RUNS,
  );
});

test('parseAmount refuses, never rounds, a value finer than the token', () => {
  fc.assert(
    fc.property(atoms, decimals, fc.integer({ min: 1, max: 6 }), (a, d, extra) => {
      const text = exactDecimal(a, d + extra);
      const step = 10n ** BigInt(extra);
      assert.equal(parseAmount(text, d), a % step === 0n ? a / step : null);
    }),
    RUNS,
  );
});

test('normalizeDecimal is idempotent and keeps the value', () => {
  fc.assert(
    fc.property(atoms, decimals, dressing, (a, d, how) => {
      const once = normalizeDecimal(dress(exactDecimal(a, d), how));
      assert.notEqual(once, null);
      assert.equal(normalizeDecimal(once!), once);
      assert.equal(parseAmount(once!, d), a);
    }),
    RUNS,
  );
});

test('formatFixedAtoms shows exactly `places` decimals, truncated toward zero, never "-0"', () => {
  fc.assert(
    fc.property(signed, decimals, fc.integer({ min: 0, max: 30 }), (a, d, places) => {
      const text = formatFixedAtoms(a, d, { group: false, places });
      const shown = Math.min(places, d);
      assert.match(text, shown > 0 ? new RegExp(`^-?\\d+\\.\\d{${shown}}$`) : /^-?\d+$/);

      // Oracle: |a| truncated to `shown` places, carrying the sign of what is shown.
      const drop = 10n ** BigInt(d - shown);
      const magnitude = (a < 0n ? -a : a) / drop;
      const negative = text.startsWith('-');
      assert.equal(parseAmount(negative ? text.slice(1) : text, shown), magnitude);
      assert.equal(negative, a < 0n && magnitude > 0n, `sign of ${text} for ${a}`);
    }),
    RUNS,
  );
});
