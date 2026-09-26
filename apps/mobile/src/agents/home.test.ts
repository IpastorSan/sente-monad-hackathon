/** What Home shows about the agents (SEN-57). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ActivityEvent, Agent, AgentSummary } from './api.ts';
import {
  agentPill,
  homeAgents,
  latestMove,
  pnlToday,
  sinceLabel,
  stableBalance,
  TRADING_WINDOW_MS,
} from './home.ts';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');

function agent(id: string, status: Agent['status'] = 'active'): Agent {
  return { id, name: id, status } as Agent;
}

function summary(agentId: string, extra: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agentId,
    trades: 0,
    held: 0,
    theses: 0,
    pnl: { last24h: '0', allTime: '0' },
    largestOrderNotional: null,
    mandateSince: 0,
    lastEvent: null,
    ...extra,
  };
}

function lastAt(at: number): Pick<AgentSummary, 'lastEvent'> {
  return { lastEvent: { seq: 1, agentId: 'a', at, kind: 'fill', detail: {} } };
}

function activity(
  kind: string,
  detail: Record<string, unknown>,
  extra: Partial<ActivityEvent> = {},
): ActivityEvent {
  return { seq: 7, agentId: 'a1', agentName: 'Range Hunter', at: NOW, kind, detail, ...extra };
}

test('homeAgents puts active before revoked, busiest first, and keeps three', () => {
  const summaries = new Map([
    ['old', summary('old', lastAt(NOW - 60_000))],
    ['busy', summary('busy', lastAt(NOW))],
  ]);
  const agents = [agent('gone', 'revoked'), agent('quiet'), agent('old'), agent('busy')];
  assert.deepEqual(
    homeAgents(agents, summaries).map((a) => a.id),
    ['busy', 'old', 'quiet'],
  );
});

test('agentPill only breathes on a recent event', () => {
  assert.deepEqual(agentPill(agent('a'), lastAt(NOW - 60_000), NOW), {
    label: 'Trading',
    tone: 'live',
  });
  assert.equal(agentPill(agent('a'), lastAt(NOW - TRADING_WINDOW_MS - 1), NOW).label, 'Watching');
  assert.equal(agentPill(agent('a'), undefined, NOW).label, 'Watching');
  assert.equal(agentPill(agent('a', 'revoked'), lastAt(NOW), NOW).tone, 'revoked');
});

test('pnlToday signs the figure and colours it by direction', () => {
  assert.deepEqual(pnlToday(summary('a', { pnl: { last24h: '18.22', allTime: '0' } })), {
    label: '+18.22 today',
    tone: 'up',
  });
  assert.deepEqual(pnlToday(summary('a', { pnl: { last24h: '-4.1', allTime: '0' } })), {
    label: '−4.1 today',
    tone: 'down',
  });
  assert.deepEqual(pnlToday(summary('a')), { label: 'Flat today', tone: null });
  assert.equal(pnlToday(undefined), null);
});

test('stableBalance sums the stablecoins at a common precision and truncates', () => {
  const tokens = [
    { symbol: 'USDC', decimals: 6 },
    { symbol: 'AUSD', decimals: 6 },
  ];
  assert.equal(stableBalance({ USDC: 500_000_000n, AUSD: 112_409_999n }, tokens), '612.40');
  assert.equal(stableBalance({}, tokens), '0.00');
  assert.equal(stableBalance(null, tokens), null);
  assert.equal(
    stableBalance({ A: 1_000_000n, B: 5n * 10n ** 17n }, [
      { symbol: 'A', decimals: 6 },
      { symbol: 'B', decimals: 18 },
    ]),
    '1.50',
  );
});

test('a fill reads as a sentence with its block for the ramp', () => {
  const consensus = { state: 'Voted', at: { proposed: NOW } };
  const move = latestMove(
    activity(
      'fill',
      {
        venue: 'kuru',
        symbol: 'MON-USDC',
        side: 'buy',
        filledSize: '180',
        averageFillPrice: '0.9744',
        blockNumber: 42,
      },
      { consensus },
    ),
  );
  assert.deepEqual(move, {
    agentId: 'a1',
    at: NOW,
    stone: 'trade',
    title: 'Range Hunter bought 180 MON-USDC',
    detail: 'at 0.9744 on Kuru',
    block: { number: 42, consensus },
  });
});

test('a refusal is the enclave holding, with no ramp', () => {
  const move = latestMove(
    activity(
      'refusal',
      { code: 'policy_violation', message: 'Over the cap.' },
      { layer: 'enclave' },
    ),
  );
  assert.equal(move?.stone, 'refusal');
  assert.equal(move?.title, 'The enclave held Range Hunter to its mandate');
  assert.equal(move?.detail, 'Over the cap.');
  assert.equal(move?.block, null);
});

test('a verdict takes the stone of its outcome', () => {
  assert.equal(latestMove(activity('close', { realizedPnl: '-3', symbol: 'BTC' }))?.stone, 'loss');
  assert.equal(latestMove(activity('verdict', { pnl: '12.4', held: true }))?.stone, 'win');
});

test('an event the Ledger does not show is not a move', () => {
  assert.equal(latestMove(activity('run', {})), null);
  assert.equal(latestMove(activity('order', { status: 'filled' })), null);
});

test('sinceLabel is coarse', () => {
  assert.equal(sinceLabel(NOW - 5_000, NOW), 'now');
  assert.equal(sinceLabel(NOW - 4 * 60_000, NOW), '4m ago');
  assert.equal(sinceLabel(NOW - 3 * 3_600_000, NOW), '3h ago');
  assert.equal(sinceLabel(NOW - 49 * 3_600_000, NOW), '2d ago');
  assert.equal(sinceLabel(NOW + 5_000, NOW), 'now');
});
