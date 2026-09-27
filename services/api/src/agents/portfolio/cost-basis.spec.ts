import type { AgentEvent } from '../events/agent-event-log';
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
    expect(fifoCostBasis([fill('buy', '10', '3.25')], MON)).toEqual({
      market: MON,
      openSize: '10',
      avgPrice: '3.25',
      costQuote: '32.5',
      realisedPnl: '0',
      unmatchedSellSize: '0',
      fills: 1,
    });
  });

  it('consumes the oldest lot first, partially across two lots', () => {
    const basis = fifoCostBasis(
      [fill('buy', '10', '2'), fill('buy', '10', '4'), fill('sell', '15', '5')],
      MON,
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
    const basis = fifoCostBasis([fill('buy', '1', '3'), fill('sell', '4', '2.5')], MON);
    expect(basis).toMatchObject({
      openSize: '0',
      avgPrice: null,
      costQuote: '0',
      realisedPnl: '-0.5',
      unmatchedSellSize: '3',
    });
  });

  it('adds quote buy fees to cost and nets quote sell fees off the realised PnL', () => {
    const basis = fifoCostBasis(
      [
        fill('buy', '10', '2', { fee: '0.5', feeAsset: 'USDC' }),
        fill('sell', '5', '3', { fee: '0.1', feeAsset: 'USDC' }),
      ],
      MON,
    );
    // Lot cost 20.5 for 10; half leaves at 10.25, sells for 15, less 0.1 fee.
    expect(basis).toMatchObject({
      openSize: '5',
      costQuote: '10.25',
      avgPrice: '2.05',
      realisedPnl: '4.65',
    });
  });

  it('leaves base-denominated fees out of the quote ledger', () => {
    const basis = fifoCostBasis([fill('buy', '10', '2', { fee: '0.01', feeAsset: 'MON' })], MON);
    expect(basis.costQuote).toBe('20');
  });

  it('ignores Perpl fills, other markets and non-fill events', () => {
    const events: AgentEvent[] = [
      fill('buy', '1', '100', { venue: 'perpl', leverage: 5 }),
      fill('buy', '1', '100', { symbol: 'ETH-USDC' }),
      { ...fill('buy', '1', '100'), kind: 'close' },
      fill('buy', '2', '3'),
    ];
    expect(fifoCostBasis(events, MON)).toMatchObject({ openSize: '2', costQuote: '6', fills: 1 });
  });

  it('reads the log in seq order, not array order', () => {
    const buy = fill('buy', '1', '2');
    const sell = fill('sell', '1', '3');
    expect(fifoCostBasis([sell, buy], MON)).toMatchObject({
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
    );
    expect(basis.openSize).toBe('3.3');
    expect(basis.costQuote).toBe('1.039999999999999999');
    expect(basis.avgPrice).toBe('0.315151515151515151');
  });

  it('counts but skips fills it cannot read', () => {
    const basis = fifoCostBasis(
      [fill('buy', '1', '2'), fill('buy', 'lots', '2'), fill('buy', '1', undefined as never)],
      MON,
    );
    expect(basis).toMatchObject({ openSize: '1', fills: 3 });
  });
});

describe('reconcileHolding (SEN-66)', () => {
  it('is complete when the log explains the whole holding', () => {
    const basis = fifoCostBasis([fill('buy', '10', '2')], MON);
    expect(reconcileHolding(basis, '10', '2.5')).toEqual({
      coveredSize: '10',
      uncoveredSize: '0',
      avgPrice: '2',
      unrealizedPnl: '5',
      complete: true,
    });
  });

  it('is incomplete when more is held than the log explains', () => {
    const basis = fifoCostBasis([fill('buy', '10', '2')], MON);
    expect(reconcileHolding(basis, '25', '1.5')).toEqual({
      coveredSize: '10',
      uncoveredSize: '15',
      avgPrice: '2',
      unrealizedPnl: '-5',
      complete: false,
    });
  });

  it('covers only what is held when the log says more is open', () => {
    const basis = fifoCostBasis([fill('buy', '10', '2')], MON);
    expect(reconcileHolding(basis, '4', null)).toEqual({
      coveredSize: '4',
      uncoveredSize: '0',
      avgPrice: '2',
      unrealizedPnl: null,
      complete: true,
    });
  });

  it('has no average or PnL for a holding the log has no lots for', () => {
    const basis = fifoCostBasis([], MON);
    expect(reconcileHolding(basis, '7', '3')).toEqual({
      coveredSize: '0',
      uncoveredSize: '7',
      avgPrice: null,
      unrealizedPnl: null,
      complete: false,
    });
  });

  it('rejects a held size that is not a decimal', () => {
    expect(() => reconcileHolding(fifoCostBasis([], MON), '-1', null)).toThrow(RangeError);
  });
});
