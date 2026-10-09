/**
 * Where the credits went (SEN-183), from the agents' run transcripts.
 *
 * OpenRouter's meter on the user's key (`usedUsd`) is the exact figure; this is
 * an ESTIMATE beside it, and it says so on the wire. Two reasons it can fall
 * short of the meter, never exceed it by design:
 * - a transcript keeps only the last `MAX_RUNS_PER_AGENT` runs of each agent
 *   (SEN-178), so a busy agent's earlier runs this month are gone;
 * - a run's cost is the sum of OpenRouter's per-response `usage.cost`, and a
 *   response that did not report one counts as nothing.
 * What the meter has and the runs do not is `unattributedUsd`.
 *
 * Pure, so the aggregation is tested without Nest or a store.
 */
import type { RunTranscriptSummary } from '../../agents/runner/transcript/run-transcript';
import type { LimitReset } from '../openrouter.client';

/** How many runs `recentRuns` lists, newest first, across every agent. */
export const RECENT_RUNS = 20;

export const USAGE_NOTE =
  'Estimated from the last 10 runs Sente keeps per agent. The used figure above is OpenRouter’s own meter.';

export interface UsageAgent {
  readonly id: string;
  readonly name: string;
}

export interface AgentUsage {
  readonly agentId: string;
  readonly name: string;
  /** Runs in this window that Sente still holds. */
  readonly runs: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Unix epoch milliseconds. */
  readonly lastRunAt: number;
}

export interface RecentRun {
  readonly runId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly trigger: RunTranscriptSummary['trigger'];
  readonly model: string;
  readonly status: RunTranscriptSummary['status'];
  readonly stopReason: RunTranscriptSummary['stopReason'] | null;
  /** Unix epoch milliseconds. */
  readonly startedAt: number;
  /** Null when no response in the run reported a cost. */
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CreditsUsage {
  /** Always true: this is reconstructed from transcripts, not metered. */
  readonly estimated: true;
  /** ISO 8601 start of the current reset window; null when the limit never resets. */
  readonly windowStart: string | null;
  /** Agents with a run in this window, most expensive first. */
  readonly byAgent: readonly AgentUsage[];
  readonly attributedUsd: number;
  /** The meter less what the runs account for, never below 0. Null without a meter reading. */
  readonly unattributedUsd: number | null;
  /** The newest runs across agents, whatever their window. */
  readonly recentRuns: readonly RecentRun[];
  readonly note: string;
}

/** Start of the reset window that `now` is in: 00:00 UTC today, last Monday, or the 1st. */
export function windowStartUtc(reset: LimitReset, now: Date): Date | null {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (reset) {
    case 'daily':
      return new Date(Date.UTC(y, m, d));
    case 'weekly':
      // getUTCDay: Sunday = 0, so Monday is 1 day back from Tuesday, 6 from Sunday.
      return new Date(Date.UTC(y, m, d - ((now.getUTCDay() + 6) % 7)));
    case 'monthly':
      return new Date(Date.UTC(y, m, 1));
    default:
      return null;
  }
}

export function aggregateUsage(input: {
  agents: readonly UsageAgent[];
  runsOf: (agentId: string) => readonly RunTranscriptSummary[];
  /** OpenRouter's meter for this window, or null when there is no key yet. */
  usedUsd: number | null;
  reset: LimitReset;
  now: Date;
  recent?: number;
}): CreditsUsage {
  const start = windowStartUtc(input.reset, input.now);
  const since = start?.getTime() ?? -Infinity;
  const byAgent: AgentUsage[] = [];
  const all: RecentRun[] = [];

  for (const agent of input.agents) {
    const runs = input.runsOf(agent.id);
    let count = 0;
    let cost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let lastRunAt = 0;
    for (const run of runs) {
      all.push({
        runId: run.runId,
        agentId: agent.id,
        agentName: agent.name,
        trigger: run.trigger,
        model: run.model,
        status: run.status,
        stopReason: run.stopReason ?? null,
        startedAt: run.startedAt,
        costUsd: run.costUsd ?? null,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
      });
      if (run.startedAt < since) continue;
      count += 1;
      cost += run.costUsd ?? 0;
      inputTokens += run.inputTokens;
      outputTokens += run.outputTokens;
      lastRunAt = Math.max(lastRunAt, run.startedAt);
    }
    if (count > 0) {
      byAgent.push({
        agentId: agent.id,
        name: agent.name,
        runs: count,
        costUsd: usd(cost),
        inputTokens,
        outputTokens,
        lastRunAt,
      });
    }
  }

  byAgent.sort((a, b) => b.costUsd - a.costUsd || b.lastRunAt - a.lastRunAt);
  all.sort((a, b) => b.startedAt - a.startedAt);
  const attributedUsd = usd(byAgent.reduce((sum, agent) => sum + agent.costUsd, 0));

  return {
    estimated: true,
    windowStart: start?.toISOString() ?? null,
    byAgent,
    attributedUsd,
    unattributedUsd:
      input.usedUsd === null ? null : usd(Math.max(0, input.usedUsd - attributedUsd)),
    recentRuns: all.slice(0, input.recent ?? RECENT_RUNS),
    note: USAGE_NOTE,
  };
}

/** Micro-dollar precision: enough for a per-run cost, without float dust in a sum. */
function usd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
