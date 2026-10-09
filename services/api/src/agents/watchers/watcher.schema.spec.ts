import { testAgent } from '../tools/testing/agent-fixture';
import { symbolInMandate } from '../tools/registry';
import {
  checkUniqueIds,
  checkWatcher,
  describeWatcher,
  formatNumber,
  isEdge,
  outputsOf,
  watcherInput,
  WatcherInvalidError,
  watcherSetInput,
  type MandateScope,
  type ParsedWatcher,
} from './watcher.schema';

// The fixture mandate: MON-USDC on Kuru, BTC-PERP on Perpl.
const agent = testAgent();
const scope: MandateScope = (venue, market) => {
  if (!agent.mandate.venues.includes(venue)) return 'venue';
  return symbolInMandate(agent.mandate, venue, market) ? 'ok' : 'market';
};

function parse(raw: unknown): ParsedWatcher {
  return watcherInput.parse(raw);
}

function check(raw: unknown): ParsedWatcher {
  return checkWatcher(parse(raw), scope);
}

function refusal(raw: unknown): { code: string; message: string } {
  try {
    check(raw);
  } catch (error) {
    if (error instanceof WatcherInvalidError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected a refusal');
}

const MACD_CROSS = {
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
      compareTo: { output: 'signal' },
    },
  ],
};

describe('watcher conditions (SEN-182)', () => {
  it('fills the defaults: match all, a 60 min cooldown, the mark price, macd(12,26,9)', () => {
    const watcher = check(MACD_CROSS);
    expect(watcher).toMatchObject({ match: 'all', cooldownMinutes: 60 });
    expect(watcher.clauses[0]).toMatchObject({
      indicator: { type: 'macd', fast: 12, slow: 26, signal: 9 },
      // compareTo defaults to the same indicator, resolved so evaluation never guesses.
      compareTo: { indicator: { type: 'macd', fast: 12, slow: 26, signal: 9 }, output: 'signal' },
    });
    expect(
      check({
        label: 'dip',
        clauses: [{ type: 'price', venue: 'kuru', market: 'MON-USDC', op: 'below', value: 3 }],
      }).clauses[0],
    ).toMatchObject({ source: 'mark' });
  });

  it('accepts every clause type, composed with all/any', () => {
    const watcher = check({
      label: 'oversold in range, or funding flips',
      match: 'any',
      clauses: [
        {
          type: 'indicator',
          venue: 'kuru',
          market: 'MON-USDC',
          timeframe: '5m',
          indicator: { type: 'rsi', period: 14 },
          op: 'below',
          value: 30,
        },
        {
          type: 'price_band',
          venue: 'kuru',
          market: 'MON-USDC',
          source: 'last',
          op: 'leaves',
          low: 3,
          high: 4,
        },
        { type: 'position', market: 'BTC-PERP', op: 'pnl_below', value: -5 },
        { type: 'funding', market: 'BTC-PERP', op: 'above', value: 0.01 },
      ],
      cooldownMinutes: 15,
    });
    // A one-value indicator's output is `value`, filled in.
    expect(watcher.clauses[0]).toMatchObject({ output: 'value' });
    expect(describeWatcher(watcher)).toBe(
      'MON-USDC 5m rsi(14) is below 30 or MON-USDC last leaves 3–4 or your BTC-PERP P&L is ' +
        'below -5% of margin or BTC-PERP funding is above 0.01%/8h',
    );
  });

  it('keeps every market inside the mandate', () => {
    expect(
      refusal({
        label: 'x',
        clauses: [{ type: 'price', venue: 'kuru', market: 'WETH-USDC', op: 'above', value: 1 }],
      }),
    ).toMatchObject({ code: 'market_not_allowed', message: expect.stringMatching(/WETH-USDC/) });
    expect(
      refusal({
        label: 'x',
        clauses: [{ type: 'funding', market: 'ETH-PERP', op: 'above', value: 0 }],
      }).code,
    ).toBe('market_not_allowed');

    const kuruOnly: MandateScope = (venue) => (venue === 'kuru' ? 'ok' : 'venue');
    expect(() =>
      checkWatcher(
        parse({ label: 'x', clauses: [{ type: 'position', market: 'BTC-PERP', op: 'opened' }] }),
        kuruOnly,
      ),
    ).toThrow(expect.objectContaining({ code: 'venue_not_allowed' }));
  });

  it('refuses operands that do not fit the op', () => {
    const indicator = (patch: Record<string, unknown>) => ({
      label: 'x',
      clauses: [
        {
          type: 'indicator',
          venue: 'kuru',
          market: 'MON-USDC',
          timeframe: '15m',
          indicator: { type: 'macd' },
          op: 'above',
          ...patch,
        },
      ],
    });
    expect(refusal(indicator({ output: 'line' })).message).toMatch(/exactly one of value/);
    expect(
      refusal(indicator({ output: 'line', value: 0, compareTo: { output: 'signal' } })).message,
    ).toMatch(/exactly one of value/);
    expect(refusal(indicator({ value: 0 })).message).toMatch(/several outputs; name one of line/);
    expect(refusal(indicator({ output: 'k', value: 0 })).message).toMatch(/has no output "k"/);
    expect(refusal(indicator({ output: 'line', compareTo: { output: 'line' } })).message).toMatch(
      /compared with itself/,
    );
    expect(
      refusal(
        indicator({ indicator: { type: 'macd', fast: 30, slow: 26 }, output: 'line', value: 0 }),
      ).message,
    ).toMatch(/fast < slow/);
    expect(
      refusal({
        label: 'x',
        clauses: [
          {
            type: 'indicator',
            venue: 'perpl',
            market: 'BTC-PERP',
            timeframe: '1w',
            indicator: { type: 'rsi' },
            op: 'above',
            value: 70,
          },
        ],
      }).message,
    ).toMatch(/no 1w/);
    expect(
      refusal({
        label: 'x',
        clauses: [
          { type: 'price_band', venue: 'kuru', market: 'MON-USDC', op: 'inside', low: 4, high: 3 },
        ],
      }).message,
    ).toMatch(/low < high/);
    expect(
      refusal({ label: 'x', clauses: [{ type: 'position', market: 'BTC-PERP', op: 'pnl_above' }] })
        .message,
    ).toMatch(/need a value/);
    expect(
      refusal({
        label: 'x',
        clauses: [{ type: 'position', market: 'BTC-PERP', op: 'opened', value: 1 }],
      }).message,
    ).toMatch(/take none/);
  });

  it('bounds the set: 8 watchers, 4 clauses, a 1-24 h heartbeat, unique ids', () => {
    const price = { type: 'price', venue: 'kuru', market: 'MON-USDC', op: 'above', value: 1 };
    const one = { label: 'x', clauses: [price] };
    expect(watcherSetInput.safeParse({ watchers: Array(8).fill(one) }).success).toBe(true);
    expect(watcherSetInput.safeParse({ watchers: Array(9).fill(one) }).success).toBe(false);
    expect(watcherInput.safeParse({ label: 'x', clauses: Array(5).fill(price) }).success).toBe(
      false,
    );
    expect(watcherInput.safeParse({ label: 'x', clauses: [] }).success).toBe(false);
    expect(watcherSetInput.safeParse({ watchers: [], heartbeatHours: 0.5 }).success).toBe(false);
    expect(watcherSetInput.safeParse({ watchers: [], heartbeatHours: 25 }).success).toBe(false);
    expect(watcherInput.safeParse({ ...one, cooldownMinutes: 0 }).success).toBe(false);
    expect(watcherInput.safeParse({ ...one, extra: true }).success).toBe(false);
    expect(() => checkUniqueIds([{ id: 'a' }, { id: 'b' }, {}, {}])).not.toThrow();
    expect(() => checkUniqueIds([{ id: 'a' }, { id: 'a' }])).toThrow(/share the id/);
  });

  it('knows its edges from its levels', () => {
    const edge = (op: string) =>
      isEdge(
        parse({
          label: 'x',
          clauses: [{ type: 'price', venue: 'kuru', market: 'M', op, value: 1 }],
        }).clauses[0]!,
      );
    expect(edge('crosses_above')).toBe(true);
    expect(edge('crosses_below')).toBe(true);
    expect(edge('above')).toBe(false);
    expect(edge('below')).toBe(false);
  });

  it('names the outputs as get_indicators does, and prints numbers without exponents', () => {
    expect(outputsOf({ type: 'macd', fast: 12, slow: 26, signal: 9 })).toEqual([
      'line',
      'signal',
      'histogram',
    ]);
    expect(outputsOf({ type: 'rsi', period: 14 })).toEqual(['value']);
    expect(formatNumber(101234.56789)).toBe('101234.57');
    expect(formatNumber(1.23456789)).toBe('1.23457');
    expect(formatNumber(0.0000123456)).toBe('0.0000123456');
    expect(formatNumber(-0)).toBe('0');
  });
});
