import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { authConfig, resetAuthConfig } from '../auth/auth.config';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { mintSessionToken } from '../auth/session-token';
import type {
  DepthDto,
  KlinesDto,
  MarketsResponseDto,
  QuoteDto,
  TickerDto,
  VenueId,
} from './dto/markets.dto';
import {
  IntervalNotSupportedError,
  InvalidSizeError,
  MarketDataService,
  MarketNotFoundError,
  VenueUnavailableError,
  type QuoteRequestDto,
} from './market-data.service';
import { MarketsController } from './markets.controller';

/**
 * SEN-77 over HTTP: the real guard and the global ValidationPipe as main.ts
 * configures it, because 401s, query coercion and route matching only exist
 * there. The service is a fake that records what it was asked.
 */

const SECRET = 'cd'.repeat(32);
const ORIGINAL = { ...process.env };

const ticker = (venue: VenueId, symbol: string): TickerDto => ({
  venue,
  symbol,
  quote: venue === 'kuru' ? 'USDC' : 'AUSD',
  last: '1.5',
  mark: null,
  index: null,
  bid: '1.4',
  ask: '1.6',
  mid: '1.5',
  open24h: null,
  high24h: null,
  low24h: null,
  change24h: null,
  change24hPct: null,
  quoteVolume24h: null,
  funding: null,
  stale: false,
  asOf: 1,
});

class FakeMarketData {
  calls: unknown[][] = [];
  /** Thrown by the next call, when set. */
  failWith: Error | undefined;

  #record(...args: unknown[]): void {
    this.calls.push(args);
    const error = this.failWith;
    if (error) throw error;
  }

  async markets(): Promise<MarketsResponseDto> {
    this.#record('markets');
    return { markets: [], venues: [{ venue: 'kuru', ok: true }], asOf: 1 };
  }
  async tickers(venue?: VenueId) {
    this.#record('tickers', venue);
    return { tickers: [ticker(venue ?? 'kuru', 'MON-USDC')], asOf: 1 };
  }
  async ticker(venue: VenueId, symbol: string): Promise<TickerDto> {
    this.#record('ticker', venue, symbol);
    return ticker(venue, symbol);
  }
  async depth(venue: VenueId, symbol: string, limit: number): Promise<DepthDto> {
    this.#record('depth', venue, symbol, limit);
    return { venue, symbol, bids: [], asks: [], sequence: null, stale: false, asOf: 1 };
  }
  async klines(
    venue: VenueId,
    symbol: string,
    interval: KlinesDto['interval'],
    limit: number,
    endTime?: number,
  ): Promise<KlinesDto> {
    this.#record('klines', venue, symbol, interval, limit, endTime);
    return { venue, symbol, interval, klines: [], volumeIsEstimate: true, asOf: 1 };
  }
  async quote(venue: VenueId, symbol: string, request: QuoteRequestDto): Promise<QuoteDto> {
    this.#record('quote', venue, symbol, request);
    return {
      venue,
      symbol,
      side: request.side,
      size: request.size,
      fillableSize: request.size,
      averagePrice: '1.5',
      notional: '1.5',
      estimatedFee: '0',
      feeAsset: 'USDC',
      slippageVsMid: '0',
      maxSlippage: request.maxSlippage,
      worstPrice: '1.6',
      fillableWithinWorstPrice: request.size,
      partial: false,
      minNotionalOk: true,
      bookAsOf: 1,
      stale: false,
    };
  }
}

describe('MarketsController (SEN-77)', () => {
  let app: INestApplication;
  let fake: FakeMarketData;
  let base: string;
  let token: string;

  beforeEach(async () => {
    process.env['AUTH_SESSION_SECRET'] = SECRET;
    delete process.env['AUTH_PLACEHOLDER'];
    resetAuthConfig();
    token = mintSessionToken(authConfig().sessionSecret, {
      sub: '0x' + '1'.repeat(40),
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    fake = new FakeMarketData();
    const moduleRef = await Test.createTestingModule({
      controllers: [MarketsController],
      providers: [{ provide: MarketDataService, useValue: fake }, SessionAuthGuard],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...ORIGINAL };
    resetAuthConfig();
  });

  async function get(path: string, auth = true): Promise<{ status: number; body: unknown }> {
    const response = await fetch(new URL(path, base), {
      headers: auth ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.json() };
  }

  it('answers 401 without a session, on every route, before touching a venue', async () => {
    for (const path of [
      '/markets',
      '/markets/tickers',
      '/markets/kuru/MON-USDC/ticker',
      '/markets/kuru/MON-USDC/depth',
      '/markets/kuru/MON-USDC/klines?interval=1h',
      '/markets/kuru/MON-USDC/quote?side=buy&size=1',
    ]) {
      expect(await get(path, false)).toMatchObject({ status: 401 });
    }
    expect(fake.calls).toEqual([]);
  });

  it('GET /markets', async () => {
    expect(await get('/markets')).toEqual({
      status: 200,
      body: { markets: [], venues: [{ venue: 'kuru', ok: true }], asOf: 1 },
    });
  });

  it('GET /markets/tickers, optionally one venue', async () => {
    const all = await get('/markets/tickers');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ tickers: [{ venue: 'kuru', symbol: 'MON-USDC' }] });
    await get('/markets/tickers?venue=perpl');
    expect(fake.calls).toEqual([
      ['tickers', undefined],
      ['tickers', 'perpl'],
    ]);
    expect(await get('/markets/tickers?venue=binance')).toMatchObject({ status: 400 });
  });

  it('GET /markets/:venue/:symbol/ticker', async () => {
    const res = await get('/markets/perpl/BTC/ticker');
    expect(res).toMatchObject({ status: 200, body: { venue: 'perpl', symbol: 'BTC' } });
  });

  it('validates the venue and symbol params', async () => {
    expect(await get('/markets/binance/BTC/ticker')).toMatchObject({ status: 400 });
    expect(await get(`/markets/kuru/${'A'.repeat(33)}/ticker`)).toMatchObject({ status: 400 });
    expect(await get('/markets/kuru/MON%20USDC/ticker')).toMatchObject({ status: 400 });
    expect(fake.calls).toEqual([]);
  });

  it('GET depth: default 20, bounded 1..50', async () => {
    expect(await get('/markets/kuru/MON-USDC/depth')).toMatchObject({
      status: 200,
      body: { venue: 'kuru', symbol: 'MON-USDC', bids: [], asks: [] },
    });
    await get('/markets/kuru/MON-USDC/depth?limit=50');
    expect(fake.calls).toEqual([
      ['depth', 'kuru', 'MON-USDC', 20],
      ['depth', 'kuru', 'MON-USDC', 50],
    ]);
    for (const limit of ['0', '51', 'x', '1.5']) {
      expect(await get(`/markets/kuru/MON-USDC/depth?limit=${limit}`)).toMatchObject({
        status: 400,
      });
    }
  });

  it('GET klines: interval required and checked, limit default 200 and bounded, endTime passed', async () => {
    expect(await get('/markets/kuru/MON-USDC/klines?interval=1h')).toMatchObject({
      status: 200,
      body: { interval: '1h', klines: [], volumeIsEstimate: true },
    });
    await get('/markets/kuru/MON-USDC/klines?interval=5m&limit=1000&endTime=1700000000000');
    expect(fake.calls).toEqual([
      ['klines', 'kuru', 'MON-USDC', '1h', 200, undefined],
      ['klines', 'kuru', 'MON-USDC', '5m', 1000, 1_700_000_000_000],
    ]);
    for (const query of ['', 'interval=2h', 'interval=1h&limit=1001', 'interval=1h&endTime=-1']) {
      expect(await get(`/markets/kuru/MON-USDC/klines?${query}`)).toMatchObject({ status: 400 });
    }
  });

  it('GET quote: maxSlippage defaults to 0.005 and is capped at 0.05', async () => {
    expect(await get('/markets/kuru/MON-USDC/quote?side=buy&size=1.5')).toMatchObject({
      status: 200,
      body: { side: 'buy', size: '1.5', maxSlippage: '0.005' },
    });
    await get('/markets/kuru/MON-USDC/quote?side=sell&size=2&maxSlippage=0.05');
    expect(fake.calls).toEqual([
      ['quote', 'kuru', 'MON-USDC', { side: 'buy', size: '1.5', maxSlippage: '0.005' }],
      ['quote', 'kuru', 'MON-USDC', { side: 'sell', size: '2', maxSlippage: '0.05' }],
    ]);
    for (const query of [
      'side=buy&size=1&maxSlippage=0.0500000000000000001',
      'side=buy&size=1&maxSlippage=0.051',
      'side=buy&size=1&maxSlippage=-0.01',
      'side=hold&size=1',
      'side=buy',
    ]) {
      expect(await get(`/markets/kuru/MON-USDC/quote?${query}`)).toMatchObject({ status: 400 });
    }
  });

  it('a malformed size is 400 invalid_size, the reason the app branches on', async () => {
    for (const size of ['-1', 'abc', '1e3', '1.']) {
      expect(await get(`/markets/kuru/MON-USDC/quote?side=buy&size=${size}`)).toEqual({
        status: 400,
        body: expect.objectContaining({ statusCode: 400, reason: 'invalid_size' }),
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it.each([
    [new MarketNotFoundError('kuru', 'NOPE'), 404, 'market_not_found'],
    [new IntervalNotSupportedError('perpl', '1w'), 400, 'interval_not_supported'],
    [new InvalidSizeError('size must be greater than zero'), 400, 'invalid_size'],
  ])('maps %s to %i %s', async (error, status, reason) => {
    fake.failWith = error;
    expect(await get('/markets/kuru/NOPE/ticker')).toEqual({
      status,
      body: { statusCode: status, reason, message: error.message },
    });
  });

  it('maps venue_unavailable to 503 with retryAfterMs', async () => {
    fake.failWith = new VenueUnavailableError('perpl', 'socket closed', 7_000);
    expect(await get('/markets/perpl/BTC/depth')).toEqual({
      status: 503,
      body: {
        statusCode: 503,
        reason: 'venue_unavailable',
        message: 'perpl is unavailable: socket closed',
        retryAfterMs: 7_000,
      },
    });
  });

  it('leaves an unexpected error a 500 without a reason', async () => {
    fake.failWith = new Error('boom');
    const res = await get('/markets');
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty('reason');
  });
});
