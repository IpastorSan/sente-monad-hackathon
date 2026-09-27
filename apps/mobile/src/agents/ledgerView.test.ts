/**
 * The Goban reading of a ledger entry (SEN-60), under plain `node --test`.
 *
 * What these pin is what the spine SAYS: which stone each entry is placed as,
 * the headline and the line under it, and the three figures over the spine —
 * the P&L above all, which must never count a Perpl trade twice.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  demoLedger,
  type DepositEntry,
  type LedgerEntry,
  type RefusalEntry,
  type ThesisEntry,
  type TradeEntry,
  type VerdictEntry,
} from './ledger.ts';
import {
  countLabel,
  depositHeadline,
  depositSource,
  entryTime,
  heldBy,
  inFilter,
  ledgerStats,
  outcome,
  stoneFor,
  sumDecimals,
  thesisKind,
  tradeDetail,
  tradeHeadline,
  verdictHeadline,
} from './ledgerView.ts';

const AT = Date.parse('2026-09-17T14:02:11.000Z');

function trade(extra: Partial<TradeEntry> = {}): TradeEntry {
  return {
    kind: 'trade',
    seq: 1,
    at: AT,
    venue: 'kuru',
    market: 'MON-USDC',
    direction: 'long',
    size: '180.00',
    price: '0.9744',
    leverage: null,
    txHash: null,
    blockNumber: null,
    consensus: null,
    filled: true,
    status: 'filled',
    ...extra,
  };
}

function verdict(extra: Partial<VerdictEntry> = {}): VerdictEntry {
  return {
    kind: 'verdict',
    origin: 'verdict',
    seq: 2,
    at: AT,
    direction: 'long',
    pnl: '18.22',
    held: true,
    market: 'MON-USDC',
    blockNumber: null,
    consensus: null,
    txHash: null,
    notes: [],
    ...extra,
  };
}

function refusal(layer: RefusalEntry['layer']): RefusalEntry {
  return {
    kind: 'refusal',
    seq: 3,
    at: AT,
    layer,
    code: 'policy_violation',
    message: '',
    tool: null,
  };
}

function deposit(extra: Partial<DepositEntry> = {}): DepositEntry {
  return {
    kind: 'deposit',
    seq: 4,
    at: AT,
    asset: 'USDC',
    amount: '500',
    rawAmount: '500000000',
    decimals: 6,
    from: '0x8f1d7a30586c2e4f9b1d7a30586c2e4f9b1d7a30',
    txHash: null,
    blockNumber: null,
    consensus: null,
    ...extra,
  };
}

test('each kind is placed as its own stone, and a verdict by what it was worth', () => {
  const thesis: ThesisEntry = {
    kind: 'thesis',
    seq: 5,
    at: AT,
    market: 'MON-USDC',
    direction: 'long',
    thesis: 'x',
    invalidation: '',
  };
  assert.equal(stoneFor(thesis), 'thesis');
  assert.equal(stoneFor(trade()), 'trade');
  assert.equal(stoneFor(trade({ filled: false })), 'trade');
  assert.equal(stoneFor(refusal('enclave')), 'refusal');
  assert.equal(stoneFor(deposit()), 'deposit');
  assert.equal(stoneFor(verdict({ pnl: '18.22' })), 'win');
  assert.equal(stoneFor(verdict({ pnl: '-3.25', held: null })), 'loss');
});

test('with no number, the verdict’s own judgement decides; a flat one did not hold', () => {
  assert.equal(outcome(verdict({ pnl: null, held: true })), 'up');
  assert.equal(outcome(verdict({ pnl: null, held: false })), 'down');
  assert.equal(outcome(verdict({ pnl: '0', held: false })), 'down');
  assert.equal(outcome(verdict({ pnl: null, held: null })), null);
  assert.equal(stoneFor(verdict({ pnl: null, held: null })), 'win', 'unknown is not a loss');
});

test('a trade reads as a fill report: the base asset, the price and the venue', () => {
  assert.equal(tradeHeadline(trade()), 'Bought 180.00 MON');
  assert.equal(tradeHeadline(trade({ direction: 'short' })), 'Sold 180.00 MON');
  assert.equal(tradeHeadline(trade({ direction: null, market: '—' })), 'Traded 180.00');
  assert.equal(tradeDetail(trade()), 'at 0.9744 · Kuru spot');
  assert.equal(
    tradeDetail(trade({ venue: 'perpl', market: 'BTC-PERP', leverage: 3 })),
    'at 0.9744 · Perpl perps · 3×',
  );
  assert.equal(tradeDetail(trade({ price: null, venue: null })), '');
});

test('an order that did not fill says so plainly, with the venue’s own status', () => {
  const failed = trade({ filled: false, size: '480.00', status: 'failed' });
  assert.equal(tradeHeadline(failed), 'Didn’t fill: buy 480.00 MON');
  assert.equal(tradeDetail(failed), 'at 0.9744 · Kuru spot · failed');
});

test('a thesis is labelled with its direction and market; a refusal with who held it', () => {
  const thesis: ThesisEntry = {
    kind: 'thesis',
    seq: 5,
    at: AT,
    market: 'MON-USDC',
    direction: 'long',
    thesis: 'x',
    invalidation: '',
  };
  assert.equal(thesisKind(thesis), 'Thesis · long MON-USDC');
  assert.equal(thesisKind({ ...thesis, direction: null }), 'Thesis · MON-USDC');
  assert.equal(heldBy('enclave'), 'Held by the enclave');
  assert.equal(heldBy('sente'), 'Held by Sente');
});

test('a close leads with its position and tints only the figure', () => {
  assert.deepEqual(verdictHeadline(verdict()), {
    lead: 'Closed long',
    pnl: '+18.22',
    tone: 'up',
  });
  assert.deepEqual(verdictHeadline(verdict({ direction: null, pnl: '-3.1', held: null })), {
    lead: 'Closed MON-USDC',
    pnl: '−3.10',
    tone: 'down',
  });
  assert.equal(verdictHeadline(verdict({ pnl: null })).pnl, null);
});

test('a deposit names the amount at a balance’s precision, and its sender short', () => {
  assert.equal(depositHeadline(deposit()), 'Funded 500.00 USDC');
  assert.equal(depositHeadline(deposit({ asset: null })), 'Funded 500.00');
  assert.equal(depositSource(deposit()), 'from 0x8f1d…7a30');
  assert.equal(depositSource(deposit({ from: null })), null);
});

test('the time is the clock on the day, and the date once it is older', () => {
  assert.equal(entryTime(AT, AT + 60_000), '14:02:11');
  assert.equal(entryTime(Date.parse('2026-09-21T09:00:00Z'), AT + 5 * 86_400_000), 'Sep 21');
  assert.equal(entryTime(Date.parse('2026-01-03T09:00:00Z'), AT), 'Jan 3');
});

test('the P&L counts verdicts only, so a Perpl close is never counted twice', () => {
  const entries: LedgerEntry[] = [
    trade(),
    trade({ seq: 6, filled: false }),
    refusal('enclave'),
    refusal('sente'),
    // The venue's gross figure, followed by the verdict it settles.
    verdict({ origin: 'close', pnl: '20.00' }),
    verdict({ pnl: '18.22' }),
    verdict({ pnl: '0.1' }),
    verdict({ pnl: '0.2' }),
  ];
  assert.deepEqual(ledgerStats(entries), { trades: 1, held: 2, pnl: '+18.52', tone: 'up' });
});

test('a ledger with nothing settled has no P&L rather than a zero', () => {
  assert.deepEqual(ledgerStats([trade()]), { trades: 1, held: 0, pnl: null, tone: null });
  assert.deepEqual(ledgerStats([verdict({ pnl: '-1.5' }), verdict({ pnl: '1.5' })]), {
    trades: 0,
    held: 0,
    pnl: '0.00',
    tone: null,
  });
  assert.equal(countLabel(1204), '1,204');
});

test('a P&L that prints as 0.00 is neither a win nor a loss (SEN-136)', () => {
  // Pre-fix: `−0.00` in berry for both.
  assert.deepEqual(ledgerStats([verdict({ pnl: '-0.001' })]), {
    trades: 0,
    held: 0,
    pnl: '0.00',
    tone: null,
  });
  assert.deepEqual(verdictHeadline(verdict({ pnl: '-0.001', held: null })), {
    lead: 'Closed long',
    pnl: '0.00',
    tone: null,
  });
  // Pre-fix: the float's `−2.67`.
  assert.equal(verdictHeadline(verdict({ pnl: '-2.675' })).pnl, '−2.68');
});

test('decimals sum exactly, signs and scales mixed, and garbage is left out', () => {
  assert.equal(sumDecimals(['0.1', '0.2']), '0.3');
  assert.equal(sumDecimals(['-3.25', '1']), '-2.25');
  assert.equal(sumDecimals(['+1.005', '2']), '3.005');
  assert.equal(sumDecimals(['-0.5', '0.25']), '-0.25');
  assert.equal(sumDecimals(['12', 'n/a']), '12');
  assert.equal(sumDecimals(['1e3']), null);
  assert.equal(sumDecimals([]), null);
});

test('the filters split the spine by kind, and a deposit only shows under All', () => {
  const sample = demoLedger(AT);
  const kinds = (filter: Parameters<typeof inFilter>[1]) =>
    sample.filter((entry) => inFilter(entry, filter)).map((entry) => entry.kind);
  assert.equal(kinds('all').length, sample.length);
  assert.deepEqual(kinds('trades'), ['trade', 'verdict']);
  assert.deepEqual(kinds('theses'), ['thesis', 'thesis']);
  assert.deepEqual(kinds('held'), ['refusal']);
});
