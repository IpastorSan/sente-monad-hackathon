import { computeIndicator, type Candle } from '../tools/indicators';
import { checkWatchers, type WatcherReads } from './watcher-eval';
import type { StoredWatcher } from './watcher-store';
import { watcherInput, type WatcherInput } from './watcher.schema';

const T0 = Date.parse('2026-10-09T10:00:00.000Z');
const MIN = 60_000;

function watcher(input: WatcherInput & { id?: string }): StoredWatcher {
  const parsed = watcherInput.parse(input);
  return {
    id: input.id ?? 'w1',
    label: parsed.label,
    match: parsed.match,
    clauses: parsed.clauses,
    cooldownMinutes: parsed.cooldownMinutes,
    setBy: 'agent',
    createdAt: T0,
    edges: parsed.clauses.map(() => null),
    lastEvaluatedAt: null,
    lastFiredAt: null,
    fireCount: 0,
    lastObserved: null,
    lastError: null,
  };
}

/** Reads whose answers a test moves between checks. */
function reads(state: {
  mark?: number | null;
  last?: number | null;
  candles?: Candle[];
  positions?: { symbol: string; pnlPct: number | null }[] | Error;
  funding?: number | null;
  fail?: boolean;
}) {
  const calls: string[] = [];
  const fail = () => Promise.reject(new Error('venue down'));
  const r: WatcherReads = {
    prices: (venue, market) => {
      calls.push(`prices ${venue} ${market}`);
      if (state.fail) return fail();
      return Promise.resolve({ last: state.last ?? state.mark ?? null, mark: state.mark ?? null });
    },
    candles: (venue, market, tf) => {
      calls.push(`candles ${venue} ${market} ${tf}`);
      if (state.fail) return fail();
      return Promise.resolve(state.candles ?? []);
    },
    positions: () => {
      calls.push('positions');
      if (state.positions instanceof Error) return Promise.reject(state.positions);
      return Promise.resolve(state.positions ?? []);
    },
    funding: (market) => {
      calls.push(`funding ${market}`);
      return Promise.resolve(state.funding ?? null);
    },
  };
  return { reads: r, calls };
}

/** Runs one watcher through a sequence of checks, a minute apart; returns which checks fired. */
async function run(w: StoredWatcher, steps: Parameters<typeof reads>[0][], stepMs = MIN) {
  let current = w;
  const fired: number[] = [];
  const observed: string[] = [];
  for (const [i, step] of steps.entries()) {
    const result = await checkWatchers([current], reads(step).reads, T0 + i * stepMs);
    current = result.watchers[0]!;
    if (result.fired.length > 0) {
      fired.push(i);
      observed.push(result.fired[0]!.observed);
    }
  }
  return { fired, observed, final: current };
}

const CROSS_ABOVE_100 = watcher({
  label: 'breakout',
  clauses: [{ type: 'price', venue: 'perpl', market: 'BTC-PERP', op: 'crosses_above', value: 100 }],
  cooldownMinutes: 1,
});

describe('checking watchers (SEN-182)', () => {
  it('fires a crossing once, on the check where it flips, never on the first check', async () => {
    const marks = [101, 99, 99.5, 100.5, 102, 98, 103];
    const { fired, observed, final } = await run(
      CROSS_ABOVE_100,
      marks.map((mark) => ({ mark })),
    );
    // 101 first: already above, but no edge has been seen yet. 99→100.5 and 98→103 are the crosses.
    expect(fired).toEqual([3, 6]);
    expect(observed[0]).toBe('BTC-PERP mark 100.5 crossed above 100');
    expect(final).toMatchObject({ fireCount: 2, edges: [true], lastObserved: observed[1] });
  });

  it('keeps the edge across an unreadable check, so an outage neither fires nor hides a cross', async () => {
    const { fired } = await run(CROSS_ABOVE_100, [
      { mark: 99 },
      { fail: true },
      { mark: 101 }, // below before the outage, above after: one cross
      { fail: true },
      { mark: 102 },
    ]);
    expect(fired).toEqual([2]);
  });

  it('records the edge during a cooldown, so a cross there is consumed, not reported late', async () => {
    const w = { ...CROSS_ABOVE_100, cooldownMinutes: 10 };
    const { fired } = await run(w, [
      { mark: 99 },
      { mark: 101 }, // fires
      { mark: 99 },
      { mark: 101 }, // crosses inside the cooldown: not fired
      { mark: 102 }, // still above: no new edge
    ]);
    expect(fired).toEqual([1]);
  });

  it('fires a level while it holds, at most once per cooldown', async () => {
    const w = watcher({
      label: 'cheap',
      clauses: [{ type: 'price', venue: 'kuru', market: 'MON-USDC', op: 'below', value: 3 }],
      cooldownMinutes: 15,
    });
    // One check every 5 minutes, all below 3.
    const { fired, observed } = await run(w, Array(8).fill({ mark: 2.9 }), 5 * MIN);
    expect(fired).toEqual([0, 3, 6]);
    expect(observed[0]).toBe('MON-USDC mark 2.9 is below 3');
  });

  it('joins clauses with all or any', async () => {
    const clauses: WatcherInput['clauses'] = [
      { type: 'price', venue: 'perpl', market: 'BTC-PERP', op: 'above', value: 100 },
      { type: 'funding', market: 'BTC-PERP', op: 'above', value: 0.01 },
    ];
    const all = watcher({ label: 'x', clauses });
    const any = watcher({ label: 'x', match: 'any', clauses });
    const step = { mark: 101, funding: 0.005 };
    expect((await run(all, [step])).fired).toEqual([]);
    expect((await run(any, [step])).observed).toEqual(['BTC-PERP mark 101 is above 100']);
    expect((await run(all, [{ mark: 101, funding: 0.02 }])).observed).toEqual([
      'BTC-PERP mark 101 is above 100; BTC-PERP funding 0.02%/8h is above 0.01%/8h',
    ]);
  });

  it('reads each market once per check, however many clauses share it', async () => {
    const w = watcher({
      label: 'x',
      clauses: [
        { type: 'price', venue: 'perpl', market: 'BTC-PERP', op: 'above', value: 1 },
        {
          type: 'price',
          venue: 'perpl',
          market: 'BTC-PERP',
          source: 'last',
          op: 'below',
          value: 9,
        },
      ],
    });
    const r = reads({ mark: 5 });
    await checkWatchers([w, { ...w, id: 'w2' }], r.reads, T0);
    expect(r.calls).toEqual(['prices perpl BTC-PERP']);
  });

  it('fires band entries and exits on the flip', async () => {
    const leaves = watcher({
      label: 'range break',
      clauses: [
        { type: 'price_band', venue: 'kuru', market: 'MON-USDC', op: 'leaves', low: 3, high: 4 },
      ],
      cooldownMinutes: 1,
    });
    const { fired, observed } = await run(leaves, [
      { mark: 3.5 },
      { mark: 3.9 },
      { mark: 4.1 },
      { mark: 4.2 },
      { mark: 3.5 },
      { mark: 2.9 },
    ]);
    expect(fired).toEqual([2, 5]);
    expect(observed[0]).toBe('MON-USDC mark 4.1 left 3–4');
  });

  it('sees a position open and close, and its P&L against a % of margin', async () => {
    const opened = watcher({
      label: 'filled',
      clauses: [{ type: 'position', market: 'BTC-PERP', op: 'opened' }],
      cooldownMinutes: 1,
    });
    const open = { positions: [{ symbol: 'BTC-PERP', pnlPct: 2 }] };
    const flat = { positions: [] };
    expect((await run(opened, [flat, open, open, flat, open])).fired).toEqual([1, 4]);

    const closed = watcher({
      label: 'out',
      clauses: [{ type: 'position', market: 'BTC-PERP', op: 'closed' }],
      cooldownMinutes: 1,
    });
    expect((await run(closed, [open, flat, flat])).fired).toEqual([1]);

    const stop = watcher({
      label: 'stop',
      clauses: [{ type: 'position', market: 'BTC-PERP', op: 'pnl_below', value: -5 }],
    });
    const result = await run(stop, [{ positions: [{ symbol: 'BTC-PERP', pnlPct: -6.25 }] }]);
    expect(result.observed).toEqual(['your BTC-PERP P&L -6.25% of margin is below -5%']);
    // No position, or no Perpl account: unknown, not fired.
    const none = await run(stop, [flat, { positions: new Error('no Perpl') }]);
    expect(none.fired).toEqual([]);
    expect(none.final.lastError).toMatch(/no Perpl/);
  });

  it('crosses one indicator output over another with the get_indicators math', async () => {
    // Up, down, up again: the MACD line crosses its signal both ways.
    const closes = [
      ...Array.from({ length: 60 }, (_, i) => 100 + i),
      ...Array.from({ length: 40 }, (_, i) => 160 - 2 * i),
      ...Array.from({ length: 40 }, (_, i) => 80 + 2 * i),
    ];
    const candles: Candle[] = closes.map((close, i) => ({
      t: T0 + i * 15 * MIN,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10,
    }));
    const spec = { type: 'macd', fast: 12, slow: 26, signal: 9 } as const;
    // Where the line goes from at-or-below the signal to above it, by the shared math alone.
    const expected: number[] = [];
    let previous: boolean | null = null;
    for (let n = 30; n <= candles.length; n++) {
      const { outputs } = computeIndicator(spec, candles.slice(0, n));
      const line = outputs['line']!.values.at(-1)!;
      const signal = outputs['signal']!.values.at(-1)!;
      if (!Number.isFinite(line) || !Number.isFinite(signal)) continue;
      const above = line > signal;
      if (previous === false && above) expected.push(n);
      previous = above;
    }
    expect(expected.length).toBeGreaterThan(0);

    const w = watcher({
      label: 'MACD 15m cross',
      clauses: [
        {
          type: 'indicator',
          venue: 'perpl',
          market: 'BTC-PERP',
          timeframe: '15m',
          indicator: { type: 'macd' },
          output: 'line',
          op: 'crosses_above',
          compareTo: { indicator: { type: 'macd' }, output: 'signal' },
        },
      ],
      cooldownMinutes: 1,
    });
    const steps = Array.from({ length: candles.length - 29 }, (_, i) => ({
      candles: candles.slice(0, 30 + i),
    }));
    const { fired, observed } = await run(w, steps);
    expect(fired.map((i) => 30 + i)).toEqual(expected);
    expect(observed[0]).toMatch(
      /^BTC-PERP 15m macd\(12,26,9\)\.line -?[\d.]+ crossed above macd\(12,26,9\)\.signal -?[\d.]+$/,
    );
  });

  it('treats an indicator without enough candles as unknown', async () => {
    const w = watcher({
      label: 'oversold',
      clauses: [
        {
          type: 'indicator',
          venue: 'kuru',
          market: 'MON-USDC',
          timeframe: '5m',
          indicator: { type: 'rsi' },
          output: 'value',
          op: 'below',
          value: 30,
        },
      ],
    });
    const few: Candle[] = [1, 2, 3].map((c, i) => ({
      t: i,
      open: c,
      high: c,
      low: c,
      close: c,
      volume: 1,
    }));
    const { fired, final } = await run(w, [{ candles: few }]);
    expect(fired).toEqual([]);
    expect(final.lastError).toMatch(/rsi\(14\) needs 15 candles and has 3/);
  });
});
