import type { RunTranscriptSummary } from '../../agents/runner/transcript/run-transcript';
import { creditsOverview, resetSummary } from './overview';
import { aggregateUsage, RECENT_RUNS, windowStartUtc } from './usage';

const NOW = new Date('2026-10-09T12:00:00Z');
const OCT = Date.parse('2026-10-01T00:00:00Z');

function run(
  agentId: string,
  n: number,
  startedAt: number,
  costUsd?: number,
  extra: Partial<RunTranscriptSummary> = {},
): RunTranscriptSummary {
  return {
    runId: `run-${agentId}-${n}`,
    agentId,
    trigger: 'schedule',
    model: 'moonshotai/kimi-k2.6',
    status: 'ended',
    startedAt,
    endedAt: startedAt + 1_000,
    stopReason: 'end_turn',
    iterations: 2,
    toolCalls: 1,
    inputTokens: 1_000,
    outputTokens: 100,
    ...(costUsd !== undefined ? { costUsd } : {}),
    lastSeq: 5,
    droppedEntries: 0,
    ...extra,
  };
}

describe('windowStartUtc', () => {
  it.each([
    ['monthly', '2026-10-09T12:00:00Z', '2026-10-01T00:00:00.000Z'],
    ['monthly', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00.000Z'],
    ['daily', '2026-10-09T23:59:00Z', '2026-10-09T00:00:00.000Z'],
    // 2026-10-05 is a Monday.
    ['weekly', '2026-10-09T12:00:00Z', '2026-10-05T00:00:00.000Z'],
    ['weekly', '2026-10-05T01:00:00Z', '2026-10-05T00:00:00.000Z'],
    ['weekly', '2026-10-11T23:00:00Z', '2026-10-05T00:00:00.000Z'],
  ] as const)('%s window around %s starts %s', (reset, now, expected) => {
    expect(windowStartUtc(reset, new Date(now))?.toISOString()).toBe(expected);
  });

  it('is null for a limit that never resets', () => {
    expect(windowStartUtc(null, NOW)).toBeNull();
  });
});

describe('aggregateUsage', () => {
  const agents = [
    { id: 'a1', name: 'Night desk' },
    { id: 'a2', name: 'Scalper' },
    { id: 'a3', name: 'Idle' },
  ];
  const runs: Record<string, RunTranscriptSummary[]> = {
    a1: [run('a1', 2, OCT + 2_000, 0.1), run('a1', 1, OCT - 1_000, 0.4)],
    a2: [run('a2', 2, OCT + 3_000, 0.2), run('a2', 1, OCT + 1_000)],
  };
  const usage = (usedUsd: number | null, reset: 'monthly' | null = 'monthly') =>
    aggregateUsage({ agents, runsOf: (id) => runs[id] ?? [], usedUsd, reset, now: NOW });

  it('counts only this window by agent, most expensive first, and skips agents with no runs', () => {
    expect(usage(1).byAgent).toEqual([
      {
        agentId: 'a2',
        name: 'Scalper',
        runs: 2,
        costUsd: 0.2,
        inputTokens: 2_000,
        outputTokens: 200,
        lastRunAt: OCT + 3_000,
      },
      {
        agentId: 'a1',
        name: 'Night desk',
        runs: 1,
        costUsd: 0.1,
        inputTokens: 1_000,
        outputTokens: 100,
        lastRunAt: OCT + 2_000,
      },
    ]);
  });

  it('attributes what the runs cost and leaves the rest of the meter unattributed', () => {
    const result = usage(1);
    expect(result.estimated).toBe(true);
    expect(result.windowStart).toBe('2026-10-01T00:00:00.000Z');
    expect(result.attributedUsd).toBe(0.3);
    expect(result.unattributedUsd).toBe(0.7);
  });

  it('never reports a negative remainder, and none at all without a meter', () => {
    expect(usage(0.1).unattributedUsd).toBe(0);
    expect(usage(null).unattributedUsd).toBeNull();
  });

  it('lists recent runs across agents, newest first, last month included, cost null when unreported', () => {
    expect(usage(1).recentRuns.map((r) => [r.runId, r.agentName, r.costUsd])).toEqual([
      ['run-a2-2', 'Scalper', 0.2],
      ['run-a1-2', 'Night desk', 0.1],
      ['run-a2-1', 'Scalper', null],
      ['run-a1-1', 'Night desk', 0.4],
    ]);
  });

  it('counts every held run when the limit never resets', () => {
    expect(usage(1, null).attributedUsd).toBe(0.7);
  });

  it('caps the recent list', () => {
    const many = Array.from({ length: 30 }, (_, i) => run('a1', i, OCT + i, 0.01));
    const result = aggregateUsage({
      agents,
      runsOf: (id) => (id === 'a1' ? many : []),
      usedUsd: 1,
      reset: 'monthly',
      now: NOW,
    });
    expect(result.recentRuns).toHaveLength(RECENT_RUNS);
    expect(result.recentRuns[0]!.runId).toBe('run-a1-29');
    expect(result.attributedUsd).toBe(0.3);
  });
});

describe('creditsOverview', () => {
  it('says how the limit resets, honestly', () => {
    expect(resetSummary('monthly')).toBe(
      'Resets to the full limit at 00:00 UTC on the 1st of each month. Unused credit does not carry over.',
    );
    expect(resetSummary(null)).toBe('A one-off allowance: it does not reset.');
  });

  it('keeps the original four fields and adds the tier, reset and usage', () => {
    const usage = aggregateUsage({
      agents: [],
      runsOf: () => [],
      usedUsd: 2,
      reset: 'monthly',
      now: NOW,
    });
    const view = {
      limitUsd: 10,
      remainingUsd: 8,
      usageMonthUsd: 2,
      resetsAt: '2026-11-01T00:00:00.000Z',
    };
    expect(
      creditsOverview(
        { provisioned: true, mode: 'per-user', limitReset: 'monthly', view },
        usage,
        10,
      ),
    ).toEqual({
      ...view,
      tier: 'free',
      provisioned: true,
      mode: 'per-user',
      freeTierUsd: 10,
      usedUsd: 2,
      reset: {
        period: 'monthly',
        resetsAt: '2026-11-01T00:00:00.000Z',
        rollover: false,
        summary: resetSummary('monthly'),
      },
      usage,
    });
  });
});
