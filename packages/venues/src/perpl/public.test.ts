/**
 * The credential-free reader's pure helpers (SEN-69), against a fixture
 * context and book. The quote/depth/kline expectations were produced by the
 * pre-SEN-69 `PerplVenue` methods on this same fixture, so they pin the
 * extraction as behaviour-preserving.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PerplMarketData,
  bookToDepth,
  candlesToKlines,
  perplMarkets,
  perplSlippageBound,
  quoteFromBook,
  resolveSymbol,
} from './public.ts';
import { PerplVenue } from './venue.ts';
import { MT, type PerplCandleSeries, type PerplContext, type PerplL2Book } from './wire.ts';
import type { WebSocketLike } from './ws.ts';

/** BTC (1 price decimal, 5 size decimals) and a closed ETH, AUSD collateral. */
function fixtureContext(): PerplContext {
  const market = (id: number, symbol: string, isOpen: boolean) => ({
    id,
    instance_id: 1,
    perpetual_id: id,
    symbol,
    name: symbol,
    size_units: '1',
    order_ttl_blocks: 100,
    order_max_market_slippage_bps: 500, // 5%
    order_max_neg_pnl_collat_bps: 0,
    config: {
      is_open: isOpen,
      price_decimals: 1,
      size_decimals: 5,
      min_posting_amount: '0',
      min_settle_amount: '0',
      initial_margin: 2000, // 20x
      maintenance_margin: 2500,
      maker_fee: 100, // 0.01%
      taker_fee: 690, // 0.069%
      recycle_fee: '0',
    },
    state: {
      at: { b: 5, t: 1_700_000_000_000 },
      orl: 999_000,
      mrk: 1_000_000, // $100,000.0
      lst: 1_000_100,
      mid: 1_000_050,
      bid: 1_000_000,
      ask: 1_000_100,
    },
  });
  return {
    chain: { chain_id: 10143 },
    instances: [
      {
        id: 1,
        address: '0x0',
        collateral_token_id: 7,
        min_account_open_amount: '0',
        min_deposit_amount: '0',
        min_withdraw_amount: '0',
      },
    ],
    tokens: [{ id: 7, symbol: 'AUSD', name: 'AUSD', decimals: 6, display_precision: 2 }],
    markets: [market(16, 'BTC', true), market(32, 'ETH', false)],
  };
}

/** Unsorted, with an empty level on each side, as the socket may send it. */
const BOOK: PerplL2Book = {
  mt: MT.L2BookSnapshot,
  sid: 3,
  sn: 42,
  at: { t: 1_700_000_000_500 },
  bid: [
    { p: 999_900, s: 50_000, o: 1 },
    { p: 1_000_000, s: 20_000, o: 1 },
    { p: 999_950, s: 0, o: 0 },
  ],
  ask: [
    { p: 1_000_300, s: 100_000, o: 2 },
    { p: 1_000_100, s: 30_000, o: 1 },
    { p: 1_000_200, s: 0, o: 0 },
  ],
};

const btc = () => resolveSymbol(fixtureContext(), 'BTC-PERP');

test('perplMarkets lists open markets with fees, leverage and isolated margin', () => {
  assert.deepEqual(perplMarkets(fixtureContext()), [
    {
      symbol: 'BTC-PERP',
      kind: 'perp',
      base: 'BTC',
      quote: 'AUSD',
      tickSize: '0.1',
      stepSize: '0.00001',
      minSize: '0.00001',
      maxLeverage: 20,
      venueSymbol: 'BTC',
      makerFee: '0.0001',
      takerFee: '0.00069',
      marginMode: 'isolated',
    },
  ]);
});

test('resolveSymbol refuses unknown and closed markets', () => {
  assert.throws(() => resolveSymbol(fixtureContext(), 'SOL-PERP'), /no market SOL-PERP/);
  assert.throws(() => resolveSymbol(fixtureContext(), 'ETH-PERP'), /ETH-PERP is closed/);
});

test('quoteFromBook walks the asks for a buy (matches the pre-SEN-69 quote)', () => {
  assert.deepEqual(quoteFromBook(BOOK, btc(), { symbol: 'BTC-PERP', side: 'buy', size: '0.5' }), {
    symbol: 'BTC-PERP',
    side: 'buy',
    size: '0.5',
    fillableSize: '0.5',
    averagePrice: '100018',
    notional: '50009',
    slippage: '0.00012999',
    estimatedFee: '34.50621',
    timestamp: 1_700_000_000_500,
  });
});

test('quoteFromBook walks the bids for a sell and stops at a thin book', () => {
  assert.deepEqual(quoteFromBook(BOOK, btc(), { symbol: 'BTC-PERP', side: 'sell', size: '1' }), {
    symbol: 'BTC-PERP',
    side: 'sell',
    size: '1',
    fillableSize: '0.7',
    averagePrice: '99992.85714',
    notional: '69995',
    slippage: '0.00012142',
    estimatedFee: '48.29655',
    timestamp: 1_700_000_000_500,
  });
});

test('PerplVenue.quote and getDepth delegate to the same helpers', async () => {
  const venue = new PerplVenue({
    credentials: { apiKey: 'unused', secretKey: new Uint8Array(32) },
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify(fixtureContext()))),
    webSocket: () => bookSocket(BOOK),
  });
  const request = { symbol: 'BTC-PERP', side: 'buy', size: '0.5' } as const;
  assert.deepEqual(await venue.quote(request), quoteFromBook(BOOK, btc(), request));
  assert.deepEqual(
    await venue.getDepth({ symbol: 'BTC-PERP', limit: 1 }),
    bookToDepth(BOOK, btc(), 1),
  );
  venue.close();
});

test('bookToDepth drops empty levels and sorts best first', () => {
  assert.deepEqual(bookToDepth(BOOK, btc(), 1), {
    symbol: 'BTC-PERP',
    bids: [{ price: '100000', size: '0.2' }],
    asks: [{ price: '100010', size: '0.3' }],
    timestamp: 1_700_000_000_500,
    sequence: 42,
  });
  assert.equal(bookToDepth(BOOK, btc()).bids.length, 2);
});

test('perplSlippageBound offsets mark and rounds conservatively', () => {
  // $100,000.0 ± 1% -> 101,000 / 99,000; a sub-tick result rounds toward mark.
  assert.deepEqual(perplSlippageBound(1_000_000n, 'buy', '0.01', btc()), {
    price: '101000',
    effectiveSlippage: '0.01',
  });
  assert.deepEqual(perplSlippageBound(1_000_000n, 'sell', '0.01', btc()), {
    price: '99000',
    effectiveSlippage: '0.01',
  });
  assert.equal(perplSlippageBound(999_999n, 'buy', '0.000001', btc()).price, '99999.9');
  assert.equal(perplSlippageBound(999_999n, 'sell', '0.000001', btc()).price, '99999.9');
});

test('perplSlippageBound clamps to the market maximum and refuses negatives', () => {
  // 20% asked, the market caps at 500 bps.
  assert.deepEqual(perplSlippageBound(1_000_000n, 'buy', '0.2', btc()), {
    price: '105000',
    effectiveSlippage: '0.05',
  });
  assert.deepEqual(perplSlippageBound(1_000_000n, 'sell', '0.2', btc()), {
    price: '95000',
    effectiveSlippage: '0.05',
  });
  assert.throws(() => perplSlippageBound(1_000_000n, 'buy', '-0.01', btc()), /negative/);
});

test('candlesToKlines clips, sorts and estimates base volume', () => {
  const series: PerplCandleSeries = {
    r: 60,
    d: [
      { t: 120_000, o: 1_000_000, h: 1_000_000, l: 1_000_000, c: 1_000_000, v: '5000000', n: 1 },
      { t: 60_000, o: 990_000, h: 1_010_000, l: 980_000, c: 1_000_000, v: '100000000', n: 3 },
      { t: 0, o: 1, h: 1, l: 1, c: 1, v: '0', n: 0 }, // before `from`
    ],
  };
  assert.deepEqual(candlesToKlines(series, btc(), '1m', 60_000, 179_999, 10), [
    {
      openTime: 60_000,
      closeTime: 120_000,
      open: '99000',
      high: '101000',
      low: '98000',
      close: '100000',
      volume: '0.001',
      quoteVolume: '100',
    },
    {
      openTime: 120_000,
      closeTime: 180_000,
      open: '100000',
      high: '100000',
      low: '100000',
      close: '100000',
      volume: '0.00005',
      quoteVolume: '5',
    },
  ]);
  assert.equal(candlesToKlines(series, btc(), '1m', 0, 179_999, 1).length, 1);
  assert.throws(() => candlesToKlines(series, btc(), '1w', 0, 1, 1), /no 1w candles/);
});

test('PerplMarketData reads without credentials and shares one context fetch', async () => {
  const urls: string[] = [];
  const data = new PerplMarketData({
    fetchImpl: (input) => {
      urls.push(String(input));
      const body = String(input).includes('/candles/')
        ? { r: 3600, d: [] }
        : (fixtureContext() as unknown);
      return Promise.resolve(new Response(JSON.stringify(body)));
    },
  });
  const [markets, state] = await Promise.all([data.getMarkets(), data.state('BTC-PERP')]);
  assert.equal(markets.length, 1);
  assert.deepEqual(state, {
    mark: '100000',
    last: '100010',
    mid: '100005',
    bid: '100000',
    ask: '100010',
    index: '99900',
    at: 1_700_000_000_000,
  });
  assert.deepEqual(
    await data.getKlines({ symbol: 'BTC-PERP', interval: '1h', endTime: 7_200_001, limit: 2 }),
    [],
  );
  assert.deepEqual(urls, [
    'https://testnet.perpl.xyz/api/v1/pub/context',
    'https://testnet.perpl.xyz/api/v1/market-data/16/candles/3600/0-7200000',
  ]);
});

/** A market-data socket that confirms the subscription and sends `book`. */
function bookSocket(book: PerplL2Book): WebSocketLike {
  const ws: WebSocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: () => undefined,
    send: () => {
      const reply = (m: unknown) => ws.onmessage?.({ data: JSON.stringify(m) });
      queueMicrotask(() => {
        reply({ mt: MT.SubscriptionResponse, subs: [{ stream: 'order-book@16', sid: 3 }] });
        reply(book);
      });
    },
  };
  queueMicrotask(() => ws.onopen?.());
  return ws;
}
