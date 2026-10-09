/**
 * `get_indicators` (SEN-180) through the gate, against a fake shared
 * market-data service. The math itself is pinned in `indicators.spec.ts`.
 */
import { InMemoryAgentEventLog } from '../events/agent-event-log';
import { InMemoryAgentStore } from '../store/agent-store';
import type { KlineDto, KlineInterval, MarketDto } from '../../venues/dto/markets.dto';
import { KLINE_WIDTH_MS, MarketNotFoundError } from '../../venues/market-data.service';
import { toRunnerTools } from './anthropic';
import { AgentTools, type ToolMarketData } from './context';
import { GATED_TOOLS, type ToolOutcome } from './gate';
import { BTC_PERP, MON_USDC, NOW, testAgent, WETH_USDC } from './testing/agent-fixture';
import { fakeVenues } from './testing/fake-venues';

const tool = GATED_TOOLS.find((t) => t.name === 'get_indicators')!;

/** `count` rising candles ending at NOW, the newest still open. */
function klines(interval: KlineInterval, count: number): KlineDto[] {
  const width = KLINE_WIDTH_MS[interval];
  const nowMs = NOW * 1000;
  const lastOpen = Math.floor(nowMs / width) * width;
  return Array.from({ length: count }, (_, i) => {
    const openTime = lastOpen - (count - 1 - i) * width;
    const close = (1 + i * 0.001).toFixed(3);
    return {
      openTime,
      closeTime: openTime + width - 1,
      open: close,
      high: close,
      low: close,
      close,
      volume: '10',
      quoteVolume: null,
    };
  });
}

function fakeMarketData(options: { count?: number; tickSize?: string | null } = {}) {
  const calls: unknown[][] = [];
  const unused = () => Promise.reject(new Error('not read by get_indicators'));
  const marketData: ToolMarketData = {
    klines: (venue, symbol, interval, limit) => {
      calls.push(['klines', venue, symbol, interval, limit]);
      if (symbol === 'NOPE') return Promise.reject(new MarketNotFoundError(venue, symbol));
      return Promise.resolve({
        venue,
        symbol,
        interval,
        klines: klines(interval, Math.min(limit, options.count ?? limit)),
        volumeIsEstimate: true,
        asOf: NOW * 1000,
      });
    },
    market: (venue, symbol) => {
      calls.push(['market', venue, symbol]);
      if (options.tickSize === null) return Promise.reject(new Error('catalog down'));
      return Promise.resolve({ tickSize: options.tickSize ?? '0.001' } as MarketDto);
    },
    quote: unused,
    depth: unused,
    mark: unused,
    ticker: unused,
  };
  return { marketData, calls };
}

async function harness(marketData?: ToolMarketData) {
  const store = new InMemoryAgentStore();
  const agent = testAgent();
  await store.insert(agent);
  const events = new InMemoryAgentEventLog();
  const fakes = fakeVenues();
  const tools = new AgentTools({
    store,
    events,
    precheck: true,
    venuesFor: () => Promise.resolve(fakes.venues),
    now: () => NOW,
    ...(marketData ? { marketData } : {}),
  });
  const ctx = tools.context(agent, { runId: 'run-1' });
  return {
    ...fakes,
    ctx,
    events,
    agent,
    call: (args: unknown) => tool.invoke(ctx, args),
  };
}

function result(outcome: ToolOutcome) {
  if (!outcome.ok) throw new Error(`refused: ${outcome.message}`);
  return outcome.result as {
    venue: string;
    market: string;
    timeframes: Record<string, Record<string, unknown> & { indicators: Record<string, unknown> }>;
  };
}

function refusal(outcome: ToolOutcome) {
  if (outcome.ok) throw new Error('expected a refusal');
  return outcome.refusal?.code;
}

describe('get_indicators', () => {
  it('is a read, offered to the runner with an object schema', () => {
    expect(tool.kind).toBe('read');
    const runnerTool = toRunnerTools({} as never).find((t) => t.name === 'get_indicators') as
      { input_schema: Record<string, unknown> } | undefined;
    expect(runnerTool?.input_schema['type']).toBe('object');
    expect(runnerTool?.input_schema['required']).toEqual(
      expect.arrayContaining(['venue', 'market', 'timeframes', 'indicators']),
    );
  });

  it('computes every spec on every timeframe from the shared candles', async () => {
    const md = fakeMarketData();
    const h = await harness(md.marketData);
    const out = result(
      await h.call({
        venue: 'kuru',
        market: MON_USDC,
        timeframes: ['1h', '15m', '5m'],
        indicators: [{ type: 'ema', period: 13 }, { type: 'rsi' }, { type: 'macd' }],
        series: 3,
      }),
    );

    // One read per timeframe at the default lookback, plus the tick size.
    expect(md.calls).toEqual([
      ['market', 'kuru', MON_USDC],
      ['klines', 'kuru', MON_USDC, '1h', 200],
      ['klines', 'kuru', MON_USDC, '15m', 200],
      ['klines', 'kuru', MON_USDC, '5m', 200],
    ]);
    expect(out.venue).toBe('kuru');
    expect(Object.keys(out.timeframes)).toEqual(['1h', '15m', '5m']);

    const hour = out.timeframes['1h']!;
    const last = klines('1h', 200).at(-1)!;
    expect(hour['candles']).toBe(200);
    expect(hour['last']).toEqual({ t: last.openTime, close: '1.199', closed: false });
    expect(hour['warnings']).toBeUndefined();
    // Closes rise 0.001 a candle: the 13-EMA lags the last close by 6 steps,
    // RSI pins at 100, and MACD is a constant 0.007 line over its signal.
    // Prices at the 0.001 tick plus two places.
    expect(hour.indicators).toEqual({
      'ema(13)': { value: '1.193', series: ['1.191', '1.192', '1.193'] },
      'rsi(14)': { value: '100', series: ['100', '100', '100'] },
      'macd(12,26,9)': {
        value: { line: '0.007', signal: '0.007', histogram: '0' },
        series: {
          line: ['0.007', '0.007', '0.007'],
          signal: ['0.007', '0.007', '0.007'],
          histogram: ['0', '0', '0'],
        },
      },
    });
    expect(await h.events.list(h.agent.id, { kind: 'refusal' })).toEqual([]);
    expect(h.kuru.writes()).toEqual([]);
  });

  it('fills in defaults and says what a short history cannot show', async () => {
    const md = fakeMarketData({ count: 20 });
    const h = await harness(md.marketData);
    const out = result(
      await h.call({
        venue: 'perpl',
        market: BTC_PERP,
        timeframes: ['4h'],
        lookback: 50,
        indicators: [{ type: 'sma' }, { type: 'adx' }, { type: 'bollinger', stddev: 2.5 }],
      }),
    );
    expect(md.calls).toContainEqual(['klines', 'perpl', BTC_PERP, '4h', 50]);
    const frame = out.timeframes['4h']!;
    expect(frame['candles']).toBe(20);
    expect(frame.indicators['sma(20)']).toMatchObject({ value: '1.0095' });
    expect((frame.indicators['sma(20)'] as { series: unknown[] }).series).toHaveLength(1);
    expect(frame.indicators['adx(14)']).toEqual({ value: null, needs: 28, have: 20 });
    expect(frame.indicators['bollinger(20,2.5)']).toMatchObject({
      value: { middle: '1.0095' },
    });
    expect(frame['warnings']).toEqual([expect.stringMatching(/^adx\(14\) needs 28 candles/)]);
  });

  it('uses the closes’ own precision when the catalog cannot say', async () => {
    const h = await harness(fakeMarketData({ tickSize: null }).marketData);
    const out = result(
      await h.call({
        venue: 'kuru',
        market: MON_USDC,
        timeframes: ['1d'],
        indicators: [{ type: 'wma', period: 3 }],
        series: 1,
      }),
    );
    // Closes carry 3 places, so 5: (1.197 + 2 x 1.198 + 3 x 1.199) / 6 = 1.19833.
    expect(out.timeframes['1d']!.indicators['wma(3)']).toEqual({
      value: '1.19833',
      series: ['1.19833'],
    });
  });

  it("falls back to the agent's own venue without the shared service", async () => {
    const h = await harness();
    const out = result(
      await h.call({
        venue: 'kuru',
        market: MON_USDC,
        timeframes: ['1h'],
        indicators: [{ type: 'obv' }],
      }),
    );
    // The fake venue has no candles: an empty window, not an error.
    expect(out.timeframes['1h']).toMatchObject({
      candles: 0,
      last: null,
      indicators: { obv: { value: null, needs: 2, have: 0 } },
    });
  });

  it('only reads markets the mandate allows', async () => {
    const md = fakeMarketData();
    const h = await harness(md.marketData);
    const args = { timeframes: ['1h'], indicators: [{ type: 'rsi' }] };
    expect(refusal(await h.call({ ...args, venue: 'kuru', market: WETH_USDC }))).toBe(
      'market_not_allowed',
    );
    expect(refusal(await h.call({ ...args, venue: 'perpl', market: 'ETH-PERP' }))).toBe(
      'market_not_allowed',
    );
    expect(md.calls).toEqual([]);
  });

  it.each([
    ['a Perpl 1w timeframe', { venue: 'perpl', market: BTC_PERP, timeframes: ['1w'] }],
    ['no timeframe', { timeframes: [] }],
    ['five timeframes', { timeframes: ['1m', '5m', '15m', '1h', '4h'] }],
    ['a repeated timeframe', { timeframes: ['1h', '1h'] }],
    ['an unknown timeframe', { timeframes: ['2h'] }],
    ['no indicator', { indicators: [] }],
    ['nine indicators', { indicators: new Array(9).fill({ type: 'rsi' }) }],
    ['an unknown indicator', { indicators: [{ type: 'ichimoku' }] }],
    ['a param of another indicator', { indicators: [{ type: 'rsi', fast: 3 }] }],
    ['a period over the cap', { indicators: [{ type: 'ema', period: 201 }] }],
    ['a fractional period', { indicators: [{ type: 'sma', period: 2.5 }] }],
    ['macd with fast >= slow', { indicators: [{ type: 'macd', fast: 26 }] }],
    ['a lookback over the cap', { lookback: 501 }],
    ['a series over the cap', { series: 21 }],
  ])('refuses %s as invalid input', async (_name, patch) => {
    const md = fakeMarketData();
    const h = await harness(md.marketData);
    const args = {
      venue: 'kuru',
      market: MON_USDC,
      timeframes: ['1h'],
      indicators: [{ type: 'rsi' }],
      ...patch,
    };
    expect(refusal(await h.call(args))).toBe('invalid_input');
    expect(md.calls).toEqual([]);
  });

  it('turns an unknown market into invalid input', async () => {
    // A mandate cannot name a market the venue lacks on Kuru, so the case is
    // a Perpl symbol the mandate lists but the venue no longer serves.
    const md = fakeMarketData();
    const h = await harness(md.marketData);
    const agent = testAgent();
    const ctx = {
      ...h.ctx,
      currentAgent: () =>
        Promise.resolve({
          ...agent,
          mandate: {
            ...agent.mandate,
            perpl: { ...agent.mandate.perpl, markets: [...agent.mandate.perpl.markets, 'NOPE'] },
          },
        }),
    };
    const outcome = await tool.invoke(ctx, {
      venue: 'perpl',
      market: 'NOPE',
      timeframes: ['1h'],
      indicators: [{ type: 'rsi' }],
    });
    expect(refusal(outcome)).toBe('invalid_input');
  });
});
