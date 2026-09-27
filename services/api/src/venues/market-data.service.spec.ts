/**
 * MarketDataService, Kuru side (SEN-70): caching per read, the quote's
 * slippage-bounded fill, and how a venue being down surfaces. The Kuru reader
 * is faked — the adapter's own reads are covered in packages/venues.
 */
import type { Depth, Kline, Market } from '@sente/venues';
import {
  KURU_TESTNET_MARKETS,
  KuruOrderError,
  type BookLevel,
  type KuruBookSnapshot,
  type KuruVenue,
} from '@sente/venues/kuru';

import {
  fillableWithin,
  InvalidSizeError,
  MarketDataService,
  MarketNotFoundError,
  UnavailablePerplReader,
  VenueUnavailableError,
  type KuruReader,
} from './market-data.service';

// A read-only KuruVenue is what B-T5b injects; keep it assignable to the port.
const _venueIsReader = (venue: KuruVenue): KuruReader => venue;
void _venueIsReader;

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const CATALOG: Market[] = [
  {
    symbol: 'MON-USDC',
    kind: 'spot',
    base: 'MON',
    quote: 'USDC',
    tickSize: '0.000001',
    stepSize: '0.00000001',
    minSize: '0.00000001',
    minNotional: '1',
    venueSymbol: 'MONUSDC',
    makerFee: '0',
    takerFee: '0.0007',
  },
];

const DEPTH: Depth = {
  symbol: 'MON-USDC',
  bids: [
    { price: '0.99', size: '2' },
    { price: '0.98', size: '4' },
  ],
  asks: [
    { price: '1', size: '1' },
    { price: '1.01', size: '3' },
  ],
  timestamp: NOW,
  sequence: 42,
};

const kline = (
  openTime: number,
  o: string,
  h: string,
  l: string,
  c: string,
  qv: string,
): Kline => ({
  openTime,
  closeTime: openTime + HOUR - 1,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: '0',
  quoteVolume: qv,
});

// Book units for MON-USDC: price × 1e6, size × 1e8.
const P = (price: number) => BigInt(Math.round(price * 1e6));
const S = (size: number) => BigInt(Math.round(size * 1e8));

function snapshot(bids: BookLevel[], asks: BookLevel[]): KuruBookSnapshot {
  return {
    params: {
      pricePrecision: 1_000_000n,
      sizePrecision: 100_000_000n,
      tickSize: 1n,
      minQuoteNotional: 1_000_000n, // 1 USDC in atoms
      maxQuoteNotional: 10n ** 30n,
      takerFeePps: 7_000n, // 7 bps
      makerFeePps: 0n,
    },
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    observedAt: NOW,
  };
}

const BOOK = snapshot(
  [{ price: P(0.99), size: S(2) }],
  [
    { price: P(1), size: S(1) },
    { price: P(1.01), size: S(1) },
    { price: P(1.1), size: S(5) },
  ],
);

function fakeKuru() {
  const reader = {
    market: jest.fn((symbol: string) => {
      const market = KURU_TESTNET_MARKETS.find((m) => m.symbol === symbol);
      if (!market) throw new KuruOrderError(`Kuru does not list ${symbol}`);
      return market;
    }),
    getMarkets: jest.fn(() => Promise.resolve(CATALOG)),
    getDepth: jest.fn(() => Promise.resolve(DEPTH)),
    getKlines: jest.fn(({ interval }: { interval: string }) =>
      Promise.resolve(
        interval === '1m'
          ? [
              kline(NOW - 120_000, '1', '1', '1', '1.004', '1'),
              kline(NOW - 60_000, '1', '1', '1', '1.005', '1'),
            ]
          : [
              // Closed before the 24h window: excluded.
              kline(NOW - 26 * HOUR, '5', '9', '0.1', '5', '1000'),
              kline(NOW - 24.5 * HOUR, '0.9', '0.95', '0.85', '0.92', '10'),
              kline(NOW - HOUR, '0.92', '1.2', '0.9', '1.005', '20.5'),
            ],
      ),
    ),
    bookSnapshot: jest.fn(() => Promise.resolve(BOOK)),
  } satisfies KuruReader;
  return reader;
}

describe('MarketDataService (Kuru)', () => {
  let kuru: ReturnType<typeof fakeKuru>;
  let service: MarketDataService;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    kuru = fakeKuru();
    service = new MarketDataService(kuru, new UnavailablePerplReader());
  });

  afterEach(() => jest.restoreAllMocks());

  describe('markets', () => {
    it('merges the catalogs and reports Perpl down instead of failing', async () => {
      const response = await service.markets();
      expect(response.markets).toEqual([
        {
          venue: 'kuru',
          symbol: 'MON-USDC',
          venueSymbol: 'MONUSDC',
          kind: 'spot',
          base: 'MON',
          quote: 'USDC',
          tickSize: '0.000001',
          stepSize: '0.00000001',
          minSize: '0.00000001',
          minNotional: '1',
          maxLeverage: null,
          marginMode: null,
          makerFee: '0',
          takerFee: '0.0007',
        },
      ]);
      expect(response.venues).toEqual([
        { venue: 'kuru', ok: true },
        { venue: 'perpl', ok: false, error: expect.stringContaining('perpl') },
      ]);
    });

    it('reports Kuru down too when both fail', async () => {
      kuru.getMarkets.mockRejectedValue(new Error('data source 502'));
      const response = await service.markets();
      expect(response.markets).toEqual([]);
      expect(response.venues[0]).toEqual({
        venue: 'kuru',
        ok: false,
        error: expect.stringContaining('data source 502'),
      });
    });

    it('caches the catalog for its TTL', async () => {
      await service.markets();
      await service.market('kuru', 'MON-USDC');
      expect(kuru.getMarkets).toHaveBeenCalledTimes(1);
    });

    it('404s an unlisted market', async () => {
      await expect(service.market('kuru', 'DOGE-USDC')).rejects.toBeInstanceOf(MarketNotFoundError);
    });
  });

  describe('depth', () => {
    it('reads 50 levels once and slices per request', async () => {
      const a = await service.depth('kuru', 'MON-USDC', 1);
      const b = await service.depth('kuru', 'MON-USDC', 20);
      expect(kuru.getDepth).toHaveBeenCalledTimes(1);
      expect(kuru.getDepth).toHaveBeenCalledWith({ symbol: 'MON-USDC', limit: 50 });
      expect(a.bids).toEqual([{ price: '0.99', size: '2' }]);
      expect(b.bids).toHaveLength(2);
      expect(a).toMatchObject({ venue: 'kuru', sequence: 42, stale: false, asOf: NOW });
    });

    it('single-flights concurrent readers', async () => {
      await Promise.all([1, 2, 3, 4].map(() => service.depth('kuru', 'MON-USDC', 5)));
      expect(kuru.getDepth).toHaveBeenCalledTimes(1);
    });

    it('serves the last book flagged stale when the Gateway fails', async () => {
      await service.depth('kuru', 'MON-USDC', 5);
      jest.spyOn(Date, 'now').mockReturnValue(NOW + 3_000);
      kuru.getDepth.mockRejectedValue(new Error('gateway timeout'));
      const depth = await service.depth('kuru', 'MON-USDC', 5);
      expect(depth.stale).toBe(true);
      expect(depth.asOf).toBe(NOW);
    });

    it('is VenueUnavailable when the Gateway fails with nothing cached', async () => {
      kuru.getDepth.mockRejectedValue(new Error('gateway timeout'));
      await expect(service.depth('kuru', 'MON-USDC', 5)).rejects.toBeInstanceOf(
        VenueUnavailableError,
      );
    });

    it('is MarketNotFound for a symbol Kuru does not list', async () => {
      await expect(service.depth('kuru', 'NOPE', 5)).rejects.toBeInstanceOf(MarketNotFoundError);
      expect(kuru.getDepth).not.toHaveBeenCalled();
    });
  });

  describe('ticker', () => {
    it('combines the book, the latest 1m close and the 24h hourly window', async () => {
      expect(await service.ticker('kuru', 'MON-USDC')).toEqual({
        venue: 'kuru',
        symbol: 'MON-USDC',
        quote: 'USDC',
        last: '1.005',
        mark: null,
        index: null,
        bid: '0.99',
        ask: '1',
        mid: '0.995',
        open24h: '0.9',
        high24h: '1.2',
        low24h: '0.85',
        change24h: '0.105',
        change24hPct: '0.116666666666666666',
        quoteVolume24h: '30.5',
        funding: null,
        stale: false,
        asOf: NOW,
      });
    });

    it('still answers from the book when candles are unavailable', async () => {
      kuru.getKlines.mockRejectedValue(new Error('data source down'));
      const ticker = await service.ticker('kuru', 'MON-USDC');
      expect(ticker).toMatchObject({ bid: '0.99', ask: '1', last: null, open24h: null });
    });

    it('lists every catalog market; Perpl down is left out of an unfiltered list', async () => {
      const { tickers } = await service.tickers();
      expect(tickers.map((t) => `${t.venue}:${t.symbol}`)).toEqual(['kuru:MON-USDC']);
      await expect(service.tickers('perpl')).rejects.toBeInstanceOf(VenueUnavailableError);
    });
  });

  describe('klines', () => {
    it('rounds endTime up to the interval so one minute shares an entry', async () => {
      const a = await service.klines('kuru', 'MON-USDC', '1m', 10, NOW + 1_000);
      await service.klines('kuru', 'MON-USDC', '1m', 10, NOW + 30_000);
      expect(kuru.getKlines).toHaveBeenCalledTimes(1);
      expect(kuru.getKlines).toHaveBeenCalledWith({
        symbol: 'MON-USDC',
        interval: '1m',
        limit: 10,
        endTime: Math.ceil((NOW + 1_000) / 60_000) * 60_000,
      });
      expect(a).toMatchObject({ venue: 'kuru', interval: '1m', volumeIsEstimate: true });
      expect(a.klines[0]).toMatchObject({ close: '1.004', quoteVolume: '1' });
    });
  });

  describe('quote', () => {
    it('reports a partial fill inside the slippage bound', async () => {
      const quote = await service.quote('kuru', 'MON-USDC', {
        side: 'buy',
        size: '3',
        maxSlippage: '0.02',
      });
      expect(quote).toMatchObject({
        venue: 'kuru',
        side: 'buy',
        size: '3',
        fillableSize: '3',
        notional: '3.11',
        estimatedFee: '0.002177',
        feeAsset: 'USDC',
        maxSlippage: '0.02',
        worstPrice: '1.02',
        fillableWithinWorstPrice: '2',
        partial: true,
        minNotionalOk: true,
        bookAsOf: NOW,
        stale: false,
      });
      expect(quote.averagePrice).toMatch(/^1\.0366/);
    });

    it('is not partial when the bound covers the size', async () => {
      const quote = await service.quote('kuru', 'MON-USDC', {
        side: 'buy',
        size: '1.5',
        maxSlippage: '0.02',
      });
      expect(quote).toMatchObject({ fillableWithinWorstPrice: '1.5', partial: false });
    });

    it('flags an order under the minimum notional', async () => {
      const quote = await service.quote('kuru', 'MON-USDC', {
        side: 'sell',
        size: '0.5',
        maxSlippage: '0.01',
      });
      expect(quote).toMatchObject({
        notional: '0.495',
        minNotionalOk: false,
        worstPrice: '0.9801',
      });
    });

    it('has no worst price against an empty side', async () => {
      kuru.bookSnapshot.mockResolvedValue(snapshot([], BOOK.asks));
      const quote = await service.quote('kuru', 'MON-USDC', {
        side: 'sell',
        size: '1',
        maxSlippage: '0.01',
      });
      expect(quote).toMatchObject({
        fillableSize: '0',
        averagePrice: null,
        worstPrice: null,
        fillableWithinWorstPrice: '0',
        partial: true,
      });
    });

    it('caches the book per market', async () => {
      const request = { side: 'buy' as const, size: '1', maxSlippage: '0.01' };
      await service.quote('kuru', 'MON-USDC', request);
      await service.quote('kuru', 'MON-USDC', request);
      expect(kuru.bookSnapshot).toHaveBeenCalledTimes(1);
    });

    it.each(['0', '0.000000001', 'abc'])('refuses size %s', async (size) => {
      await expect(
        service.quote('kuru', 'MON-USDC', { side: 'buy', size, maxSlippage: '0.01' }),
      ).rejects.toBeInstanceOf(InvalidSizeError);
    });
  });

  describe('mark', () => {
    it('is the book mid when both sides exist', async () => {
      expect(await service.mark('kuru', 'MON-USDC')).toBe('0.995');
    });

    it('falls back to the last 1m close on a one-sided book', async () => {
      kuru.getDepth.mockResolvedValue({ ...DEPTH, bids: [] });
      expect(await service.mark('kuru', 'MON-USDC')).toBe('1.005');
    });

    it('delegates Perpl to its reader', async () => {
      await expect(service.mark('perpl', 'BTC')).rejects.toBeInstanceOf(VenueUnavailableError);
    });
  });
});

describe('fillableWithin', () => {
  const asks = [
    { price: 100n, size: 5n },
    { price: 101n, size: 5n },
    { price: 102n, size: 5n },
  ];
  it('stops at the first level outside the bound', () => {
    expect(fillableWithin(asks, 'buy', 101n, 100n)).toBe(10n);
  });
  it('caps at the wanted size', () => {
    expect(fillableWithin(asks, 'buy', 102n, 7n)).toBe(7n);
  });
  it('mirrors for sells', () => {
    const bids = [
      { price: 99n, size: 5n },
      { price: 98n, size: 5n },
    ];
    expect(fillableWithin(bids, 'sell', 99n, 100n)).toBe(5n);
  });
});
