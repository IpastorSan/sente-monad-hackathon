/**
 * SEN-202: a perp open or close is judged by Perpl's own position, not by
 * whether the order's confirmation reached the phone.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Order, Position } from '@sente/venues';
import { PerplNoPositionError, PerplOrderRejectedError } from '@sente/venues/perpl';

import {
  closeOverlay,
  closeVerdict,
  describeClose,
  openAfterError,
  openOverlay,
  openVerdict,
  outcomeUnknown,
  reconcile,
  type CloseVerdict,
} from './perpReconcile.ts';
import { PerplTraderError } from './perplTrader.ts';

function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: 'BTC-PERP',
    side: 'long',
    size: '0.01',
    entryPrice: '100000',
    markPrice: '100100',
    leverage: 5,
    marginMode: 'isolated',
    margin: '200',
    unrealizedPnl: '1',
    updatedAt: 1,
    ...overrides,
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: '900',
    symbol: 'BTC-PERP',
    side: 'sell',
    type: 'market',
    status: 'filled',
    size: '0.01',
    filledSize: '0.01',
    averageFillPrice: '99950',
    reduceOnly: true,
    createdAt: 1,
    updatedAt: 2,
    txHash: '0xabc',
    ...overrides,
  };
}

const lost = new Error('Perpl rq 41 did not settle within 30000ms; its outcome is unknown');

test('a close that filled is closed, even while Perpl’s position read still lags it', () => {
  assert.deepEqual(closeVerdict({ size: '0.01', order: order(), after: null }), {
    kind: 'closed',
    order: order(),
  });
  assert.equal(closeVerdict({ size: '0.01', order: order(), after: position() }).kind, 'closed');
  assert.equal(closeVerdict({ size: '0.01', order: order(), after: undefined }).kind, 'closed');
});

test('a close whose confirmation was lost is closed once Perpl lists no position', () => {
  assert.deepEqual(closeVerdict({ size: '0.01', error: lost, after: null }), {
    kind: 'closed',
    order: null,
  });
});

test('a lost confirmation with the position untouched, or unread, is pending — never failed', () => {
  assert.equal(closeVerdict({ size: '0.01', error: lost, after: position() }).kind, 'pending');
  assert.equal(closeVerdict({ size: '0.01', error: lost, after: undefined }).kind, 'pending');
  // "Check again" with nothing sent this time.
  assert.equal(closeVerdict({ size: '0.01', after: position() }).kind, 'pending');
});

test('a retry on a position that no longer exists is already closed, not an error', () => {
  const verdict = closeVerdict({
    size: '0.01',
    error: new PerplNoPositionError('BTC-PERP'),
    after: undefined,
  });
  assert.deepEqual(verdict, { kind: 'already-closed' });
  const notice = describeClose(verdict, 'BTC-PERP', 'BTC');
  assert.equal(notice.tone, 'ok');
  assert.equal(notice.title, 'Already closed');
  assert.equal(notice.done, true);
});

test('only a refusal Perpl’s position confirms is a failure', () => {
  const rejected = new PerplOrderRejectedError('Perpl order rq 41 failed: PriceOutOfRange', 41);
  assert.equal(closeVerdict({ size: '0.01', error: rejected, after: position() }).kind, 'failed');
  // Refused, yet the position is gone: Perpl wins.
  assert.equal(closeVerdict({ size: '0.01', error: rejected, after: null }).kind, 'closed');
  // Refused before sending: nothing to re-read.
  const unsent = closeVerdict({
    size: '0.01',
    error: new PerplTraderError('refusing an unbounded market order'),
    after: undefined,
  });
  assert.equal(unsent.kind, 'failed');
});

test('partial and unfilled closes keep the position open', () => {
  const half = order({ filledSize: '0.004' });
  const remaining = position({ size: '0.006' });
  assert.deepEqual(closeVerdict({ size: '0.01', order: half, after: remaining }), {
    kind: 'partial',
    order: half,
    remaining,
  });
  assert.equal(
    closeVerdict({ size: '0.01', order: order({ filledSize: '0' }), after: position() }).kind,
    'unfilled',
  );
  // Lost confirmation, smaller position: part of it closed.
  assert.equal(closeVerdict({ size: '0.01', error: lost, after: remaining }).kind, 'partial');
});

test('the close notice carries the fill and tx when known, and never says failed for pending', () => {
  const closed = describeClose({ kind: 'closed', order: order() }, 'BTC-PERP', 'BTC');
  assert.match(closed.detail, /^0\.01 BTC at 99950\./);
  assert.equal(closed.txHash, '0xabc');
  const blind = describeClose({ kind: 'closed', order: null }, 'BTC-PERP', 'BTC');
  assert.equal(blind.title, 'Position closed');
  assert.equal(blind.txHash, undefined);
  const pending = describeClose({ kind: 'pending', message: 'x' }, 'BTC-PERP', 'BTC');
  assert.equal(pending.tone, 'info');
  assert.doesNotMatch(pending.title, /didn’t go through/);
  assert.equal(pending.done, false);
});

test('close verdicts map to the portfolio overlay', () => {
  const before = position();
  const at = 1_000;
  const gone = { kind: 'gone', symbol: 'BTC-PERP', at, before };
  assert.deepEqual(closeOverlay({ kind: 'closed', order: null }, 'BTC-PERP', before, at), gone);
  assert.deepEqual(closeOverlay({ kind: 'already-closed' }, 'BTC-PERP', before, at), gone);
  const partial: CloseVerdict = {
    kind: 'partial',
    order: null,
    remaining: position({ size: '0.006' }),
  };
  assert.equal(closeOverlay(partial, 'BTC-PERP', before, at)?.kind, 'position');
  assert.equal(
    closeOverlay({ kind: 'pending', message: '' }, 'BTC-PERP', before, at)?.kind,
    'pending',
  );
  assert.equal(closeOverlay({ kind: 'unfilled' }, 'BTC-PERP', before, at), null);
  assert.equal(closeOverlay({ kind: 'failed', message: '' }, 'BTC-PERP', before, at), null);
});

test('an open is seen once Perpl lists a position different from the one before', () => {
  assert.deepEqual(openVerdict(null, position()), { kind: 'open', position: position() });
  assert.equal(openVerdict(null, null).kind, 'pending');
  assert.equal(openVerdict(null, undefined).kind, 'pending');
  // An add: the same position until Perpl shows it grown.
  assert.equal(openVerdict(position(), position({ markPrice: '1' })).kind, 'pending');
  assert.equal(openVerdict(position(), position({ size: '0.02' })).kind, 'open');
  const entry = openOverlay({ kind: 'open', position: position() }, 'BTC-PERP', null, 5);
  assert.equal(entry.kind, 'position');
  assert.deepEqual(openOverlay({ kind: 'pending' }, 'BTC-PERP', null, 5), {
    kind: 'pending',
    symbol: 'BTC-PERP',
    at: 5,
    before: null,
  });
});

test('reconcile re-reads with backoff until Perpl answers, and survives failed reads', async () => {
  const reads: Array<Position | null | Error> = [new Error('socket'), position(), null];
  const waited: number[] = [];
  const verdict = await reconcile({
    read: async () => {
      const next = reads.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    },
    decide: (after) => closeVerdict({ size: '0.01', error: lost, after }),
    delaysMs: [0, 10, 20, 40],
    sleep: async (ms) => {
      waited.push(ms);
    },
  });
  assert.deepEqual(verdict, { kind: 'closed', order: null });
  assert.deepEqual(waited, [10, 20]);
});

test('reconcile gives back pending when Perpl never shows it, so the screen says checking', async () => {
  let readsDone = 0;
  const verdict = await reconcile({
    read: async () => {
      readsDone++;
      return position();
    },
    decide: (after) => closeVerdict({ size: '0.01', error: lost, after }),
    delaysMs: [0, 1, 1],
    sleep: async () => undefined,
  });
  assert.equal(verdict.kind, 'pending');
  assert.equal(readsDone, 3);
});

test('only an order that may have executed unseen is read back', () => {
  assert.ok(outcomeUnknown(lost));
  assert.ok(!outcomeUnknown(new PerplTraderError('leverage 0')));
  assert.ok(!outcomeUnknown(new PerplNoPositionError('BTC-PERP')));
  assert.ok(!outcomeUnknown(new PerplOrderRejectedError('Perpl gateway refused the order', 0)));
});

test('an open whose outcome is unknown is checked, never called failed (SEN-203)', () => {
  const lost = new Error('Perpl order rq 7 timed out');
  // Sent, outcome unknown: read Perpl's position back first.
  assert.deepEqual(openAfterError({ error: lost, sent: true }), { kind: 'read-back' });
  // Read back and still pending: "Check again", not "didn't go through".
  assert.deepEqual(openAfterError({ error: lost, sent: true, verdict: { kind: 'pending' } }), {
    kind: 'unconfirmed',
  });
  const opened = position();
  assert.deepEqual(
    openAfterError({ error: lost, sent: true, verdict: { kind: 'open', position: opened } }),
    { kind: 'landed', position: opened },
  );
});

test('an open that was refused, or never left the device, failed', () => {
  const lost = new Error('socket closed');
  assert.deepEqual(openAfterError({ error: lost, sent: false }), { kind: 'failed' });
  assert.deepEqual(
    openAfterError({ error: new PerplOrderRejectedError('PriceOutOfRange', 3), sent: true }),
    { kind: 'failed' },
  );
  assert.deepEqual(openAfterError({ error: new PerplTraderError('leverage 0'), sent: true }), {
    kind: 'failed',
  });
});
