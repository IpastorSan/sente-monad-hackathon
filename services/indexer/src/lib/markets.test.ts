/**
 * Tests for the daily aggregates, and for the VWAP bug they hid.
 *
 * `MarketDay.vwapPrice` was `volumeUsd.div(baseVolume, 18)`. bignumber.js
 * reads the second argument of `div` as the numeric **base** of the operands,
 * not as a decimal-place count, so every VWAP the indexer ever wrote was the
 * base-18 reinterpretation of two base-10 numerals. On the live MON-USDC fill
 * of docs/indexer.md §proven — 317.73742494 MON for $9.841599, a price of
 * 0.030974 — it produced 0.009867. Worse, an operand carrying an exponent
 * (bignumber.js switches to exponential notation past 21 digits, which a
 * day's volume on an 18-decimal base reaches easily) is not a valid base-18
 * numeral at all, and the answer is NaN.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BigDecimal } from 'envio';
import { recordMarketDay, type MarketDayInput } from './markets.ts';
import type { Ctx } from './common.ts';

/** The §proven Kuru fill: tx 0x9d7fbce1…, block 61406913, MON-USDC. */
const PROVEN_FILL = {
  marketId: 'kuru-0xfdbe356828c8f5a5d5ed4f69dde0816f4058ef61',
  notional: '9.841599',
  base: '317.73742494',
  price: '0.030974',
  timestampSec: 1_757_500_000,
};

type MarketDayRow = {
  readonly id: string;
  readonly tradeCount: number;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly volumeUsd: BigDecimal;
  readonly baseVolume: BigDecimal;
  readonly highPrice: BigDecimal | undefined;
  readonly lowPrice: BigDecimal | undefined;
  readonly vwapPrice: BigDecimal | undefined;
  readonly activeAccountIds: readonly string[];
};

function fakeContext(): { context: Ctx; days: Map<string, MarketDayRow> } {
  const days = new Map<string, MarketDayRow>();
  const context = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    isPreload: false,
    chain: { id: 10143, isRealtime: false },
    MarketDay: {
      get: (id: string): Promise<MarketDayRow | undefined> => Promise.resolve(days.get(id)),
      getOrThrow: (id: string): Promise<MarketDayRow> => {
        const row = days.get(id);
        if (row === undefined) throw new Error(`no day ${id}`);
        return Promise.resolve(row);
      },
      getWhere: (): Promise<MarketDayRow[]> => Promise.resolve([]),
      set: (row: MarketDayRow): void => {
        days.set(row.id, row);
      },
    },
  };
  return { context: context as unknown as Ctx, days };
}

function fill(overrides: Partial<MarketDayInput> = {}): MarketDayInput {
  return {
    marketId: PROVEN_FILL.marketId,
    isBuy: true,
    notionalBd: new BigDecimal(PROVEN_FILL.notional),
    baseBd: new BigDecimal(PROVEN_FILL.base),
    priceBd: new BigDecimal(PROVEN_FILL.price),
    accountIds: ['kuru-62', 'kuru-47'],
    timestampSec: PROVEN_FILL.timestampSec,
    ...overrides,
  };
}

test('the VWAP of the proven live fill is its price, not a base-18 reading of it', async () => {
  const { context, days } = fakeContext();

  await recordMarketDay(context, fill());

  const [day] = [...days.values()];
  assert.notEqual(day, undefined);
  const vwap = day?.vwapPrice;
  assert.notEqual(vwap, undefined, 'a day with base volume has a VWAP');
  // One fill, so the VWAP is that fill's price — to the atom of rounding the
  // floored quote notional leaves behind, and nowhere near the 0.009867 that
  // `div(x, 18)` produced.
  assert.equal(vwap?.toFixed(6), '0.030974');
  assert.equal(vwap?.decimalPlaces(), 18);
});

test('a day large enough to print in exponential notation still has a VWAP', async () => {
  // bignumber.js formats past 21 significant digits as "1.2e+25"; fed to
  // `div(x, 18)` as a base-18 numeral that is NaN, and a NaN written to a
  // BigDecimal column is a row the leaderboard cannot read.
  const { context, days } = fakeContext();

  await recordMarketDay(
    context,
    fill({
      notionalBd: new BigDecimal('1e25'),
      baseBd: new BigDecimal('1e23'),
      priceBd: new BigDecimal('100'),
    }),
  );

  const [day] = [...days.values()];
  assert.equal(day?.vwapPrice?.toFixed(0), '100');
  assert.equal(day?.vwapPrice?.isNaN(), false);
});

test('a second fill makes the VWAP a volume weighting, not an average of prices', async () => {
  const { context, days } = fakeContext();

  // 1 base at $10, then 3 base at $2 → 4 base for $16, VWAP $4 (not $6).
  await recordMarketDay(
    context,
    fill({
      notionalBd: new BigDecimal('10'),
      baseBd: new BigDecimal('1'),
      priceBd: new BigDecimal('10'),
    }),
  );
  await recordMarketDay(
    context,
    fill({
      isBuy: false,
      notionalBd: new BigDecimal('6'),
      baseBd: new BigDecimal('3'),
      priceBd: new BigDecimal('2'),
      accountIds: ['kuru-62', 'kuru-99'],
    }),
  );

  const [day] = [...days.values()];
  assert.equal(day?.tradeCount, 2);
  assert.equal(day?.buyCount, 1);
  assert.equal(day?.sellCount, 1);
  assert.equal(day?.vwapPrice?.toFixed(0), '4');
  assert.equal(day?.highPrice?.toFixed(0), '10');
  assert.equal(day?.lowPrice?.toFixed(0), '2');
  // Both legs of both matches, deduplicated.
  assert.deepEqual([...(day?.activeAccountIds ?? [])], ['kuru-62', 'kuru-47', 'kuru-99']);
});

test('a day with no base volume has no VWAP rather than a division by zero', async () => {
  const { context, days } = fakeContext();

  await recordMarketDay(context, fill({ baseBd: new BigDecimal('0'), notionalBd: new BigDecimal('0') }));

  const [day] = [...days.values()];
  assert.equal(day?.vwapPrice, undefined);
});
