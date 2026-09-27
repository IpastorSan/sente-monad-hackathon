import { InMemoryAgentEventLog, NOT_TRUNCATED, type AgentEvent } from '../events/agent-event-log';
import { settle } from '../events/verdict';
import { fifoCostBasis, reconcileHolding } from './cost-basis';

const MON = 'MON-USDC';

let seq = 0;
beforeEach(() => {
  seq = 0;
});

/** A fill as `gate.ts#fillOf` records it: Kuru unless the detail says otherwise. */
function fill(
  side: 'buy' | 'sell',
  size: string,
  price: string,
  over: Record<string, unknown> = {},
): AgentEvent {
  seq += 1;
  return {
    seq,
    agentId: 'agent-1',
    at: 1_700_000_000_000 + seq,
    kind: 'fill',
    detail: {
      orderId: `o-${seq}`,
      venue: 'kuru',
      symbol: MON,
      side,
      type: 'market',
      status: 'filled',
      filledSize: size,
      averageFillPrice: price,
      ...over,
    },
  };
}

describe('fifoCostBasis (SEN-66)', () => {
  it('prices a single buy at its fill', () => {
    expect(fifoCostBasis([fill('buy', '10', '3.25')], MON, NOT_TRUNCATED)).toEqual({
      market: MON,
      openSize: '10',
      avgPrice: '3.25',
      costQuote: '32.5',
      realisedPnl: '0',
      unmatchedSellSize: '0',
      fills: 1,
      complete: true,
    });
  });

  it('consumes the oldest lot first, partially across two lots', () => {
    const basis = fifoCostBasis(
      [fill('buy', '10', '2'), fill('buy', '10', '4'), fill('sell', '15', '5')],
      MON,
      NOT_TRUNCATED,
    );
    // 10 @ 2 and 5 @ 4 leave: (5-2)*10 + (5-4)*5 = 35; 5 @ 4 stays open.
    expect(basis).toMatchObject({
      openSize: '5',
      avgPrice: '4',
      costQuote: '20',
      realisedPnl: '35',
      unmatchedSellSize: '0',
      fills: 3,
    });
  });

  it('books a sell with no lot behind it as unmatched, realising nothing for it', () => {
    const basis = fifoCostBasis(
      [fill('buy', '1', '3'), fill('sell', '4', '2.5')],
      MON,
      NOT_TRUNCATED,
    );
    expect(basis).toMatchObject({
      openSize: '0',
      avgPrice: null,
      costQuote: '0',
      realisedPnl: '-0.5',
      unmatchedSellSize: '3',
    });
  });

  // SEN-128: the fee rule is `events/verdict.ts`'s, the one verdict cards show.
  it('realises every quote fee when it is paid and keeps lots fee-exclusive', () => {
    const basis = fifoCostBasis(
      [
        fill('buy', '10', '2', { fee: '0.5', feeAsset: 'USDC' }),
        fill('sell', '5', '3', { fee: '0.1', feeAsset: 'USDC' }),
      ],
      MON,
      NOT_TRUNCATED,
    );
    // Half leaves at 2 for 3: +5 of price PnL, less BOTH fees paid so far.
    expect(basis).toMatchObject({
      openSize: '5',
      costQuote: '10',
      avgPrice: '2',
      realisedPnl: '4.4',
    });
  });

  it('prices a base-denominated fee at the fill that paid it', () => {
    const basis = fifoCostBasis(
      [fill('buy', '10', '2', { fee: '0.01', feeAsset: 'MON' })],
      MON,
      NOT_TRUNCATED,
    );
    // 0.01 MON at 2 is 0.02 USDC, realised at once; the lot stays at its fill.
    expect(basis).toMatchObject({ costQuote: '20', realisedPnl: '-0.02' });
  });

  it('reads a fee that names no asset as quote, as the verdict does', () => {
    const basis = fifoCostBasis(
      [fill('buy', '1', '2'), fill('sell', '1', '3', { fee: '0.1' })],
      MON,
      NOT_TRUNCATED,
    );
    expect(basis.realisedPnl).toBe('0.9');
  });

  it('nets the WHOLE fee of an over-sell, not only its matched part', () => {
    const basis = fifoCostBasis(
      [fill('buy', '1', '3'), fill('sell', '4', '2.5', { fee: '0.4', feeAsset: 'USDC' })],
      MON,
      NOT_TRUNCATED,
    );
    // 1 matched at -0.5; 3 unmatched realise nothing, but the 0.4 fee was paid in full.
    expect(basis).toMatchObject({ realisedPnl: '-0.9', unmatchedSellSize: '3' });
  });

  it('ignores Perpl fills, other markets and non-fill events', () => {
    const events: AgentEvent[] = [
      fill('buy', '1', '100', { venue: 'perpl', leverage: 5 }),
      fill('buy', '1', '100', { symbol: 'ETH-USDC' }),
      { ...fill('buy', '1', '100'), kind: 'close' },
      fill('buy', '2', '3'),
    ];
    expect(fifoCostBasis(events, MON, NOT_TRUNCATED)).toMatchObject({
      openSize: '2',
      costQuote: '6',
      fills: 1,
    });
  });

  it('reads the log in seq order, not array order', () => {
    const buy = fill('buy', '1', '2');
    const sell = fill('sell', '1', '3');
    expect(fifoCostBasis([sell, buy], MON, NOT_TRUNCATED)).toMatchObject({
      realisedPnl: '1',
      unmatchedSellSize: '0',
    });
  });

  it('stays exact at 18 dp where floats would drift', () => {
    const basis = fifoCostBasis(
      [
        fill('buy', '0.1', '0.2'),
        fill('buy', '0.2', '0.1'),
        fill('buy', '3', '0.333333333333333333'),
      ],
      MON,
      NOT_TRUNCATED,
    );
    expect(basis.openSize).toBe('3.3');
    expect(basis.costQuote).toBe('1.039999999999999999');
    expect(basis.avgPrice).toBe('0.315151515151515151');
  });

  it('counts but skips fills it cannot read', () => {
    const basis = fifoCostBasis(
      [fill('buy', '1', '2'), fill('buy', 'lots', '2'), fill('buy', '1', undefined as never)],
      MON,
      NOT_TRUNCATED,
    );
    expect(basis).toMatchObject({ openSize: '1', fills: 3 });
  });
});

describe('reconcileHolding (SEN-66)', () => {
  it('is complete when the log explains the whole holding', () => {
    const basis = fifoCostBasis([fill('buy', '10', '2')], MON, NOT_TRUNCATED);
    expect(reconcileHolding(basis, '10', '2.5')).toEqual({
      coveredSize: '10',
      uncoveredSize: '0',
      avgPrice: '2',
      unrealizedPnl: '5',
      complete: true,
    });
  });

  it('is incomplete when more is held than the log explains', () => {
    const basis = fifoCostBasis([fill('buy', '10', '2')], MON, NOT_TRUNCATED);
    expect(reconcileHolding(basis, '25', '1.5')).toEqual({
      coveredSize: '10',
      uncoveredSize: '15',
      avgPrice: '2',
      unrealizedPnl: '-5',
      complete: false,
    });
  });

  it('covers only what is held when the log says more is open', () => {
    const basis = fifoCostBasis([fill('buy', '10', '2')], MON, NOT_TRUNCATED);
    expect(reconcileHolding(basis, '4', null)).toEqual({
      coveredSize: '4',
      uncoveredSize: '0',
      avgPrice: '2',
      unrealizedPnl: null,
      complete: true,
    });
  });

  it('has no average or PnL for a holding the log has no lots for', () => {
    const basis = fifoCostBasis([], MON, NOT_TRUNCATED);
    expect(reconcileHolding(basis, '7', '3')).toEqual({
      coveredSize: '0',
      uncoveredSize: '7',
      avgPrice: null,
      unrealizedPnl: null,
      complete: false,
    });
  });

  it('rejects a held size that is not a decimal', () => {
    expect(() => reconcileHolding(fifoCostBasis([], MON, NOT_TRUNCATED), '-1', null)).toThrow(
      RangeError,
    );
  });
});

/**
 * SEN-129: past `maxPerAgent` the log drops the agent's oldest events, and a
 * FIFO over what is left matches sells against the wrong lots.
 */
describe('cost basis over a truncated log (SEN-129)', () => {
  it('reports no entry and complete: false once the oldest buy was evicted', async () => {
    const log = new InMemoryAgentEventLog(3);
    // The true FIFO: the sell closes the 1.00 lot, leaving 10 @ 5 and 10 @ 2.
    // Without the first buy it closes the 5.00 lot instead: 10 @ 2, covered and
    // "complete" — an entry of 2 for base that cost 5.
    for (const [side, price] of [
      ['buy', '1'],
      ['buy', '5'],
      ['buy', '2'],
      ['sell', '3'],
    ] as const) {
      const { seq: _seq, at: _at, ...event } = fill(side, '10', price);
      await log.append(event);
    }

    const basis = fifoCostBasis(await log.list('agent-1'), MON, await log.truncation('agent-1'));
    expect(basis.complete).toBe(false);
    expect(reconcileHolding(basis, '10', '4')).toEqual({
      coveredSize: '0',
      uncoveredSize: '10',
      avgPrice: null,
      unrealizedPnl: null,
      complete: false,
    });
  });

  it('stays complete while nothing was evicted', async () => {
    const log = new InMemoryAgentEventLog(3);
    const { seq: _seq, at: _at, ...event } = fill('buy', '10', '2');
    await log.append(event);
    const basis = fifoCostBasis(await log.list('agent-1'), MON, await log.truncation('agent-1'));
    expect(reconcileHolding(basis, '10', '4')).toMatchObject({ avgPrice: '2', complete: true });
  });
});

/**
 * SEN-128: the portfolio's ledger and the verdict's realise the same fills, so
 * on a single long thesis over one Kuru market they must report the same
 * realised PnL, fees and over-sells included. No property-testing library is
 * in the API's dev deps, so this is a seeded generator: a failure prints its
 * seed and the history, and replays by that seed.
 */
describe('fifoCostBasis agrees with settle() on realised PnL (SEN-128)', () => {
  /** mulberry32: small, seedable, deterministic. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A positive decimal of up to 4 dp, built as a string so it is exact. */
  function decimal(next: () => number, maxWhole: number): string {
    const units = 1 + Math.floor(next() * maxWhole * 10_000);
    const whole = Math.floor(units / 10_000);
    const fraction = String(units % 10_000).padStart(4, '0');
    return `${whole}.${fraction}`;
  }

  function history(next: () => number): AgentEvent[] {
    seq += 1;
    const thesis: AgentEvent = {
      seq,
      agentId: 'agent-1',
      at: 1_700_000_000_000 + seq,
      kind: 'thesis',
      detail: { market: MON, direction: 'long', thesis: 't', invalidation: 'i' },
    };
    const events = [thesis];
    const count = 1 + Math.floor(next() * 8);
    for (let i = 0; i < count; i += 1) {
      // Sells as often as buys, so over-sells (no lot left) are common.
      const side = next() < 0.5 ? 'buy' : 'sell';
      const feeRoll = next();
      const fee =
        feeRoll < 0.25
          ? {}
          : {
              fee: decimal(next, 1),
              ...(feeRoll < 0.5 ? {} : { feeAsset: feeRoll < 0.75 ? 'USDC' : 'MON' }),
            };
      events.push(fill(side, decimal(next, 20), decimal(next, 10), fee));
    }
    return events;
  }

  it('on 500 seeded single-thesis histories', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      seq = 0;
      const events = history(rng(seed));
      const verdicts = settle(events);
      const basis = fifoCostBasis(events, MON, NOT_TRUNCATED);
      expect({ seed, events, pnl: basis.realisedPnl }).toEqual({
        seed,
        events,
        pnl: verdicts[0]!.realisedPnl,
      });
    }
  });
});
