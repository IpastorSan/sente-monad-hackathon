/**
 * Property tests for Perpl's decimal <-> scaled-integer conversions (SEN-139).
 *
 * Every Perpl price and size on the wire goes through `toScaled`/`fromScaled`,
 * so the examples in `decimal.test.ts` are backed here by a bigint oracle over
 * the whole domain: a decimal string is generated FROM an exact integer and a
 * scale, and the conversions must land back on that integer. Seeded and
 * bounded so a run is deterministic and cheap.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { PrecisionError, divRound, fromScaled, toScaled } from './decimal.ts';

// Why a fixed seed: a red run in CI must reproduce locally from the same numbers.
const RUNS = { numRuns: 500, seed: 139 };

const decimals = fc.integer({ min: 0, max: 24 });
const scaled = fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n });
const abs = (x: bigint) => (x < 0n ? -x : x);

/**
 * `atoms / 10^places` written out exactly, plus `pad` trailing zeros. Built
 * with plain string slicing, independently of `fromScaled`, so it can serve
 * as the oracle's input without sharing a bug with the code under test.
 */
function exactDecimal(atoms: bigint, places: number, pad = 0): string {
  const negative = atoms < 0n;
  const digits = abs(atoms)
    .toString()
    .padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places) + '0'.repeat(pad);
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Floor division, the oracle for `'floor'` rounding. */
function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

test('fromScaled then toScaled is the identity at any scale', () => {
  fc.assert(
    fc.property(scaled, decimals, (n, d) => {
      assert.equal(toScaled(fromScaled(n, d), d), n);
    }),
    RUNS,
  );
});

test('fromScaled is canonical: no trailing zeros, no bare dot, never "-0"', () => {
  fc.assert(
    fc.property(scaled, decimals, (n, d) => {
      assert.match(fromScaled(n, d), /^(-?[1-9]\d*|-?0\.\d*[1-9]|-?[1-9]\d*\.\d*[1-9]|0)$/);
    }),
    RUNS,
  );
});

test('toScaled reads any exact decimal, trailing zeros included, back to its integer', () => {
  fc.assert(
    fc.property(scaled, decimals, fc.integer({ min: 0, max: 6 }), (n, d, pad) => {
      assert.equal(toScaled(exactDecimal(n, d, pad), d), n);
    }),
    RUNS,
  );
});

test('rounding matches a bigint oracle: floor <= value <= ceil, exact refuses in between', () => {
  // A value with `extra` more places than the venue keeps, so it may not fit.
  fc.assert(
    fc.property(scaled, decimals, fc.integer({ min: 1, max: 8 }), (n, d, extra) => {
      const text = exactDecimal(n, d + extra);
      const step = 10n ** BigInt(extra);
      const floor = floorDiv(n, step);
      const fits = n % step === 0n;
      assert.equal(toScaled(text, d, 'floor'), floor);
      assert.equal(toScaled(text, d, 'ceil'), fits ? floor : floor + 1n);
      if (fits) assert.equal(toScaled(text, d), floor);
      else assert.throws(() => toScaled(text, d), PrecisionError);
    }),
    RUNS,
  );
});

test('divRound is the nearest integer, ties away from zero', () => {
  const nonZero = fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }).filter((d) => d !== 0n);
  fc.assert(
    fc.property(scaled, nonZero, (n, d) => {
      const q = divRound(n, d);
      // |n/d - q| <= 1/2, i.e. |2(n - q·d)| <= |d|.
      const twiceError = abs(2n * (n - q * d));
      assert.ok(twiceError <= abs(d), `${n}/${d} -> ${q}`);
      // On an exact tie the magnitude goes up, never toward zero.
      if (twiceError === abs(d)) assert.ok(abs(q * d) > abs(n), `tie ${n}/${d} -> ${q}`);
    }),
    RUNS,
  );
});
