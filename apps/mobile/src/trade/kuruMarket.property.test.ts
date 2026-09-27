/**
 * The phone's IOC price bound against the adapter's, over random inputs
 * (SEN-139). Plain node, seeded and bounded.
 *
 * `kuruMarket.test.ts` pins `worstPriceUnits` to `kuruSlippageBound` on a
 * grid; the verifier refuses any trade whose limit differs from the phone's
 * figure, so a disagreement off the grid would block trades (or, worse, let
 * the two sides agree on a wider bound than the user set). Here the whole
 * `(best, bps, tick, side)` domain is sampled instead.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromUnits, kuruSlippageBound, precisionDecimals, toUnits } from '@sente/venues/kuru';
import fc from 'fast-check';

import { worstPriceUnits } from './kuruMarket.ts';

// Why a fixed seed: a red run in CI must reproduce locally from the same numbers.
const RUNS = { numRuns: 1_000, seed: 139 };

test('worstPriceUnits equals kuruSlippageBound for any best, bps, tick and side', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 2n ** 32n - 1n }),
      fc.integer({ min: 0, max: 9_999 }),
      fc.bigInt({ min: 1n, max: 10_000n }),
      fc.constantFrom('buy' as const, 'sell' as const),
      fc.constantFrom(1n, 100n, 10_000n, 1_000_000n, 100_000_000n),
      (best, bps, tick, side, pricePrecision) => {
        const adapter = kuruSlippageBound(best, side, fromUnits(BigInt(bps), 4), {
          pricePrecision,
          tickSize: tick,
        });
        assert.equal(
          worstPriceUnits(best, bps, tick, side),
          toUnits(adapter, precisionDecimals(pricePrecision)),
        );
      },
    ),
    RUNS,
  );
});

test('the phone bound is on a tick and inside best · (1 ± bps)', () => {
  const BPS = 10_000n;
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 2n ** 32n - 1n }),
      fc.integer({ min: 0, max: 9_999 }),
      fc.bigInt({ min: 1n, max: 10_000n }),
      (best, bps, tick) => {
        const b = BigInt(bps);
        const buy = worstPriceUnits(best, bps, tick, 'buy');
        const sell = worstPriceUnits(best, bps, tick, 'sell');
        assert.equal(buy % tick, 0n);
        assert.equal(sell % tick, 0n);
        assert.ok(buy * BPS <= best * (BPS + b), `buy ${buy} pays more than ${bps} bps`);
        assert.ok(sell * BPS >= best * (BPS - b), `sell ${sell} takes less than ${bps} bps`);
      },
    ),
    RUNS,
  );
});
