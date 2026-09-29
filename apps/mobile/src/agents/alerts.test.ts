/** The Alerts feed (SEN-156): sentences, unread state and grouping. Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  alertFilters,
  badgeLabel,
  groupAlerts,
  inAlertFilter,
  isUnread,
  markSeen,
  parseSeen,
  serializeSeen,
  toAlerts,
  unreadCount,
  type Alert,
} from './alerts.ts';
import type { ActivityEvent } from './api.ts';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');

function event(
  seq: number,
  kind: string,
  detail: Record<string, unknown>,
  extra: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    seq,
    agentId: 'rh',
    agentName: 'Range Hunter',
    at: NOW - (100 - seq) * 60_000,
    kind,
    detail,
    ...extra,
  };
}

const FILL = event(3, 'fill', {
  venue: 'kuru',
  symbol: 'MON-USDC',
  side: 'buy',
  filledSize: '180',
  averageFillPrice: '0.9731',
});

function only(events: ActivityEvent[]): Alert {
  const alerts = toAlerts(events);
  assert.equal(alerts.length, 1);
  return alerts[0]!;
}

test('a fill reads like its ledger row and opens the position', () => {
  const alert = only([FILL]);
  assert.equal(`${alert.agentName}${alert.lead}`, 'Range Hunter bought 180 MON');
  assert.equal(alert.detail, 'at 0.9731 · Kuru spot');
  assert.equal(alert.stone, 'trade');
  assert.deepEqual(alert.target, { kind: 'position', symbol: 'MON-USDC', venue: 'kuru' });
  assert.equal(alert.key, 'rh:3');
});

test('an order that did not land keeps the agent as the subject', () => {
  const alert = only([
    event(4, 'order', {
      status: 'failed',
      args: { market: 'MON-USDC', side: 'sell', size: '60' },
    }),
  ]);
  assert.equal(
    `${alert.agentName}${alert.lead}`,
    'Range Hunter’s order to sell 60 MON didn’t fill',
  );
  assert.equal(alert.detail, 'failed');
  assert.deepEqual(alert.target, { kind: 'ledger' });
});

test('a refusal is Held, with the layer that held it, never an error', () => {
  const alert = only([
    event(
      5,
      'refusal',
      { code: 'policy_violation', message: '480.00 exceeds the 250 limit' },
      { layer: 'enclave' },
    ),
  ]);
  assert.equal(`${alert.agentName}${alert.lead}`, 'Range Hunter was held to its mandate');
  assert.equal(alert.held, 'Held by the enclave');
  assert.equal(alert.detail, '480.00 exceeds the 250 limit');
  assert.equal(alert.stone, 'refusal');
  assert.equal(alert.figure, null);
});

test('a verdict carries its P&L apart, signed through money.ts, in the quote unit', () => {
  const win = only([
    event(6, 'verdict', {
      direction: 'long',
      realisedPnl: '18.22',
      held: true,
      market: 'MON-USDC',
    }),
  ]);
  assert.equal(`${win.agentName}${win.lead}`, 'Range Hunter closed a long:');
  assert.deepEqual(win.figure, { text: '+18.22 USDC', tone: 'up' });
  assert.equal(win.detail, 'MON-USDC · Thesis held');
  assert.equal(win.stone, 'win');

  const loss = only([
    event(7, 'verdict', { direction: 'short', pnl: '-4.1', held: false, market: 'MON-PERP' }),
  ]);
  assert.deepEqual(loss.figure, { text: '−4.10 AUSD', tone: 'down' });
  assert.equal(loss.stone, 'loss');
});

test('a close its run’s verdict settles is one alert, not two', () => {
  const close = event(
    8,
    'close',
    { side: 'sell', realizedPnl: '18.5', symbol: 'MON-PERP' },
    { runId: 'r1' },
  );
  const verdict = event(9, 'verdict', { direction: 'long', realisedPnl: '18.22' }, { runId: 'r1' });
  assert.deepEqual(
    toAlerts([verdict, close]).map((a) => a.seq),
    [9],
  );
  // With no verdict for its run, the close is the only word on it.
  const alone = only([close]);
  assert.equal(`${alone.agentName}${alone.lead}`, 'Range Hunter closed a long:');
  assert.equal(alone.detail, 'MON-PERP');
});

test('a deposit names what arrived', () => {
  const alert = only([
    event(10, 'deposit', { asset: 'USDC', amount: '500', rawAmount: '500000000', decimals: 6 }),
  ]);
  assert.equal(`${alert.agentName}${alert.lead}`, 'Range Hunter received 500.00 USDC');
  assert.equal(alert.stone, 'deposit');
});

test('theses, run summaries and filled orders raise no alert', () => {
  assert.deepEqual(
    toAlerts([
      event(1, 'thesis', { market: 'MON-USDC', thesis: 'x' }),
      event(2, 'run', {}),
      event(3, 'order', { status: 'filled' }),
    ]),
    [],
  );
});

test('a mixed page is ordered by time, newest first', () => {
  const other = event(
    1,
    'fill',
    { symbol: 'BTC-PERP', side: 'sell', filledSize: '1' },
    {
      agentId: 'bm',
      agentName: 'Basis Monk',
      at: NOW,
    },
  );
  assert.deepEqual(
    toAlerts([FILL, other]).map((a) => a.key),
    ['bm:1', 'rh:3'],
  );
});

// ---------------------------------------------------------------------------

const A = { agentId: 'rh', seq: 5, at: 1_000 };

test('nothing is unread before the feed was ever seen', () => {
  assert.equal(parseSeen(null), null);
  assert.equal(parseSeen('not json'), null);
  assert.equal(isUnread(A, null), false);
});

test('an event past the mark on seq or on at is unread', () => {
  const seen = { rh: { seq: 5, at: 1_000 } };
  assert.equal(isUnread(A, seen), false);
  assert.equal(isUnread({ ...A, seq: 6, at: 900 }, seen), true, 'backdated at, new seq');
  assert.equal(
    isUnread({ ...A, seq: 1, at: 2_000 }, seen),
    true,
    'seq restarted by an API restart',
  );
  assert.equal(isUnread({ ...A, agentId: 'new' }, seen), true, 'an agent hired since');
});

test('marking seen covers the page, never moves back, and round-trips the store', () => {
  const alerts = [A, { agentId: 'rh', seq: 3, at: 2_000 }, { agentId: 'bm', seq: 9, at: 50 }];
  const seen = markSeen({ rh: { seq: 7, at: 10 } }, alerts);
  assert.deepEqual(seen, { rh: { seq: 7, at: 2_000 }, bm: { seq: 9, at: 50 } });
  assert.equal(unreadCount(alerts, seen), 0);
  assert.deepEqual(parseSeen(serializeSeen(seen)), seen);
  assert.equal(unreadCount([...alerts, { agentId: 'bm', seq: 10, at: 60 }], seen), 1);
});

test('the badge hides at zero and says the page may hold more', () => {
  assert.equal(badgeLabel(0, 10, 50), null);
  assert.equal(badgeLabel(3, 10, 50), '3');
  assert.equal(badgeLabel(50, 50, 50), '50+');
});

// ---------------------------------------------------------------------------

test('Today and Earlier split on the UTC day, and empty groups are left out', () => {
  const today = { at: Date.parse('2026-09-29T00:10:00Z') };
  const yesterday = { at: Date.parse('2026-09-28T23:50:00Z') };
  assert.deepEqual(groupAlerts([today, yesterday], NOW), [
    { label: 'Today', alerts: [today] },
    { label: 'Earlier', alerts: [yesterday] },
  ]);
  assert.deepEqual(groupAlerts([yesterday], NOW), [{ label: 'Earlier', alerts: [yesterday] }]);
});

test('the chips are All, each agent once, then Held', () => {
  const alerts = [
    { agentId: 'rh', agentName: 'Range Hunter', stone: 'trade' as const },
    { agentId: 'bm', agentName: 'Basis Monk', stone: 'refusal' as const },
    { agentId: 'rh', agentName: 'Range Hunter', stone: 'win' as const },
  ];
  const chips = alertFilters(alerts);
  assert.deepEqual(
    chips.map((c) => c.label),
    ['All', 'Range Hunter', 'Basis Monk', 'Held'],
  );
  const byRh = chips[1]!.filter;
  assert.equal(alerts.filter((a) => inAlertFilter(a, byRh)).length, 2);
  assert.equal(alerts.filter((a) => inAlertFilter(a, 'held')).length, 1);
});
