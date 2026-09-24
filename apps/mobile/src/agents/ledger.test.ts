/**
 * The event -> entry mapping, under plain `node --test`. No device, no API.
 *
 * What these pin is the Ledger's contract with the event trail (SEN-20): which
 * events become rows, which are dropped and why, and that nothing is invented
 * when the venue stayed quiet. The fixture shapes are the ones
 * `services/api/src/agents/tools/gate.ts` actually writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clockTime,
  consensusNeedsPolling,
  demoLedger,
  depositAmount,
  directionLabel,
  heldLabel,
  refusalLayerLabel,
  signedPnl,
  shortHash,
  toLedgerEntries,
  venueLabel,
  type DepositEntry,
  type LedgerEntry,
  type LedgerEntryKind,
  type LedgerEvent,
  type TradeEntry,
} from './ledger.ts';

const AT = Date.parse('2026-09-17T12:00:00.000Z');
const USDC = '0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E';

function event(
  seq: number,
  kind: string,
  detail: Record<string, unknown>,
  extra: Partial<LedgerEvent> = {},
): LedgerEvent {
  return { seq, at: AT + seq * 1_000, kind, detail, ...extra };
}

/** The single entry the events produced, narrowed to the kind it claims. */
function only<K extends LedgerEntryKind>(
  kind: K,
  events: readonly LedgerEvent[],
): Extract<LedgerEntry, { kind: K }> {
  const entries = toLedgerEntries(events);
  assert.equal(entries.length, 1, `expected one entry, got ${entries.length}`);
  const [entry] = entries;
  assert.ok(entry, 'expected an entry');
  assert.equal(entry.kind, kind);
  return entry as Extract<LedgerEntry, { kind: K }>;
}

/** The events produced nothing the Ledger shows. */
function none(events: readonly LedgerEvent[]): void {
  assert.deepEqual(toLedgerEntries(events), []);
}

test('a thesis keeps the agent’s own words, its direction and its invalidation', () => {
  const entry = only('thesis', [
    event(
      7,
      'thesis',
      {
        market: 'MON-USDC',
        direction: 'long',
        thesis: 'Spot is bid, the perp is flat. Buying the range low.',
        invalidation: 'A 15m close below 0.9680.',
        at: AT,
      },
      { runId: 'run-3', tool: 'record_thesis' },
    ),
  ]);

  assert.equal(entry.seq, 7);
  assert.equal(entry.at, AT + 7_000, 'the event timestamp, not the detail one');
  assert.equal(entry.runId, 'run-3');
  assert.equal(entry.market, 'MON-USDC');
  assert.equal(entry.direction, 'long');
  assert.equal(entry.thesis, 'Spot is bid, the perp is flat. Buying the range low.');
  assert.equal(entry.invalidation, 'A 15m close below 0.9680.');
});

test('a fill is a trade: direction off the venue side, with size, price and chain facts', () => {
  const entry = only('trade', [
    event(2, 'fill', {
      orderId: 'ord-1',
      venue: 'perpl',
      symbol: 'BTC-PERP',
      side: 'sell',
      type: 'market',
      status: 'filled',
      filledSize: '0.25',
      averageFillPrice: '61234.5',
      txHash: '0xabcdef',
      blockNumber: 12_345_678,
      leverage: 5,
      fee: '0.42',
      feeAsset: USDC,
    }),
  ]);

  assert.equal(entry.filled, true);
  assert.equal(entry.direction, 'short', 'a sell opens a short');
  assert.equal(entry.venue, 'perpl');
  assert.equal(entry.market, 'BTC-PERP');
  assert.equal(entry.size, '0.25');
  assert.equal(entry.price, '61234.5');
  assert.equal(entry.leverage, 5);
  assert.equal(entry.txHash, '0xabcdef');
  assert.equal(entry.blockNumber, 12_345_678);
  assert.equal(entry.status, 'filled');
  assert.equal(entry.consensus, null, 'an API that sent no consensus block invents none');
});

test('the consensus block rides on the event, so the ramp needs no request of its own', () => {
  // SEN-35: the API attaches this to every order, fill and close that names a
  // block. A finalized row is settled on arrival and asks the API for nothing.
  const at = { proposed: AT, voted: AT + 216, finalized: AT + 510 };
  const fill = only('trade', [
    event(
      2,
      'fill',
      { filledSize: '1', blockNumber: 12_345_678 },
      {
        consensus: { state: 'Finalized', at },
      },
    ),
  ]);
  assert.deepEqual(fill.consensus, { state: 'Finalized', at });

  // A block past the API's window says so rather than going missing.
  const old = only('trade', [
    event(
      3,
      'fill',
      { filledSize: '1', blockNumber: 1 },
      {
        consensus: { state: 'unknown', at: {} },
      },
    ),
  ]);
  assert.deepEqual(old.consensus, { state: 'unknown', at: {} });
});

test('a Ledger of finalized rows asks the API for no consensus at all', () => {
  // The acceptance criterion of SEN-35: 20 finalized rows, zero requests. The
  // ramp polls a row only while `consensusNeedsPolling` is true of it.
  const at = { proposed: AT, voted: AT + 216, finalized: AT + 510 };
  const page = Array.from({ length: 20 }, (_unused, index) =>
    event(
      index + 1,
      'fill',
      { filledSize: '1', blockNumber: 12_345_678 + index },
      {
        consensus: { state: 'Finalized', at },
      },
    ),
  );
  const entries = toLedgerEntries(page) as TradeEntry[];

  assert.equal(entries.length, 20);
  assert.equal(
    entries.filter((entry) => consensusNeedsPolling(entry.consensus)).length,
    0,
    'a finalized row is settled on arrival and never polled',
  );

  // `Verified` is past finality, and a block past the API's window has nothing
  // left to say either. A block still moving is the one case worth a request.
  assert.equal(consensusNeedsPolling({ state: 'Verified', at }), false);
  assert.equal(consensusNeedsPolling({ state: 'unknown', at: {} }), false);
  assert.equal(consensusNeedsPolling({ state: 'Proposed', at: { proposed: AT } }), true);
  assert.equal(consensusNeedsPolling({ state: 'Voted', at: { proposed: AT } }), true);
  // An API older than SEN-21 sends no consensus block: the ramp has to ask.
  assert.equal(consensusNeedsPolling(null), true);
  assert.equal(consensusNeedsPolling(undefined), true);
});

test('a close carries its block and its consensus, so the close row gets a ramp too', () => {
  // SEN-20 gave `close` a block number and SEN-21 did not read it, so closing a
  // position was the one trade whose row had no ramp (SEN-35).
  const at = { proposed: AT, finalized: AT + 480 };
  const entry = only('verdict', [
    event(
      9,
      'close',
      { symbol: 'BTC-PERP', realizedPnl: '-3.25', blockNumber: 12_345_679 },
      {
        consensus: { state: 'Finalized', at },
      },
    ),
  ]);
  assert.equal(entry.blockNumber, 12_345_679);
  assert.deepEqual(entry.consensus, { state: 'Finalized', at });

  // SEN-22's own verdict is a judgement, not a transaction: no block, no ramp.
  const verdict = only('verdict', [event(10, 'verdict', { pnl: '12.4', held: true })]);
  assert.equal(verdict.blockNumber, null);
  assert.equal(verdict.consensus, null);
});

test('a buy reads as a long, and a missing or unknown side is left unknown', () => {
  const long = only('trade', [event(1, 'fill', { side: 'buy', filledSize: '1' })]);
  assert.equal(long.direction, 'long');

  const unknown = only('trade', [event(1, 'fill', { side: 'liquidate', filledSize: '1' })]);
  assert.equal(unknown.direction, null, 'never guessed');
  assert.equal(directionLabel(unknown.direction), '—');
});

test('an order that filled is dropped: its own fill event already carries it', () => {
  none([
    event(1, 'order', {
      status: 'ok',
      tool: 'place_market',
      args: { venue: 'kuru', market: 'MON-USDC', side: 'buy', size: '260.00' },
      result: { id: 'ord-1' },
    }),
  ]);
});

test('a failed order is a trade that did not fill, read from what was asked for', () => {
  const entry = only('trade', [
    event(4, 'order', {
      status: 'failed',
      error: 'slippage exceeded',
      args: {
        venue: 'kuru',
        market: 'MON-USDC',
        side: 'buy',
        size: '260.00',
        slippageLimitPrice: '0.99',
      },
    }),
  ]);

  assert.equal(entry.filled, false);
  assert.equal(entry.status, 'failed');
  assert.equal(entry.market, 'MON-USDC');
  assert.equal(entry.venue, 'kuru');
  assert.equal(entry.direction, 'long');
  assert.equal(entry.size, '260.00');
  assert.equal(entry.price, '0.99', 'the bound that was asked for');
  assert.equal(entry.txHash, null, 'nothing landed, so there is no hash to show');
});

test('a refusal keeps its layer, code and message — and an enclave refusal is not an error', () => {
  const entry = only('refusal', [
    event(
      9,
      'refusal',
      {
        code: 'policy_violation',
        method: 'eth_signTransaction',
        message: 'The enclave refused to sign this transaction.',
        precheck: false,
      },
      { layer: 'enclave', tool: 'place_market', runId: 'run-1' },
    ),
  ]);

  assert.equal(entry.layer, 'enclave');
  assert.equal(entry.code, 'policy_violation');
  assert.equal(entry.message, 'The enclave refused to sign this transaction.');
  assert.equal(entry.tool, 'place_market');
  assert.equal(entry.runId, 'run-1');
  assert.equal(refusalLayerLabel(entry.layer), 'Enclave');
});

test('a refusal that names no layer is credited to sente, never to the enclave', () => {
  const entry = only('refusal', [event(1, 'refusal', { code: 'thesis_required' })]);
  assert.equal(entry.layer, 'sente');
  assert.equal(refusalLayerLabel(entry.layer), 'Sente');
});

test('a close is a verdict carrying the venue’s realised PnL, with held unrecorded', () => {
  const entry = only('verdict', [
    event(5, 'close', {
      symbol: 'BTC-PERP',
      realizedPnl: '-3.25',
      fundingPaid: '0.11',
      filledSize: '0.25',
    }),
  ]);

  assert.equal(entry.pnl, '-3.25');
  assert.equal(
    entry.held,
    null,
    'a close reports the number, not the judgement — that is SEN-22’s verdict',
  );
  assert.equal(heldLabel(entry.held), 'Thesis not recorded');
  assert.equal(entry.market, 'BTC-PERP');
});

test('SEN-22’s verdict maps even though the API’s kind union does not have it yet', () => {
  const held = only('verdict', [event(6, 'verdict', { pnl: '12.4', held: true })]);
  assert.equal(held.pnl, '12.4');
  assert.equal(held.held, true);
  assert.equal(heldLabel(held.held), 'Thesis held');

  const missed = only('verdict', [event(7, 'verdict', { pnl: '-2', held: false })]);
  assert.equal(missed.held, false);
  assert.equal(heldLabel(missed.held), 'Thesis did not hold');
});

test('a verdict with no PnL still renders, showing the held flag alone', () => {
  const entry = only('verdict', [event(1, 'verdict', { held: false })]);
  assert.equal(entry.pnl, null);
  assert.equal(signedPnl(entry.pnl), '—');
});

// ---------------------------------------------------------------------------
// Deposits (SEN-50). The fixture is the `detail` the Alchemy webhook writes:
// `AgentDepositDetail` in `services/api/src/webhooks/alchemy.ts`.

/** One `deposit` detail, exactly as the webhook composes it for a token transfer. */
function depositDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset: 'USDC',
    amount: '250.5',
    rawAmount: '250500000',
    from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    to: '0xEC4b217240f0292c65Bf136b341e400e2D28cA6F',
    tokenAddress: USDC,
    decimals: 6,
    blockNumber: 14_614_179,
    txHash: '0x4f2a9c1e7b3d5086a2f4e9c1b7d3058a6c2e4f9b1d7a30586c2e4f9b1d7a3058',
    category: 'token',
    network: 'MONAD_TESTNET',
    deliveryId: 'whevt_1a2b3c',
    dedupeKey: '0x4f2a:0:0xec4b:250500000',
    ...over,
  };
}

/** The `DepositEntry` that detail maps to, so the formatters are fed real input. */
function deposit(over: Record<string, unknown> = {}): DepositEntry {
  return only('deposit', [event(1, 'deposit', depositDetail(over))]);
}

test('a deposit becomes one entry with its asset, amount, sender and chain facts', () => {
  // The whole of SEN-50: before it, this event reached the phone and rendered as
  // nothing, so the one thing the Alchemy integration exists to show was
  // invisible end to end.
  const entry = only('deposit', [event(12, 'deposit', depositDetail())]);

  assert.equal(entry.seq, 12);
  assert.equal(entry.at, AT + 12_000);
  assert.equal(entry.asset, 'USDC');
  assert.equal(entry.amount, '250.5');
  assert.equal(entry.rawAmount, '250500000');
  assert.equal(entry.decimals, 6);
  assert.equal(entry.from, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  assert.equal(entry.txHash, depositDetail().txHash);
  assert.equal(entry.blockNumber, 14_614_179);
  assert.equal(entry.runId, undefined, 'nothing the agent did caused it, so there is no run');
});

test('a deposit carries its block and its consensus, so the funding row gets the ramp', () => {
  // No API change was needed for this: `withConsensus` attaches consensus to any
  // event whose detail names a block, and a deposit names one (SEN-35, SEN-50).
  const at = { proposed: AT, voted: AT + 204, finalized: AT + 492 };
  const entry = only('deposit', [
    event(3, 'deposit', depositDetail(), { consensus: { state: 'Finalized', at } }),
  ]);

  assert.equal(entry.blockNumber, 14_614_179);
  assert.deepEqual(entry.consensus, { state: 'Finalized', at });
  assert.equal(consensusNeedsPolling(entry.consensus), false, 'settled on arrival');

  // A deposit whose block is still moving is the one worth a request.
  const fresh = only('deposit', [
    event(4, 'deposit', depositDetail(), {
      consensus: { state: 'Proposed', at: { proposed: AT } },
    }),
  ]);
  assert.equal(consensusNeedsPolling(fresh.consensus), true);
});

test('a deposit amount is read from the exact integer, at the precision a balance shows', () => {
  // `rawAmount` is the integer from the log and `amount` is Alchemy's float, so
  // the exact pair decides the figure. USDC shows two places, like every balance.
  assert.equal(depositAmount(deposit()), '+250.50');
  assert.equal(depositAmount(deposit({ rawAmount: '1204500000' })), '+1,204.50');
  // MON gets four places (`BALANCE_PLACES`), because gas amounts live below 0.01.
  assert.equal(
    depositAmount(deposit({ asset: 'MON', rawAmount: '2500000000000000000', decimals: 18 })),
    '+2.5000',
  );
  // Hex is what Alchemy's `rawContract.rawValue` actually carries.
  assert.equal(depositAmount(deposit({ rawAmount: '0xee6b280' })), '+250.00');
});

test('a dust deposit is never truncated to zero', () => {
  // Truncating is right for a balance and a lie for an arrival: `+0.00` for a
  // deposit that did happen says nothing happened, so the token's own precision
  // is shown instead.
  assert.equal(depositAmount(deposit({ rawAmount: '9' })), '+0.000009');
  assert.equal(depositAmount(deposit({ rawAmount: '0' })), '+0.00', 'a real zero stays a zero');
});

test('a deposit with no exact integer falls back to Alchemy’s own figure, ungarbled', () => {
  assert.equal(depositAmount(deposit({ rawAmount: null, amount: '1234.5' })), '+1,234.5');
  assert.equal(
    depositAmount(deposit({ decimals: null, amount: '0.75' })),
    '+0.75',
    'rawAmount means nothing without the token precision',
  );
  // A float JS stringifies as an exponent, and a field that was never a number,
  // are shown as they came rather than rewritten into something else.
  assert.equal(depositAmount(deposit({ rawAmount: null, amount: '1e-7' })), '1e-7');
  assert.equal(depositAmount(deposit({ rawAmount: null, amount: 'later' })), 'later');
  assert.equal(depositAmount(deposit({ rawAmount: null, amount: '' })), '—');
});

test('a malformed deposit renders, invents nothing and throws nothing', () => {
  const entry = only('deposit', [
    event(1, 'deposit', {
      // Alchemy sent no symbol, so the API wrote its `unknown` placeholder: that
      // is not a token name and must not be printed as one.
      asset: 'unknown',
      amount: 5,
      rawAmount: 'not-a-number',
      decimals: 'six',
      blockNumber: 'later',
    }),
  ]);

  assert.equal(entry.asset, null, 'the placeholder is not a symbol');
  assert.equal(entry.amount, '', 'a non-string amount is not stringified into a lie');
  assert.equal(entry.decimals, null);
  assert.equal(entry.from, null);
  assert.equal(entry.txHash, null);
  assert.equal(entry.blockNumber, null, 'no block, so no ramp');
  assert.equal(entry.consensus, null);
  assert.equal(depositAmount(entry), '—');
});

test('a run summary is not a ledger entry, and neither is an unknown kind', () => {
  // A kind this app has never heard of degrades to nothing rather than crashing —
  // which is also how a `deposit` stayed invisible for a while (SEN-50), so a new
  // kind on the server is a change here too, not a free one.
  none([
    event(1, 'run', { stopReason: 'end_turn', iterations: 3, costUsd: 0.04 }),
    event(2, 'something_new', { anything: true }),
    event(3, 'withdrawal', { asset: 'USDC', amount: '5', blockNumber: 14_614_180 }),
  ]);
});

test('entries come back oldest first by seq, whatever order the page was in', () => {
  const entries = toLedgerEntries([
    event(30, 'thesis', { market: 'MON-USDC', thesis: 'third', direction: 'long' }),
    event(10, 'thesis', { market: 'MON-USDC', thesis: 'first', direction: 'long' }),
    event(20, 'thesis', { market: 'MON-USDC', thesis: 'second', direction: 'long' }),
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.kind === 'thesis' && entry.thesis),
    ['first', 'second', 'third'],
  );
});

test('a block number sent as a decimal string reads back as a number', () => {
  const entry = only('trade', [
    event(1, 'fill', { filledSize: '1', blockNumber: '12345678', leverage: '3' }),
  ]);

  assert.equal(entry.blockNumber, 12_345_678);
  assert.equal(entry.leverage, 3);
});

test('a malformed event invents nothing and throws nothing', () => {
  const entry = only('trade', [event(1, 'fill', { filledSize: 42, blockNumber: 'later' })]);

  assert.equal(entry.size, '—', 'a non-string size is not stringified into a lie');
  assert.equal(entry.blockNumber, null);
  assert.equal(entry.market, '—');
  assert.equal(entry.price, null);
  assert.equal(entry.leverage, null);
  assert.equal(entry.txHash, null);
  assert.equal(entry.venue, null);
  assert.equal(venueLabel(entry.venue), '—');
});

test('the display formatters are pure and device-independent', () => {
  assert.equal(clockTime(Date.parse('2026-09-17T12:34:56.000Z')), '12:34:56');
  assert.equal(clockTime(Date.parse('2026-09-17T00:00:07.000Z')), '00:00:07');

  assert.equal(signedPnl('12.4'), '+12.4');
  assert.equal(signedPnl('-3.25'), '−3.25', 'a real minus sign, not a hyphen');
  assert.equal(signedPnl('0'), '+0');
  assert.equal(signedPnl('1234.5'), '+1,234.5');
  assert.equal(signedPnl(null), '—');
  assert.equal(signedPnl('nonsense'), 'nonsense');

  assert.equal(venueLabel('kuru'), 'Kuru');
  assert.equal(venueLabel('perpl'), 'Perpl');
  assert.equal(venueLabel(null), '—');

  assert.equal(
    shortHash('0x4f2a9c1e7b3d5086a2f4e9c1b7d3058a6c2e4f9b1d7a30586c2e4f9b1d7a3058'),
    '0x4f2a9c…3058',
  );
  assert.equal(shortHash('0xabcd'), '0xabcd', 'nothing to shorten');
});

test('the demo ledger shows every kind and is not dated in the future', () => {
  const ledger = demoLedger(AT);

  assert.deepEqual(
    ledger.map((entry) => entry.kind),
    ['deposit', 'thesis', 'trade', 'refusal', 'thesis', 'verdict'],
    'the sample opens on the funding, because an agent trades what it was given',
  );
  assert.ok(
    ledger.some((entry) => entry.kind === 'refusal' && entry.layer === 'enclave'),
    'a sample ledger without the enclave refusal hides the product’s best moment',
  );
  assert.deepEqual(
    ledger.map((entry) => entry.seq),
    [...ledger.map((entry) => entry.seq)].sort((a, b) => a - b),
    'oldest first, like the real thing',
  );
  for (const entry of ledger) assert.ok(entry.at <= AT, 'nothing in the sample is in the future');
  assert.equal(
    new Set(ledger.map((entry) => entry.seq)).size,
    ledger.length,
    'the screen keys rows by seq, so the sample cannot repeat one',
  );
  for (const entry of ledger) {
    if (entry.kind !== 'deposit') continue;
    assert.equal(
      consensusNeedsPolling(entry.consensus),
      false,
      'the sample deposit is settled on arrival: a made-up height is not worth a request',
    );
  }
});
