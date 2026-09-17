import type { AgentEvent } from './agent-event-log';
import { settle, type Verdict } from './verdict';

const MON = 'MON-USDC';
const BTC = 'BTC-PERP';

let seq = 0;
beforeEach(() => {
  seq = 0;
});

function event(init: {
  kind: AgentEvent['kind'];
  detail: Record<string, unknown>;
  agentId?: string;
  runId?: string;
  tool?: string;
  at?: number;
}): AgentEvent {
  seq += 1;
  return {
    seq,
    agentId: init.agentId ?? 'agent-1',
    ...(init.runId !== undefined ? { runId: init.runId } : {}),
    at: init.at ?? 1_700_000_000_000 + seq,
    kind: init.kind,
    ...(init.tool !== undefined ? { tool: init.tool } : {}),
    detail: init.detail,
  };
}

interface Init {
  readonly runId?: string;
}

/** A thesis, as `record_thesis` writes one. */
function thesis(over: Record<string, unknown> = {}, init: Init = {}): AgentEvent {
  return event({
    kind: 'thesis',
    ...init,
    detail: {
      market: MON,
      direction: 'long',
      thesis: 'Breakout above the range high.',
      invalidation: 'Back under 3.00 and it is wrong.',
      ...over,
    },
  });
}

/** A fill, as the gate writes one: Kuru unless the detail says otherwise. */
function fill(
  side: 'buy' | 'sell',
  size: string,
  price: string,
  over: Record<string, unknown> = {},
  init: Init = {},
): AgentEvent {
  return event({
    kind: 'fill',
    ...init,
    detail: {
      venue: 'kuru',
      symbol: MON,
      side,
      type: 'market',
      status: 'filled',
      orderId: 'order-1',
      filledSize: size,
      averageFillPrice: price,
      ...over,
    },
  });
}

/** A Perpl close event, which carries the venue's own realised PnL. */
function close(over: Record<string, unknown> = {}, init: Init = {}): AgentEvent {
  return event({
    kind: 'close',
    tool: 'close_position',
    ...init,
    detail: {
      venue: 'perpl',
      symbol: BTC,
      side: 'sell',
      type: 'market',
      status: 'filled',
      orderId: 'order-2',
      filledSize: '0.001',
      averageFillPrice: '61000',
      ...over,
    },
  });
}

/** The taker fee the venue charged on a fill, as SEN-20 records it. */
const fee = (amount: string, asset = 'USDC') => ({ fee: amount, feeAsset: asset });

describe('settle', () => {
  it('settles a Kuru long by FIFO across partial fills, net of fees', () => {
    const events = [
      thesis(),
      fill('buy', '4', '3.00', fee('0.012')),
      fill('buy', '6', '3.20', fee('0.0192')),
      // 4 of the oldest 4 at 3.00 and 1 of the 6 at 3.20: 4 x 0.50 + 1 x 0.30 = 2.30
      fill('sell', '5', '3.50', fee('0.0175')),
      // What is left is 5 at 3.20: 5 x (3.40 - 3.20) = 1.00
      fill('sell', '5', '3.40', fee('0.017')),
    ];

    const [verdict] = settle(events);

    expect(verdict).toEqual<Verdict>({
      agentId: 'agent-1',
      market: MON,
      venue: 'kuru',
      direction: 'long',
      thesisSeq: events[0]!.seq,
      fills: 4,
      // 2.30 + 1.00 of price PnL, less 0.0657 of taker fees.
      realisedPnl: '3.2343',
      pnlAsset: 'USDC',
      // Entry notional of the two buys, at their fill prices.
      costBasis: '31.2',
      held: true,
      closedAt: events[4]!.at,
    });
  });

  it('realises a short in its own direction: entry minus exit', () => {
    const events = [
      thesis({ direction: 'short' }),
      fill('sell', '10', '4.00', fee('0.02')),
      fill('buy', '10', '3.60', fee('0.018')),
    ];

    const [verdict] = settle(events);

    // Selling first is the entry, so the move that loses money on a long wins
    // it on a short.
    expect(verdict).toMatchObject({
      direction: 'short',
      venue: 'kuru',
      realisedPnl: '3.962',
      costBasis: '40',
      held: true,
    });
    expect(verdict!.closedAt).toBe(events[2]!.at);
  });

  it('says a thesis did not hold when it lost, and when it only broke even', () => {
    const lost = settle([thesis(), fill('buy', '2', '5'), fill('sell', '2', '4.5')])[0];
    expect(lost).toMatchObject({ realisedPnl: '-1', held: false });

    const flat = settle([thesis(), fill('buy', '2', '5', fee('0.01')), fill('sell', '2', '5')])[0];
    // The fee is what makes it a loss: a thesis is judged on the money.
    expect(flat).toMatchObject({ realisedPnl: '-0.01', held: false });
  });

  it('prices a fee the venue charged in the base token at that fill', () => {
    const [verdict] = settle([
      thesis(),
      fill('buy', '10', '3.00', fee('0.01', 'MON')),
      fill('sell', '10', '3.00'),
    ]);

    // 0.01 MON of fee is 0.03 USDC at the 3.00 the fill happened at.
    expect(verdict).toMatchObject({ realisedPnl: '-0.03', held: false });
  });

  it('gives no verdict on an open position: held is "open"', () => {
    const events = [thesis(), fill('buy', '10', '3.5', fee('0.01'))];
    const [open] = settle(events);

    expect(open).toMatchObject({
      fills: 1,
      costBasis: '35',
      // Nothing is realised before the exit, but the fee is already paid.
      realisedPnl: '-0.01',
      held: 'open',
    });
    expect(open!.closedAt).toBeUndefined();

    // A partial exit realises money and is still not a verdict: the thesis has
    // not finished, so `held` waits.
    const partial = settle([...events, fill('sell', '4', '4')])[0];
    expect(partial).toMatchObject({ fills: 2, realisedPnl: '1.99', held: 'open' });
    expect(partial!.closedAt).toBeUndefined();
  });

  it('settles nothing for a thesis that never traded', () => {
    expect(settle([thesis()])).toEqual([]);
  });

  it('settles a Perpl close with the venue dpnl, less funding', () => {
    const events = [
      thesis({ market: BTC }),
      fill('buy', '0.001', '60000', {
        venue: 'perpl',
        symbol: BTC,
        leverage: 3,
        ...fee('0.05', 'AUSD'),
      }),
      // The close leaves two events: the reduce-only fill, and the close
      // itself with the venue's settled PnL.
      fill('sell', '0.001', '61000', {
        venue: 'perpl',
        symbol: BTC,
        leverage: 3,
        reduceOnly: true,
      }),
      close({ realizedPnl: '12.5', fundingPaid: '-0.3', ...fee('0.05', 'AUSD') }),
    ];
    // The fills paid fees and neither is netted: Perpl's dpnl is the settled
    // position, and its fees are the venue's to account for.

    const [verdict] = settle(events);

    expect(verdict).toMatchObject({
      market: BTC,
      venue: 'perpl',
      direction: 'long',
      // Perpl's settled dpnl less funding paid: -0.3 is funding RECEIVED.
      realisedPnl: '12.8',
      pnlAsset: 'AUSD',
      costBasis: '60',
      fills: 2,
      held: true,
    });
    expect(verdict!.closedAt).toBe(events[3]!.at);
  });

  it('reads a Perpl loss off the close as a loss', () => {
    const [verdict] = settle([
      thesis({ market: BTC }),
      fill('buy', '0.001', '60000', { venue: 'perpl', symbol: BTC, leverage: 3 }),
      fill('sell', '0.001', '59000', { venue: 'perpl', symbol: BTC, leverage: 3 }),
      close({ realizedPnl: '-8.25', fundingPaid: '0.75' }),
    ]);
    expect(verdict).toMatchObject({ realisedPnl: '-9', held: false });
  });

  it('leaves a Perpl position open until the venue closes it', () => {
    const [verdict] = settle([
      thesis({ market: BTC }),
      fill('buy', '0.001', '60000', { venue: 'perpl', symbol: BTC, leverage: 3 }),
    ]);
    expect(verdict).toMatchObject({ venue: 'perpl', realisedPnl: '0', held: 'open' });
    expect(verdict!.closedAt).toBeUndefined();
  });

  it('settles a Perpl close of a position the thesis did not open itself', () => {
    // The position was live when the thesis was recorded, so there is no lot
    // of its own to net out: the venue's close is the word on it.
    const [verdict] = settle([
      thesis({ market: BTC }),
      fill('sell', '0.001', '61000', {
        venue: 'perpl',
        symbol: BTC,
        leverage: 3,
        reduceOnly: true,
      }),
      close({ realizedPnl: '4.2', fundingPaid: '0.2' }),
    ]);
    expect(verdict).toMatchObject({ realisedPnl: '4', held: true, fills: 1 });
  });

  it('settles two theses on one market in one run apart, and skips one that never traded', () => {
    const events = [
      thesis(),
      fill('buy', '10', '3.00'),
      fill('sell', '10', '3.50'),
      thesis({ direction: 'short' }),
      fill('sell', '4', '3.50'),
      fill('buy', '4', '3.80'),
      thesis(), // recorded, never traded
    ];
    const [first, second] = [events[0]!, events[3]!];

    const verdicts = settle(events);

    expect(verdicts.map((v) => v.thesisSeq)).toEqual([first.seq, second.seq]);
    expect(verdicts[0]).toMatchObject({ direction: 'long', realisedPnl: '5', held: true });
    expect(verdicts[1]).toMatchObject({
      direction: 'short',
      // The short was wrong: it sold at 3.50 and bought back at 3.80.
      realisedPnl: '-1.2',
      held: false,
      costBasis: '14',
    });
  });

  it('groups by run and by agent, not by market alone', () => {
    const first = thesis({}, { runId: 'run-1' });
    const second = thesis({}, { runId: 'run-2' });
    const other = event({
      kind: 'thesis',
      agentId: 'agent-2',
      runId: 'run-1',
      detail: { market: MON, direction: 'long', thesis: 'Same idea, another agent.' },
    });
    const events = [
      first,
      fill('buy', '1', '3', {}, { runId: 'run-1' }),
      fill('sell', '1', '4', {}, { runId: 'run-1' }),
      second,
      fill('buy', '1', '3', {}, { runId: 'run-2' }),
      fill('sell', '1', '2', {}, { runId: 'run-2' }),
      other,
    ];

    const verdicts = settle(events);

    // The other agent's thesis has no fills to pair with, so two runs settling
    // the same market stay two verdicts.
    expect(verdicts.map((v) => [v.runId, v.realisedPnl, v.held])).toEqual([
      ['run-1', '1', true],
      ['run-2', '-1', false],
    ]);
    expect(verdicts.every((v) => v.agentId === 'agent-1')).toBe(true);
    expect(verdicts.map((v) => v.thesisSeq)).toEqual([first.seq, second.seq]);
  });

  it('ignores the verdict events it already wrote, so re-settling is stable', () => {
    const events = [thesis(), fill('buy', '10', '3'), fill('sell', '10', '4')];
    const [verdict] = settle(events);
    const written = event({
      kind: 'verdict',
      runId: 'run-1',
      tool: 'close_position',
      detail: { ...verdict! },
    });

    // The gate settles the run again after every close, over a log that now
    // holds the verdicts of the closes before it.
    expect(settle([...events, written])).toEqual([verdict]);
  });

  it('counts a fill it cannot price, and leaves it out of the arithmetic', () => {
    const [verdict] = settle([
      thesis(),
      fill('buy', '10', '3'),
      event({ kind: 'fill', detail: { venue: 'kuru', symbol: MON, side: 'buy' } }),
      fill('sell', '10', '4'),
    ]);
    expect(verdict).toMatchObject({ fills: 3, costBasis: '30', realisedPnl: '10', held: true });
  });

  it('leaves a closing fill with no lot to match out of the arithmetic', () => {
    // Base the agent held before the thesis: 3 of the 5 have a cost here, and
    // the other 2 are not this thesis's to price.
    const [verdict] = settle([thesis(), fill('buy', '3', '2'), fill('sell', '5', '3')]);
    expect(verdict).toMatchObject({ realisedPnl: '3', costBasis: '6', held: 'open' });
  });

  it('reads a Kuru quote out of the symbol, and AUSD out of Perpl', () => {
    const kuru = settle([thesis(), fill('buy', '1', '2')])[0];
    const perpl = settle([
      thesis({ market: 'ETH-PERP' }),
      fill('buy', '1', '2', { venue: 'perpl', symbol: 'ETH-PERP', leverage: 2 }),
    ])[0];
    expect(kuru!.pnlAsset).toBe('USDC');
    expect(perpl!.pnlAsset).toBe('AUSD');
  });
});
