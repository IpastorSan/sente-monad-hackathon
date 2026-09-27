/**
 * PerplMarketReader (SEN-75): the ticker's mapping off `/pub/context`, the
 * book source order (feed, then a throttled snapshot, then stale), the quote's
 * mark-based bound, and the typed refusals. `PerplMarketData` and the feed are
 * faked; their own behaviour is covered in packages/venues and the feed spec.
 */
import type { Kline } from '@sente/venues';
import { MT, type PerplContext, type PerplL2Book } from '@sente/venues/perpl';

import {
  IntervalNotSupportedError,
  InvalidSizeError,
  MarketNotFoundError,
  VenueUnavailableError,
} from '../market-data.service';
import type { PerplBookEntry } from './perpl-book-feed';
import { PerplMarketReader } from './perpl-market-reader';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

/** BTC (1 price decimal, 5 size decimals), a closed ETH, AUSD collateral. */
function context(): PerplContext {
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
      initial_margin: 2000,
      maintenance_margin: 2500,
      maker_fee: 100,
      taker_fee: 690,
      recycle_fee: '0',
    },
    state: {
      at: { b: 5, t: NOW - 1_000 },
      orl: 999_000,
      mrk: 1_000_000, // 100000.0
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

const BOOK: PerplL2Book = {
  mt: MT.L2BookSnapshot,
  sid: 3,
  sn: 42,
  at: { t: NOW },
  bid: [
    { p: 999_900, s: 50_000, o: 1 },
    { p: 1_000_000, s: 20_000, o: 1 },
  ],
  ask: [
    { p: 1_000_300, s: 100_000, o: 2 },
    { p: 1_000_100, s: 30_000, o: 1 },
  ],
};

const hourly = (openTime: number, o: string, h: string, l: string, c: string): Kline => ({
  openTime,
  closeTime: openTime + HOUR,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: '1',
  quoteVolume: '100',
});

function setup() {
  let now = NOW;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const data = {
    context: jest.fn(() => Promise.resolve(context())),
    getKlines: jest.fn(({ interval }: { interval: string }) =>
      Promise.resolve(
        interval === '1h'
          ? [hourly(NOW - 23 * HOUR, '90000', '101000', '89000', '99000')]
          : [hourly(NOW - HOUR, '1', '2', '0.5', '1.5')],
      ),
    ),
  };
  let fed: PerplBookEntry | undefined;
  const feed = { book: jest.fn((_id: number) => fed) };
  const snapshot = jest.fn((_id: number) => Promise.resolve(BOOK));
  const reader = new PerplMarketReader({ data, feed, snapshot, now: () => now });
  return {
    reader,
    data,
    feed,
    snapshot,
    advance: (ms: number) => (now += ms),
    feedBook: (entry: PerplBookEntry | undefined) => (fed = entry),
  };
}

describe('PerplMarketReader', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lists open markets as perps in AUSD with isolated margin', async () => {
    const { reader } = setup();
    expect(await reader.markets()).toEqual([
      {
        venue: 'perpl',
        symbol: 'BTC-PERP',
        venueSymbol: 'BTC',
        kind: 'perp',
        base: 'BTC',
        quote: 'AUSD',
        tickSize: '0.1',
        stepSize: '0.00001',
        minSize: '0.00001',
        minNotional: null,
        maxLeverage: 20,
        marginMode: 'isolated',
        makerFee: '0.0001',
        takerFee: '0.00069',
      },
    ]);
  });

  describe('ticker', () => {
    it('maps mrk/lst/orl/bid/ask from the context, with funding null', async () => {
      const { reader } = setup();
      expect(await reader.ticker('BTC-PERP')).toEqual({
        venue: 'perpl',
        symbol: 'BTC-PERP',
        quote: 'AUSD',
        last: '100010',
        mark: '100000',
        index: '99900',
        bid: '100000',
        ask: '100010',
        mid: '100005',
        open24h: '90000',
        high24h: '101000',
        low24h: '89000',
        change24h: '10010',
        change24hPct: '0.111222222222222222',
        quoteVolume24h: '100',
        funding: null,
        stale: false,
        asOf: NOW - 1_000,
      });
    });

    it('reports an absent (zero) price as null and keeps the ticker without candles', async () => {
      const { reader, data } = setup();
      const ctx = context();
      Object.assign(ctx.markets[0].state, { orl: 0, bid: 0, mid: 0 });
      data.context.mockResolvedValue(ctx);
      data.getKlines.mockRejectedValue(new Error('candles 500'));
      const ticker = await reader.ticker('BTC-PERP');
      expect(ticker).toMatchObject({ index: null, bid: null, mid: null, open24h: null });
      expect(ticker.mark).toBe('100000');
    });

    it('serves every market from one context read within 3 s', async () => {
      const { reader, data } = setup();
      await reader.tickers();
      await reader.ticker('BTC-PERP');
      await reader.mark('BTC-PERP');
      expect(data.context).toHaveBeenCalledTimes(1);
    });

    it('404s unknown and closed markets; a context failure is the venue down', async () => {
      const { reader } = setup();
      await expect(reader.ticker('SOL-PERP')).rejects.toBeInstanceOf(MarketNotFoundError);
      await expect(reader.ticker('ETH-PERP')).rejects.toBeInstanceOf(MarketNotFoundError);

      const cold = setup();
      cold.data.context.mockRejectedValue(new Error('context 502'));
      await expect(cold.reader.ticker('BTC-PERP')).rejects.toBeInstanceOf(VenueUnavailableError);
    });
  });

  describe('depth', () => {
    it('prefers a fresh feed book and never opens a snapshot socket', async () => {
      const { reader, feedBook, snapshot } = setup();
      feedBook({ book: BOOK, receivedAt: NOW - 500, stale: false });
      const depth = await reader.depth('BTC-PERP', 1);
      expect(depth).toEqual({
        venue: 'perpl',
        symbol: 'BTC-PERP',
        bids: [{ price: '100000', size: '0.2' }],
        asks: [{ price: '100010', size: '0.3' }],
        sequence: 42,
        stale: false,
        asOf: NOW - 500,
      });
      expect(snapshot).not.toHaveBeenCalled();
    });

    it('falls back to a snapshot at most once per market per 30 s, then says stale', async () => {
      const { reader, snapshot, advance } = setup();
      expect((await reader.depth('BTC-PERP', 5)).stale).toBe(false);
      expect(snapshot).toHaveBeenCalledTimes(1);

      advance(20_000);
      const again = await reader.depth('BTC-PERP', 5);
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(again).toMatchObject({ stale: true, asOf: NOW });

      advance(11_000);
      expect((await reader.depth('BTC-PERP', 5)).stale).toBe(false);
      expect(snapshot).toHaveBeenCalledTimes(2);
    });

    it('throttles failed snapshots too, and serves a stale feed book meanwhile', async () => {
      const { reader, snapshot, feedBook, advance } = setup();
      snapshot.mockRejectedValue(new Error('socket refused'));
      await expect(reader.depth('BTC-PERP', 5)).rejects.toThrow(/socket refused/);

      feedBook({ book: BOOK, receivedAt: NOW - 60_000, stale: true });
      advance(1_000);
      expect(await reader.depth('BTC-PERP', 5)).toMatchObject({ stale: true, asOf: NOW - 60_000 });
      expect(snapshot).toHaveBeenCalledTimes(1);
    });
  });

  describe('klines', () => {
    it('refuses 1w without asking Perpl', async () => {
      const { reader, data } = setup();
      await expect(reader.klines('BTC-PERP', '1w', 10)).rejects.toBeInstanceOf(
        IntervalNotSupportedError,
      );
      expect(data.getKlines).not.toHaveBeenCalled();
      expect(data.context).not.toHaveBeenCalled();
    });

    it('reads candles through PerplMarketData and caches them', async () => {
      const { reader, data } = setup();
      const first = await reader.klines('BTC-PERP', '1m', 10);
      await reader.klines('BTC-PERP', '1m', 10);
      expect(first).toMatchObject({ venue: 'perpl', interval: '1m', volumeIsEstimate: true });
      expect(first.klines[0]).toMatchObject({ close: '1.5', quoteVolume: '100' });
      expect(data.getKlines).toHaveBeenCalledTimes(1);
      expect(data.getKlines).toHaveBeenCalledWith({
        symbol: 'BTC-PERP',
        interval: '1m',
        limit: 10,
        endTime: undefined,
      });
    });
  });

  describe('quote', () => {
    it('bounds off the mark and reports what fills inside it', async () => {
      const { reader, feedBook } = setup();
      feedBook({ book: BOOK, receivedAt: NOW, stale: false });
      const quote = await reader.quote('BTC-PERP', {
        side: 'buy',
        size: '0.5',
        maxSlippage: '0.0002',
      });
      expect(quote).toMatchObject({
        venue: 'perpl',
        fillableSize: '0.5',
        worstPrice: '100020', // mark 100000 × 1.0002
        maxSlippage: '0.0002',
        fillableWithinWorstPrice: '0.3',
        partial: true,
        feeAsset: 'AUSD',
        minNotionalOk: null,
        stale: false,
      });
    });

    it("clamps maxSlippage to the market's own maximum", async () => {
      const { reader, feedBook } = setup();
      feedBook({ book: BOOK, receivedAt: NOW, stale: false });
      const quote = await reader.quote('BTC-PERP', {
        side: 'sell',
        size: '0.1',
        maxSlippage: '0.2',
      });
      expect(quote).toMatchObject({ maxSlippage: '0.05', worstPrice: '95000', partial: false });
    });

    it('refuses sizes finer than the step, or not positive', async () => {
      const { reader } = setup();
      for (const size of ['0.000001', '0', '-1', 'abc']) {
        await expect(
          reader.quote('BTC-PERP', { side: 'buy', size, maxSlippage: '0.01' }),
        ).rejects.toBeInstanceOf(InvalidSizeError);
      }
    });
  });
});
