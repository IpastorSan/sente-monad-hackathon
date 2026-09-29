import { InMemoryAgentEventLog, NOT_TRUNCATED, type AgentEvent } from './agent-event-log';
import { latestEvents, summariseEvents, SUMMARY_DAY_MS } from './summary';
import { settle } from './verdict';

const NOW = 1_800_000_000_000;

let seq = 0;
beforeEach(() => {
  seq = 0;
});

function event(
  kind: AgentEvent['kind'],
  detail: Record<string, unknown> = {},
  over: Partial<AgentEvent> = {},
): AgentEvent {
  seq += 1;
  return {
    seq,
    agentId: 'agent-1',
    at: NOW - 60_000 + seq,
    kind,
    ...(kind === 'refusal' ? { layer: 'sente' as const } : {}),
    detail,
    ...over,
  };
}

/** An `order` event as `tools/gate.ts#write` records one that landed. */
function order(notional: string, over: Record<string, unknown> = {}): AgentEvent {
  return event('order', {
    status: 'ok',
    precheck: true,
    args: {},
    intent: { venue: 'kuru', kind: 'order', market: '0xabc', notional },
    result: {},
    ...over,
  });
}

/**
 * A `verdict` event whose detail is what `settle` really produced for these
 * events, as `events/settle-fill.ts#recordVerdictFor` spreads it — so the summary is
 * tested against the producer's field names, not a copy of them.
 */
function verdictOf(events: AgentEvent[], at: number): AgentEvent {
  const [verdict] = settle(events);
  if (!verdict || verdict.held === 'open') throw new Error('fixture did not settle');
  return event('verdict', { ...verdict }, { at, tool: 'place_market' });
}

/** A Kuru round trip: long 10 MON at 3.00, out at 3.50, 0.05 of fees. Realises 4.95 USDC. */
function kuruRoundTrip(): AgentEvent[] {
  const kuru = { venue: 'kuru', symbol: 'MON-USDC', type: 'market', status: 'filled' };
  return [
    event('thesis', { market: 'MON-USDC', direction: 'long' }),
    event('fill', {
      ...kuru,
      side: 'buy',
      filledSize: '10',
      averageFillPrice: '3.00',
      fee: '0.03',
      feeAsset: 'USDC',
    }),
    event('fill', {
      ...kuru,
      side: 'sell',
      filledSize: '10',
      averageFillPrice: '3.50',
      fee: '0.02',
      feeAsset: 'USDC',
    }),
  ];
}

/**
 * A Perpl short closed by `close_position`: the venue's `realizedPnl` (its
 * `dpnl`) less `fundingPaid`, net of the fills' fees. Realises -1.75 AUSD.
 */
function perplShort(): AgentEvent[] {
  const perpl = { venue: 'perpl', symbol: 'BTC-PERP', leverage: 3, type: 'market' };
  return [
    event('thesis', { market: 'BTC-PERP', direction: 'short' }),
    event('fill', { ...perpl, side: 'sell', filledSize: '0.001', averageFillPrice: '60000' }),
    event('fill', {
      ...perpl,
      side: 'buy',
      filledSize: '0.001',
      averageFillPrice: '61000',
      fee: '0.25',
      feeAsset: 'AUSD',
    }),
    event('close', {
      ...perpl,
      side: 'buy',
      filledSize: '0.001',
      averageFillPrice: '61000',
      realizedPnl: '-1',
      fundingPaid: '0.5',
      positionId: 'p-1',
    }),
  ];
}

describe('summariseEvents', () => {
  it('summarises an empty log as zeros, with no order and no last event', () => {
    expect(summariseEvents([], NOW, NOT_TRUNCATED)).toEqual({
      trades: 0,
      held: 0,
      theses: 0,
      pnl: { last24h: '0', allTime: '0' },
      largestOrderNotional: null,
      lastEvent: null,
    });
  });

  it('counts fills as trades, refusals of both layers as held, and theses', () => {
    const events = [
      event('thesis', { market: 'MON-USDC' }),
      event('thesis', { market: 'BTC-PERP' }),
      event('fill', { symbol: 'MON-USDC' }),
      event('refusal', { code: 'notional_over_cap' }, { layer: 'sente' }),
      event('refusal', { code: 'policy_violation' }, { layer: 'enclave' }),
      event('close', { symbol: 'BTC-PERP' }),
      event('deposit', { asset: 'USDC' }),
      event('run', { stopReason: 'end_turn' }),
    ];

    expect(summariseEvents(events, NOW, NOT_TRUNCATED)).toMatchObject({
      trades: 1,
      held: 2,
      theses: 2,
    });
  });

  it("sums both venues' verdicts, Kuru's USDC and Perpl's AUSD as one unit", () => {
    const kuru = kuruRoundTrip();
    const perpl = perplShort();
    const events = [...kuru, verdictOf(kuru, NOW - 1000), ...perpl, verdictOf(perpl, NOW - 500)];
    // The producer really did write these, so the fixture pins its field names.
    expect(events[3]!.detail).toMatchObject({ realisedPnl: '4.95', pnlAsset: 'USDC' });
    expect(events[8]!.detail).toMatchObject({ realisedPnl: '-1.75', pnlAsset: 'AUSD' });

    expect(summariseEvents(events, NOW, NOT_TRUNCATED).pnl).toEqual({
      last24h: '3.2',
      allTime: '3.2',
    });
  });

  it('reads the verdict, never the close: Perpl reports cumulative PnL there', () => {
    const perpl = perplShort();
    // Without its verdict, a close's `realizedPnl` counts for nothing.
    expect(summariseEvents(perpl, NOW, NOT_TRUNCATED).pnl.allTime).toBe('0');
  });

  it('puts a verdict exactly a day old in last24h, and one a millisecond older out of it', () => {
    const events = [
      event('verdict', { realisedPnl: '100', pnlAsset: 'USDC' }, { at: NOW - SUMMARY_DAY_MS - 1 }),
      event('verdict', { realisedPnl: '10', pnlAsset: 'AUSD' }, { at: NOW - SUMMARY_DAY_MS }),
      event('verdict', { realisedPnl: '-0.5', pnlAsset: 'USDC' }, { at: NOW }),
    ];

    expect(summariseEvents(events, NOW, NOT_TRUNCATED).pnl).toEqual({
      last24h: '9.5',
      allTime: '109.5',
    });
  });

  it('is exact where a float is not, and leaves out what it cannot sum', () => {
    const events = [
      event('verdict', { realisedPnl: '0.1', pnlAsset: 'USDC' }),
      event('verdict', { realisedPnl: '0.2', pnlAsset: 'USDC' }),
      event('verdict', { realisedPnl: '9007199254740993.000001', pnlAsset: 'AUSD' }),
      // Not a stable, not a decimal, and not a verdict at all.
      event('verdict', { realisedPnl: '1000', pnlAsset: 'MON' }),
      event('verdict', { realisedPnl: 12, pnlAsset: 'USDC' }),
      event('verdict', { pnlAsset: 'USDC' }),
    ];

    expect(summariseEvents(events, NOW, NOT_TRUNCATED).pnl.allTime).toBe('9007199254740993.300001');
  });

  it('nets a day of losses to a negative string', () => {
    const events = [
      event('verdict', { realisedPnl: '-3.25', pnlAsset: 'USDC' }),
      event('verdict', { realisedPnl: '1', pnlAsset: 'AUSD' }),
    ];

    expect(summariseEvents(events, NOW, NOT_TRUNCATED).pnl).toEqual({
      last24h: '-2.25',
      allTime: '-2.25',
    });
  });

  it('takes the largest notional of the orders that landed, compared exactly, not as text', () => {
    const events = [
      order('9.5'),
      order('120.000'),
      order('45'),
      // A venue failure never went anywhere; neither did a cancel or a deposit.
      order('900', { status: 'failed', error: 'reverted' }),
      order('1', { intent: { venue: 'kuru', kind: 'cancel', market: '0xabc' } }),
      order('1', { intent: { venue: 'perpl', kind: 'deposit', market: 'AUSD', amountAtoms: '5' } }),
      // AGENT_PRECHECK=off: the gate built no intent.
      event('order', { status: 'ok', precheck: false, args: {}, result: {} }),
    ];

    expect(summariseEvents(events, NOW, NOT_TRUNCATED).largestOrderNotional).toBe('120.000');
  });

  it('has no largest order when none carries a notional', () => {
    const events = [order('500', { status: 'failed' }), event('fill', {})];
    expect(summariseEvents(events, NOW, NOT_TRUNCATED).largestOrderNotional).toBeNull();
  });

  it('takes the newest event that is not a run summary as the last one', () => {
    const thesis = event('thesis', {});
    const fill = event('fill', { symbol: 'MON-USDC' });
    const events = [thesis, fill, event('run', {}), event('run', {})];

    expect(summariseEvents(events, NOW, NOT_TRUNCATED).lastEvent).toBe(fill);
    expect(summariseEvents([event('run', {})], NOW, NOT_TRUNCATED).lastEvent).toBeNull();
  });
});

describe('latestEvents', () => {
  it('merges several logs newest first, leaves out runs, and stops at the limit', () => {
    const a1 = event('thesis', {}, { agentId: 'a' });
    const b1 = event('fill', {}, { agentId: 'b' });
    const a2 = event('run', {}, { agentId: 'a' });
    const a3 = event('refusal', {}, { agentId: 'a' });
    const b2 = event('deposit', {}, { agentId: 'b' });
    const logs = [
      [a1, a2, a3],
      [b1, b2],
    ];

    expect(latestEvents(logs, 10)).toEqual([b2, a3, b1, a1]);
    expect(latestEvents(logs, 2)).toEqual([b2, a3]);
    expect(latestEvents(logs, 0)).toEqual([]);
    expect(latestEvents([], 5)).toEqual([]);
  });
});

describe('summariseEvents over a truncated log (SEN-129)', () => {
  it('says allTime is partial when the log has dropped events, and only then', async () => {
    const log = new InMemoryAgentEventLog(2);
    for (const pnl of ['100', '1', '2']) {
      await log.append({
        agentId: 'a',
        kind: 'verdict',
        at: NOW,
        detail: { realisedPnl: pnl, pnlAsset: 'USDC' },
      });
    }
    await log.append({
      agentId: 'b',
      kind: 'verdict',
      at: NOW,
      detail: { realisedPnl: '5', pnlAsset: 'USDC' },
    });

    const a = summariseEvents(await log.list('a'), NOW, await log.truncation('a'));
    const b = summariseEvents(await log.list('b'), NOW, await log.truncation('b'));

    expect(a.pnl).toEqual({ last24h: '3', allTime: '3', allTimePartial: true });
    expect(b.pnl).toEqual({ last24h: '5', allTime: '5' });
  });
});
