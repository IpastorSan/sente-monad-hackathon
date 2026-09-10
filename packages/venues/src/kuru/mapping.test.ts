/**
 * Wire -> Sente mapping. The fixtures are real responses from
 * api.testnet.kuru.io and gateway.testnet.kuru.io captured on 2026-09-10,
 * trimmed to the fields the mapper reads.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ApiCandles, ApiDepth, ApiMarket, ApiOpenOrder } from './api.ts';
import { KURU_TESTNET_MARKETS, type KuruMarketConfig } from './constants.ts';
import {
  bucketStart,
  simulateQuote,
  toDepth,
  toKlines,
  toMarket,
  toOpenOrder,
  toPlacedOrder,
} from './mapping.ts';
import type { KuruMarketParams, KuruOrderOutcome } from './orders.ts';

const market = (symbol: string): KuruMarketConfig => {
  const found = KURU_TESTNET_MARKETS.find((m) => m.symbol === symbol);
  assert.ok(found, symbol);
  return found;
};
const MON_USDC = market('MON-USDC');
const CBBTC_USDC = market('cbBTC-USDC');

/** MON/USDC as `getMarketParams()` returns it on testnet. */
const MON_PARAMS: KuruMarketParams = {
  pricePrecision: 1_000_000n,
  sizePrecision: 100_000_000n,
  tickSize: 1n,
  minQuoteNotional: 10_000_000n,
  maxQuoteNotional: 5_000_000_000_000n,
  takerFeePps: 7000n,
  makerFeePps: 4000n,
};

test('toMarket: precisions become decimal increments, the notional floor comes through', () => {
  const api: ApiMarket = {
    marketAddress: '0xfdbe356828c8f5a5d5ed4f69dde0816f4058ef61',
    symbol: 'MONUSDC',
    baseToken: {
      tokenAddress: '0x0000000000000000000000000000000000000000',
      symbol: 'MON',
      decimals: 18,
    },
    quoteToken: {
      tokenAddress: '0xee0722ead54f1b4fe97be399be43bc0226a6f97e',
      symbol: 'USDC',
      decimals: 6,
    },
    status: 'active',
    pricePrecision: '1000000',
    sizePrecision: '100000000',
    tickSize: '1',
    minQuoteNotionalX18: '10000000000000000000',
    takerFeePps: 7000,
    makerFeePps: 4000,
  };
  assert.deepEqual(toMarket(api, MON_USDC), {
    symbol: 'MON-USDC',
    kind: 'spot',
    base: 'MON',
    quote: 'USDC',
    tickSize: '0.000001',
    stepSize: '0.00000001',
    minSize: '0.00000001',
    minNotional: '10',
    venueSymbol: 'MONUSDC',
  });
});

test('toDepth: book units to decimals, best first, clamped, sequence kept', () => {
  const api: ApiDepth = {
    symbol: 'MONUSDC',
    market_id: '0xfdbe356828c8f5a5d5ed4f69dde0816f4058ef61',
    market_seq: 26,
    bids: [
      { price: '28968', total_base: '31700000000' },
      { price: '28901', total_base: '35000000000' },
      { price: '11730', total_base: '100000000000' },
    ],
    asks: [{ price: '30968', total_base: '31773117412' }],
  };
  const depth = toDepth(api, MON_USDC, 2, 1234);
  assert.deepEqual(depth.bids, [
    { price: '0.028968', size: '317' },
    { price: '0.028901', size: '350' },
  ]);
  assert.deepEqual(depth.asks, [{ price: '0.030968', size: '317.73117412' }]);
  assert.equal(depth.sequence, 26);
  assert.equal(depth.timestamp, 1234);
});

/** Six real hourly MON/USDC candles. */
const HOURLY: ApiCandles = {
  t: [1789045200, 1789048800, 1789052400, 1789056000, 1789059600, 1789063200],
  o: ['30900', '28933', '28928', '30938', '28950', '30962'],
  h: ['30933', '30920', '30938', '30950', '30962', '30968'],
  l: ['28902', '28902', '28902', '28902', '28902', '28964'],
  c: ['28933', '28926', '30938', '28950', '30962', '28968'],
  v: [
    '22488207000000000000',
    '15629379000000000000',
    '13677468000000000000',
    '13678326000000000000',
    '13682220000000000000',
    '5865468000000000000',
  ],
};

test('toKlines at a native interval is a straight conversion', () => {
  const klines = toKlines(HOURLY, MON_USDC, '1h');
  assert.equal(klines.length, 6);
  assert.deepEqual(
    { ...klines[0], volume: undefined },
    {
      openTime: 1789045200_000,
      closeTime: 1789045200_000 + 3_600_000 - 1,
      open: '0.0309',
      high: '0.030933',
      low: '0.028902',
      close: '0.028933',
      volume: undefined,
      quoteVolume: '22.488207',
    },
  );
});

test('toKlines aggregates 1h into UTC-aligned 4h candles', () => {
  const klines = toKlines(HOURLY, MON_USDC, '4h');
  // 1789045200..1789052400 share the 4h bucket starting 1789041600;
  // 1789056000 opens the next one.
  assert.deepEqual(
    klines.map((k) => ({ ...k, volume: undefined })),
    [
      {
        openTime: 1789041600_000,
        closeTime: 1789041600_000 + 14_400_000 - 1,
        open: '0.0309', // first candle's open
        high: '0.030938',
        low: '0.028902',
        close: '0.030938', // last candle's close
        volume: undefined,
        quoteVolume: '51.795054',
      },
      {
        openTime: 1789056000_000,
        closeTime: 1789056000_000 + 14_400_000 - 1,
        open: '0.030938',
        high: '0.030968',
        low: '0.028902',
        close: '0.028968',
        volume: undefined,
        quoteVolume: '33.226014',
      },
    ],
  );
});

test('toKlines estimates base volume at each candle’s typical price', () => {
  // Independent float computation of sum(v / ((h + l + c) / 3)).
  const expected = HOURLY.t.slice(0, 3).reduce((sum, _t, i) => {
    const typical = (Number(HOURLY.h[i]) + Number(HOURLY.l[i]) + Number(HOURLY.c[i])) / 3 / 1e6;
    return sum + Number(HOURLY.v[i]) / 1e18 / typical;
  }, 0);
  const [first] = toKlines(HOURLY, MON_USDC, '4h');
  assert.ok(Math.abs(Number(first!.volume) - expected) < 1e-6, `${first!.volume} vs ${expected}`);
});

test('weekly buckets open on Monday 00:00 UTC', () => {
  // 2026-09-10 is a Thursday; its week opened Monday 2026-09-07.
  assert.equal(bucketStart(Date.UTC(2026, 8, 10, 15, 30), '1w'), Date.UTC(2026, 8, 7));
  assert.equal(bucketStart(Date.UTC(2026, 8, 7), '1w'), Date.UTC(2026, 8, 7));
  assert.equal(bucketStart(Date.UTC(2026, 8, 6, 23, 59), '1w'), Date.UTC(2026, 7, 31));
});

test('toOpenOrder: the id binds slot and order id; size is the remaining size', () => {
  const api: ApiOpenOrder = {
    orderId: '23818',
    marketAddress: '0x5bdea6f9f9aba34f4ecb9b865646a792b835ef7f',
    slotIdx: 0,
    symbol: 'CBBTCUSDC',
    isBuy: true,
    price: '7854647',
    remainingSize: '1000000',
    minSizeAfterBlock: null,
    clientOrderId: '0x18d3a457c4234e28000000000000000000000000000000000000000000001cf4',
  };
  assert.deepEqual(toOpenOrder(api, CBBTC_USDC, 99), {
    id: '0:23818',
    clientOrderId: '0x18d3a457c4234e28000000000000000000000000000000000000000000001cf4',
    symbol: 'cbBTC-USDC',
    side: 'buy',
    type: 'limit',
    status: 'open',
    price: '78546.47',
    size: '0.01',
    filledSize: '0',
    createdAt: 99,
    updatedAt: 99,
  });
});

/** A toy book with round numbers, so every expected value is checkable by hand. */
const BOOK = {
  bids: [{ price: 900_000n, size: 100n * 10n ** 8n }], // 100 @ 0.90
  asks: [
    { price: 1_000_000n, size: 100n * 10n ** 8n }, // 100 @ 1.00
    { price: 1_100_000n, size: 100n * 10n ** 8n }, // 100 @ 1.10
  ],
};

test('simulateQuote walks the asks for a buy', () => {
  const quote = simulateQuote({
    symbol: 'MON-USDC',
    side: 'buy',
    size: '150',
    params: MON_PARAMS,
    quoteDecimals: 6,
    ...BOOK,
    observedAt: 7,
  });
  // 100 @ 1.00 + 50 @ 1.10 = 155; average 155 / 150; mid 0.95.
  assert.deepEqual(quote, {
    symbol: 'MON-USDC',
    side: 'buy',
    size: '150',
    fillableSize: '150',
    averagePrice: '1.033333333333333333',
    notional: '155',
    slippage: '0.087719298245614035', // (1.0333… - 0.95) / 0.95
    estimatedFee: '0.1085', // 155 * 0.07%
    timestamp: 7,
  });
});

test('simulateQuote reports a partial fill when the book is thin', () => {
  const quote = simulateQuote({
    symbol: 'MON-USDC',
    side: 'sell',
    size: '150',
    params: MON_PARAMS,
    quoteDecimals: 6,
    ...BOOK,
    observedAt: 7,
  });
  assert.equal(quote.fillableSize, '100');
  assert.equal(quote.averagePrice, '0.9');
  assert.equal(quote.notional, '90');
  assert.equal(quote.slippage, '0.052631578947368421'); // (0.95 - 0.90) / 0.95, adverse for a sell
});

test('simulateQuote on an empty side fills nothing and invents no price', () => {
  const quote = simulateQuote({
    symbol: 'MON-USDC',
    side: 'buy',
    size: '1',
    params: MON_PARAMS,
    quoteDecimals: 6,
    bids: BOOK.bids,
    asks: [],
    observedAt: 7,
  });
  assert.equal(quote.fillableSize, '0');
  assert.equal(quote.averagePrice, '0');
  assert.equal(quote.slippage, '0');
});

const NO_OUTCOME: KuruOrderOutcome = { fills: [], rested: [], removed: [], takerFeePps: undefined };

const placed = (overrides: Partial<Parameters<typeof toPlacedOrder>[0]>) =>
  toPlacedOrder({
    symbol: 'MON-USDC',
    side: 'buy',
    type: 'limit',
    timeInForce: 'GTC',
    quantity: 500n * 10n ** 8n,
    price: '0.02',
    params: MON_PARAMS,
    outcome: NO_OUTCOME,
    executionHash: '0xexec',
    transactionHash: '0xtx',
    observedAt: 1,
    ...overrides,
  });

test('toPlacedOrder: a resting order is open and addressable by slot and id', () => {
  const order = placed({
    outcome: {
      ...NO_OUTCOME,
      rested: [{ slotIdx: 4, orderId: 812n, price: 20_000n, size: 500n * 10n ** 8n, isBuy: true }],
    },
  });
  assert.equal(order.status, 'open');
  assert.equal(order.id, '4:812');
  assert.equal(order.size, '500');
  assert.equal(order.filledSize, '0');
  assert.equal(order.txHash, '0xtx');
});

test('toPlacedOrder: partial fill that rests the remainder', () => {
  const order = placed({
    outcome: {
      ...NO_OUTCOME,
      fills: [
        { price: 19_000n, size: 100n * 10n ** 8n, makerId: 9n, makerOrderId: 1n, tradeId: 1n },
      ],
      rested: [{ slotIdx: 0, orderId: 5n, price: 20_000n, size: 400n * 10n ** 8n, isBuy: true }],
    },
  });
  assert.equal(order.status, 'partially_filled');
  assert.equal(order.filledSize, '100');
  assert.equal(order.averageFillPrice, '0.019');
});

test('toPlacedOrder: an IOC that fills in full, in part, or not at all', () => {
  const fill = (size: bigint) => ({
    price: 31_000n,
    size,
    makerId: 9n,
    makerOrderId: 1n,
    tradeId: 1n,
  });
  const ioc = { type: 'market' as const, timeInForce: 'IOC' as const, price: undefined };
  const full = placed({ ...ioc, outcome: { ...NO_OUTCOME, fills: [fill(500n * 10n ** 8n)] } });
  assert.equal(full.status, 'filled');
  assert.equal(full.id, '0xexec'); // nothing rested, so there is no slot to name
  assert.equal(full.averageFillPrice, '0.031');

  assert.equal(
    placed({ ...ioc, outcome: { ...NO_OUTCOME, fills: [fill(1n)] } }).status,
    'cancelled',
  );
  assert.equal(placed({ ...ioc }).status, 'expired');
});

test('toPlacedOrder: a crossing POST_ONLY is skipped, which reads as rejected', () => {
  assert.equal(placed({ timeInForce: 'POST_ONLY' }).status, 'rejected');
});
