/**
 * Property tests for Perpl's slippage bound and book walk (SEN-139). Plain
 * node, seeded and bounded.
 *
 * `perplSlippageBoundScaled` is the price an immediate order may not cross,
 * so it is checked against a bigint oracle: the clamp never widens what was
 * asked for, and the rounding only ever tightens it. `quoteFromBook` is
 * checked for what a caller relies on: it cannot fill more than was asked or
 * more than the book holds, the order the socket sends levels in is
 * irrelevant, and a buy's average is never better than the best ask.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import type { Side } from '../types.ts';
import { toScaled } from './decimal.ts';
import { perplSlippageBoundScaled, quoteFromBook, type ResolvedMarket } from './public.ts';
import { MT, type PerplL2Book, type PerplMarket } from './wire.ts';

// Why a fixed seed: a red run in CI must reproduce locally from the same numbers.
const RUNS = { numRuns: 500, seed: 139 };
const MICRO = 1_000_000n;

/** Only the fields the two functions read; the rest of a market is irrelevant here. */
function market(maxSlippageBps: number, pd = 1, sd = 5, takerFee = 690): ResolvedMarket {
  return {
    raw: {
      order_max_market_slippage_bps: maxSlippageBps,
      config: { taker_fee: takerFee },
    } as unknown as PerplMarket,
    symbol: 'BTC-PERP',
    pd,
    sd,
    cd: 6,
    collateral: 'AUSD',
  };
}

// ---------------------------------------------------------------------------
// perplSlippageBoundScaled

const mark = fc.bigInt({ min: 1n, max: 10n ** 12n });
const capBps = fc.integer({ min: 0, max: 10_000 });
/** A requested slippage in micros, written as a decimal with up to 9 places. */
const requestedNanos = fc.bigInt({ min: 0n, max: 2n * 10n ** 9n });
const side = fc.constantFrom<Side>('buy', 'sell');

function nanosText(nanos: bigint): string {
  const digits = nanos.toString().padStart(10, '0');
  return `${digits.slice(0, -9)}.${digits.slice(-9)}`;
}

test('the clamp never widens: micros is the request floored, capped at the market maximum', () => {
  fc.assert(
    fc.property(mark, side, requestedNanos, capBps, (m, s, nanos, cap) => {
      const { micros } = perplSlippageBoundScaled(m, s, nanosText(nanos), market(cap));
      const asked = nanos / 1_000n; // floored to micros
      const ceiling = BigInt(cap) * 100n;
      assert.equal(micros, asked < ceiling ? asked : ceiling);
    }),
    RUNS,
  );
});

test('a buy bound never exceeds mark · (1 + micros) and a sell bound never undercuts mark · (1 − micros)', () => {
  fc.assert(
    fc.property(mark, side, requestedNanos, capBps, (m, s, nanos, cap) => {
      const { price, micros } = perplSlippageBoundScaled(m, s, nanosText(nanos), market(cap));
      if (s === 'buy') {
        assert.ok(price * MICRO <= m * (MICRO + micros));
        assert.ok((price + 1n) * MICRO > m * (MICRO + micros)); // at most one unit tighter
        assert.ok(price >= m);
      } else {
        assert.ok(price * MICRO >= m * (MICRO - micros));
        assert.ok((price - 1n) * MICRO < m * (MICRO - micros));
        assert.ok(price <= m);
      }
    }),
    RUNS,
  );
});

test('more slippage never gives a tighter bound', () => {
  fc.assert(
    fc.property(mark, side, requestedNanos, requestedNanos, capBps, (m, s, a, b, cap) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const bound = (n: bigint) => perplSlippageBoundScaled(m, s, nanosText(n), market(cap)).price;
      if (s === 'buy') assert.ok(bound(hi) >= bound(lo));
      else assert.ok(bound(hi) <= bound(lo));
    }),
    RUNS,
  );
});

// ---------------------------------------------------------------------------
// quoteFromBook

const level = fc.record({
  p: fc.integer({ min: 1, max: 2_000_000 }),
  s: fc.integer({ min: 0, max: 5_000_000 }),
});

/** An uncrossed book: every bid strictly below every ask. */
const book = fc
  .record({
    bid: fc.array(level, { maxLength: 8 }),
    ask: fc.array(level, { maxLength: 8 }),
    split: fc.integer({ min: 1, max: 2_000_000 }),
  })
  .map(({ bid, ask, split }) => ({
    bid: bid.map((l) => ({ p: 1 + (l.p % split), s: l.s, o: 1 })),
    ask: ask.map((l) => ({ p: split + 1 + l.p, s: l.s, o: 1 })),
  }));

function l2(levels: { bid: PerplL2Book['bid']; ask: PerplL2Book['ask'] }): PerplL2Book {
  return { mt: MT.L2BookSnapshot, sid: 1, at: { t: 1 }, bid: levels.bid, ask: levels.ask };
}

test('a quote fills min(size, book depth) and ignores the order levels arrive in', () => {
  const m = market(500);
  fc.assert(
    fc.property(book, side, fc.bigInt({ min: 1n, max: 10n ** 8n }), fc.nat(), (b, s, size, k) => {
      const request = { symbol: m.symbol, side: s, size: (Number(size) / 1e5).toFixed(5) };
      const quote = quoteFromBook(l2(b), m, request);
      const taken = s === 'buy' ? b.ask : b.bid;
      const depth = taken.reduce((sum, l) => sum + BigInt(l.s), 0n);
      assert.equal(toScaled(quote.fillableSize, m.sd), size < depth ? size : depth);

      // Rotating each side must not change a single figure.
      const rotate = <T>(xs: T[]) =>
        xs.length ? [...xs.slice(k % xs.length), ...xs.slice(0, k % xs.length)] : xs;
      const again = quoteFromBook(l2({ bid: rotate(b.bid), ask: rotate(b.ask) }), m, request);
      assert.deepEqual(again, quote);
    }),
    RUNS,
  );
});

test('an average is never better than the touch, and slippage against an uncrossed mid is never negative', () => {
  const m = market(500);
  fc.assert(
    fc.property(book, side, fc.bigInt({ min: 1n, max: 10n ** 8n }), (b, s, size) => {
      const request = { symbol: m.symbol, side: s, size: (Number(size) / 1e5).toFixed(5) };
      const quote = quoteFromBook(l2(b), m, request);
      const taken = (s === 'buy' ? b.ask : b.bid).filter((l) => l.s > 0);
      if (taken.length === 0) {
        assert.equal(quote.fillableSize, '0');
        return;
      }
      const prices = taken.map((l) => l.p);
      // Average carries 4 extra places (`pd + 4`); compare in those units.
      const avg = toScaled(quote.averagePrice, m.pd + 4);
      const touch = BigInt(s === 'buy' ? Math.min(...prices) : Math.max(...prices)) * 10_000n;
      if (s === 'buy') assert.ok(avg >= touch, `buy avg ${avg} under best ask ${touch}`);
      else assert.ok(avg <= touch, `sell avg ${avg} over best bid ${touch}`);
      assert.ok(!quote.slippage.startsWith('-'), `negative slippage ${quote.slippage}`);
    }),
    RUNS,
  );
});
