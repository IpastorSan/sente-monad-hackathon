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
  demoLedger,
  directionLabel,
  heldLabel,
  refusalLayerLabel,
  signedPnl,
  shortHash,
  toLedgerEntries,
  venueLabel,
  type LedgerEntry,
  type LedgerEntryKind,
  type LedgerEvent,
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

test('a run summary is not a ledger entry, and neither is an unknown kind', () => {
  none([
    event(1, 'run', { stopReason: 'end_turn', iterations: 3, costUsd: 0.04 }),
    event(2, 'something_new', { anything: true }),
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

test('the demo ledger shows all four kinds, opens on a thesis, and is not dated in the future', () => {
  const ledger = demoLedger(AT);

  assert.deepEqual(
    ledger.map((entry) => entry.kind),
    ['thesis', 'trade', 'refusal', 'thesis', 'verdict'],
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
});
