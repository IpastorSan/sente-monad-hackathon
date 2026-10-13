import type { WatcherSet } from '../watcher-store';

const T0 = Date.parse('2026-10-09T10:00:00.000Z');

/**
 * A stored watcher set with every kind of state a check leaves behind: an
 * edge clause that has answered, one that has not (`null`), a firing, an
 * error, and the counters. For the store specs and the import's.
 */
export function testWatcherSet(agentId: string, patch: Partial<WatcherSet> = {}): WatcherSet {
  return {
    agentId,
    heartbeatSeconds: 7_200,
    watchers: [
      {
        id: 'breakout',
        label: 'BTC breaks 100k',
        match: 'any',
        clauses: [
          {
            type: 'price',
            venue: 'perpl',
            market: 'BTC-PERP',
            source: 'mark',
            op: 'crosses_above',
            value: 100_000,
          },
          {
            type: 'price',
            venue: 'kuru',
            market: 'MON-USDC',
            source: 'last',
            op: 'crosses_below',
            value: 3,
          },
        ],
        cooldownMinutes: 30,
        setBy: 'agent',
        createdAt: T0,
        edges: [false, null],
        lastEvaluatedAt: T0 + 60_000,
        lastFiredAt: T0 + 30_000,
        fireCount: 2,
        lastObserved: 'BTC-PERP mark 101000 crossed above 100000',
        lastError: 'MON-USDC: no price',
      },
    ],
    updatedAt: T0 + 60_000,
    checks: 5,
    skipped: 3,
    wakes: 2,
    heartbeats: 1,
    lastCheckAt: T0 + 60_000,
    lastWakeAt: null,
    ...patch,
  };
}
