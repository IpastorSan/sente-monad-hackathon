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
    // Perpl's dpnl is PRICE PnL, so the fills' fees come off it exactly as they
    // do on Kuru (SEN-33): one verdict row, one definition of PnL.

    const [verdict] = settle(events);

    expect(verdict).toMatchObject({
      market: BTC,
      venue: 'perpl',
      direction: 'long',
      // Perpl's settled dpnl less funding paid (-0.3 is funding RECEIVED),
      // less the 0.05 AUSD taker fee the opening fill paid.
      realisedPnl: '12.75',
      pnlAsset: 'AUSD',
      costBasis: '60',
      fills: 2,
      held: true,
    });
    expect(verdict!.closedAt).toBe(events[3]!.at);
    // Nothing to qualify: one position, opened and closed by this thesis.
    expect(verdict!.notes).toBeUndefined();
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

  it('groups by agent, and gives each thesis the fills logged after it', () => {
    // Built in log order: `seq` is what `settle` sorts by, so a fixture that
    // allocates its theses up front would not be the log this describes.
    const first = thesis({}, { runId: 'run-1' });
    const firstFills = [
      fill('buy', '1', '3', {}, { runId: 'run-1' }),
      fill('sell', '1', '4', {}, { runId: 'run-1' }),
    ];
    const second = thesis({}, { runId: 'run-2' });
    const secondFills = [
      fill('buy', '1', '3', {}, { runId: 'run-2' }),
      fill('sell', '1', '2', {}, { runId: 'run-2' }),
    ];
    const other = event({
      kind: 'thesis',
      agentId: 'agent-2',
      runId: 'run-1',
      detail: { market: MON, direction: 'long', thesis: 'Same idea, another agent.' },
    });

    const verdicts = settle([first, ...firstFills, second, ...secondFills, other]);

    // One market, one agent, two ideas one after the other: still two verdicts,
    // each carrying the run its thesis was recorded in. The other agent's
    // thesis has no fills to pair with, so it settles nothing.
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

  it('settles an over-close instead of leaving the thesis open for ever (SEN-33)', () => {
    // Base the agent held before the thesis: 3 of the 5 have a cost here, and
    // the other 2 are not this thesis's to price. The net is clamped at zero
    // rather than driven to -2, which no later fill could bring back.
    const events = [thesis(), fill('buy', '3', '2'), fill('sell', '5', '3')];
    const [verdict] = settle(events);

    expect(verdict).toMatchObject({ realisedPnl: '3', costBasis: '6', held: true });
    expect(verdict!.closedAt).toBe(events[2]!.at);
    // The thesis is settled and the part that could not be priced is said out
    // loud rather than silently folded into the number.
    expect(verdict!.notes).toEqual([expect.stringContaining('2 of size was closed with no lot')]);
  });

  it('credits each Perpl thesis only with the venue PnL that moved since the last close', () => {
    // One position, two ideas. `dpnl` is cumulative over the position's life,
    // so the second close reports the first thesis's money as well and paying
    // it out twice was SEN-33's first defect.
    const first = thesis({ market: BTC });
    const opened = [
      first,
      fill('buy', '0.002', '60000', { venue: 'perpl', symbol: BTC, leverage: 3 }),
      // A partial close: the position stays live, and the venue has realised 1.
      fill('sell', '0.001', '60500', { venue: 'perpl', symbol: BTC, leverage: 3 }),
      close({ realizedPnl: '1', fundingPaid: '0' }),
    ];
    const second = thesis({ market: BTC });
    const rest = [
      fill('sell', '0.001', '62000', { venue: 'perpl', symbol: BTC, leverage: 3 }),
      close({ realizedPnl: '3', fundingPaid: '0' }),
    ];

    const verdicts = settle([...opened, second, ...rest]);

    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toMatchObject({ thesisSeq: first.seq, realisedPnl: '1', held: 'open' });
    // 3 cumulative, less the 1 the first thesis was already credited with.
    expect(verdicts[1]).toMatchObject({ thesisSeq: second.seq, realisedPnl: '2', held: true });
    expect(verdicts[1]!.notes?.[0]).toContain('only that part is this thesis');
  });

  it('tells one position from the next by the id the close names (SEN-33)', () => {
    // The first thesis closed only PART of its position, so nothing resets a
    // market-level baseline before position 7 ends out of band — a liquidation,
    // say — and position 8 opens under the same symbol. Only the venue's own id
    // for the position separates the two counts.
    const perpl = { venue: 'perpl', symbol: BTC, leverage: 3 };
    const trail = (position: (id: string) => Record<string, unknown>) => {
      const first = thesis({ market: BTC });
      const opened = [
        first,
        fill('buy', '0.002', '60000', perpl),
        fill('sell', '0.001', '60500', perpl),
        close({ ...position('7'), realizedPnl: '1' }),
      ];
      const second = thesis({ market: BTC });
      const rest = [
        fill('buy', '0.001', '58000', perpl),
        fill('sell', '0.001', '62000', perpl),
        close({ ...position('8'), realizedPnl: '4' }),
      ];
      return { first, second, verdicts: settle([...opened, second, ...rest]) };
    };

    const named = trail((id) => ({ positionId: id }));
    expect(named.verdicts[0]).toMatchObject({ realisedPnl: '1', held: 'open' });
    // Position 8's own figure, in full: its count started again at nothing.
    expect(named.verdicts[1]).toMatchObject({ realisedPnl: '4', held: true });
    expect(named.verdicts[1]!.notes).toBeUndefined();

    // Without an id — a close from before SEN-33, or one whose final frame
    // never arrived — the two positions share a key and the second is measured
    // against the first's money. That is the number the id exists to fix.
    const unnamed = trail(() => ({}));
    expect(unnamed.verdicts[1]).toMatchObject({ realisedPnl: '3' });
  });

  it('starts the venue baseline again once a position has closed', () => {
    // The fallback for a close that names no position: `dpnl` counts per
    // POSITION, so the thesis after a full close is owed its own close in full
    // — subtracting the last one would invent a loss.
    const first = thesis({ market: BTC });
    const opened = [
      first,
      fill('buy', '0.001', '60000', { venue: 'perpl', symbol: BTC, leverage: 3 }),
      fill('sell', '0.001', '61000', { venue: 'perpl', symbol: BTC, leverage: 3 }),
      close({ realizedPnl: '10' }),
    ];
    const second = thesis({ market: BTC });
    const rest = [
      fill('buy', '0.001', '61000', { venue: 'perpl', symbol: BTC, leverage: 3 }),
      fill('sell', '0.001', '62000', { venue: 'perpl', symbol: BTC, leverage: 3 }),
      close({ realizedPnl: '9' }),
    ];

    const verdicts = settle([...opened, second, ...rest]);

    expect(verdicts.map((v) => [v.thesisSeq, v.realisedPnl, v.held])).toEqual([
      [first.seq, '10', true],
      [second.seq, '9', true],
    ]);
    expect(verdicts[1]!.notes).toBeUndefined();
  });

  it('settles a thesis recorded in one run with a close from a later one (SEN-33)', () => {
    // A scheduled agent is woken tick after tick, and the close lands in
    // whichever one it falls in. Settling by run left these open for ever.
    const recorded = thesis({}, { runId: 'run-1' });
    const events = [
      recorded,
      fill('buy', '10', '3.00', {}, { runId: 'run-1' }),
      fill('sell', '10', '3.40', {}, { runId: 'run-2' }),
    ];

    const verdicts = settle(events);
    const [verdict] = verdicts;

    expect(verdicts).toHaveLength(1);
    expect(verdict).toMatchObject({
      // The run the THESIS was recorded in, not the one that closed it.
      runId: 'run-1',
      thesisSeq: recorded.seq,
      realisedPnl: '4',
      held: true,
    });
    expect(verdict!.closedAt).toBe(events[2]!.at);
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
