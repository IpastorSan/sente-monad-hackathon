/**
 * Property tests for Kuru's unit conversions and the market-order slippage
 * bound (SEN-139). Plain node, seeded and bounded.
 *
 * `toUnits` is what turns a typed order into book integers and
 * `kuruSlippageBound` is the limit an IOC may not cross, so both are checked
 * against a bigint oracle over the whole domain rather than a grid.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { kuruSlippageBound } from './mapping.ts';
import { KuruOrderError } from './orders.ts';
import { fromUnits, KuruUnitsError, ratioToDecimal, toUnits } from './units.ts';

// Why a fixed seed: a red run in CI must reproduce locally from the same numbers.
const RUNS = { numRuns: 500, seed: 139 };
const WAD = 10n ** 18n;

const decimals = fc.integer({ min: 0, max: 24 });
const atoms = fc.bigInt({ min: 0n, max: 10n ** 30n });
const abs = (x: bigint) => (x < 0n ? -x : x);

/** `n / 10^places` as an exact decimal string, independent of the code under test. */
function exactDecimal(n: bigint, places: number, pad = 0): string {
  const digits = n.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places) + '0'.repeat(pad);
  return fraction ? `${whole}.${fraction}` : whole;
}

// ---------------------------------------------------------------------------
// units

test('toUnits(fromUnits(a)) is the identity', () => {
  fc.assert(
    fc.property(atoms, decimals, (a, d) => {
      assert.equal(toUnits(fromUnits(a, d), d), a);
    }),
    RUNS,
  );
});

test('toUnits accepts a value exactly when it fits the precision, and never rounds', () => {
  fc.assert(
    fc.property(
      atoms,
      decimals,
      fc.integer({ min: 0, max: 8 }),
      fc.integer({ min: 0, max: 4 }),
      (a, d, extra, pad) => {
        // `a` at `d + extra` places, read at `d`: it fits iff the extra digits are zero.
        const text = exactDecimal(a, d + extra, pad);
        const step = 10n ** BigInt(extra);
        if (a % step === 0n) assert.equal(toUnits(text, d), a / step);
        else assert.throws(() => toUnits(text, d), KuruUnitsError);
      },
    ),
    RUNS,
  );
});

test('ratioToDecimal truncates toward zero at the scale, and never says "-0"', () => {
  const nonZero = fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }).filter((d) => d !== 0n);
  fc.assert(
    fc.property(
      fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
      nonZero,
      fc.integer({ min: 0, max: 20 }),
      (n, d, scale) => {
        const text = ratioToDecimal(n, d, scale);
        assert.notEqual(text, '-0');
        // Oracle: |n/d| · 10^scale truncated, with the sign of the ratio.
        const magnitude = (abs(n) * 10n ** BigInt(scale)) / abs(d);
        const expected = n < 0n !== d < 0n ? -magnitude : magnitude;
        const negative = text.startsWith('-');
        const got = toUnits(negative ? text.slice(1) : text, scale);
        assert.equal(negative ? -got : got, expected);
      },
    ),
    RUNS,
  );
});

// ---------------------------------------------------------------------------
// kuruSlippageBound

const tick = fc.constantFrom(1n, 2n, 5n, 7n, 10n, 100n, 1_000n);
const pricePrecision = fc.constantFrom(1n, 100n, 10_000n, 1_000_000n, 100_000_000n);
const best = fc.bigInt({ min: 1n, max: 2n ** 32n - 2n });
/** Slippage as a WAD fraction, below 1 so a sell is boundable. */
const slippageWad = fc.bigInt({ min: 0n, max: WAD - 1n });

function bound(b: bigint, side: 'buy' | 'sell', s: bigint, t: bigint, pp: bigint): bigint {
  const pd = pp.toString().length - 1;
  return toUnits(
    kuruSlippageBound(b, side, fromUnits(s, 18), { pricePrecision: pp, tickSize: t }),
    pd,
  );
}

test('a buy bound is on a tick and never above best · (1 + s)', () => {
  fc.assert(
    fc.property(best, slippageWad, tick, pricePrecision, (b, s, t, pp) => {
      const limit = bound(b, 'buy', s, t, pp);
      assert.equal(limit % t, 0n);
      assert.ok(limit * WAD <= b * (WAD + s), `buy ${limit} over ${b}·(1+${s})`);
      // It gives away at most one tick plus one unit of rounding.
      assert.ok((limit + t + 1n) * WAD > b * (WAD + s));
    }),
    RUNS,
  );
});

test('a sell bound is on a tick and never below best · (1 − s)', () => {
  fc.assert(
    fc.property(best, slippageWad, tick, pricePrecision, (b, s, t, pp) => {
      const limit = bound(b, 'sell', s, t, pp);
      assert.equal(limit % t, 0n);
      assert.ok(limit * WAD >= b * (WAD - s), `sell ${limit} under ${b}·(1−${s})`);
      assert.ok((limit - t - 1n) * WAD < b * (WAD - s));
    }),
    RUNS,
  );
});

test('with best on a tick, the bound brackets best and widens monotonically with slippage', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 2n ** 22n }),
      slippageWad,
      slippageWad,
      tick,
      pricePrecision,
      (ticks, s1, s2, t, pp) => {
        const b = ticks * t;
        const [lo, hi] = s1 <= s2 ? [s1, s2] : [s2, s1];
        assert.ok(bound(b, 'buy', lo, t, pp) >= b);
        assert.ok(bound(b, 'sell', lo, t, pp) <= b);
        assert.ok(bound(b, 'buy', hi, t, pp) >= bound(b, 'buy', lo, t, pp));
        assert.ok(bound(b, 'sell', hi, t, pp) <= bound(b, 'sell', lo, t, pp));
      },
    ),
    RUNS,
  );
});

test('a sell at 100% slippage or more is refused rather than bounded at zero', () => {
  fc.assert(
    fc.property(best, fc.bigInt({ min: WAD, max: 10n * WAD }), tick, (b, s, t) => {
      assert.throws(
        () => kuruSlippageBound(b, 'sell', fromUnits(s, 18), { pricePrecision: 100n, tickSize: t }),
        KuruOrderError,
      );
    }),
    { ...RUNS, numRuns: 100 },
  );
});
