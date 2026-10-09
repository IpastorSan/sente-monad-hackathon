/**
 * Whether an agent is running right now, said before anyone meets the 409
 * (SEN-177).
 *
 * The state is SEN-178's: `GET /agents/:id/runs` lists the agent's runs with
 * their status, start and progress, and the agent page already polls it for
 * the terminal. This file reads that list for the header and the Run now
 * button, words the one-run-at-a-time refusal for a person, and decides when
 * a Run now has STARTED — `POST /agents/:id/run` answers only once the run has
 * ended, so the sheet waits for the run to appear instead.
 *
 * Plain node, no React Native, so `runState.test.ts` runs without a device.
 */
import { formatDuration } from './usage.ts';
import type { RunSummary } from './terminal.ts';

/** The agent's open run, if it has one. */
export function liveRun(runs: readonly RunSummary[] | null | undefined): RunSummary | null {
  return runs?.find((run) => run.status === 'running') ?? null;
}

/** How long ago, for a person: "12 s", "3 min". */
function ago(startedAt: number, now: number): string {
  const ms = Math.max(0, now - startedAt);
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : formatDuration(ms);
}

/** "Started 12 s ago · 2 turns · 3 tool calls", from the run's own counters. */
export function runningLine(run: RunSummary, now: number): string {
  const parts = [`Started ${ago(run.startedAt, now)} ago`];
  if (run.trigger === 'schedule') parts[0] += ' on its schedule';
  if (run.iterations > 0)
    parts.push(`${run.iterations} ${run.iterations === 1 ? 'turn' : 'turns'}`);
  if (run.toolCalls > 0) {
    parts.push(`${run.toolCalls} ${run.toolCalls === 1 ? 'tool call' : 'tool calls'}`);
  }
  return parts.join(' · ');
}

/** The 409 `run_in_progress`, worded for a person: never an id. */
export function alreadyRunning(
  name: string,
  run: RunSummary | null,
  now: number,
): { title: string; detail: string } {
  return {
    title: `${name} is already running`,
    detail: run
      ? `It started ${ago(run.startedAt, now)} ago. You can ask again when it’s done.`
      : 'One run at a time. You can ask again when it’s done.',
  };
}

export type StartWait = 'started' | 'settled' | 'timeout';

/**
 * Wait until a run asked for at `since` shows up in the runs list, or the
 * request itself settles first (a refusal, or a run so short it ended before
 * the next look). A run that started up to a couple of seconds before `since`
 * counts: the clocks are the server's and the phone's.
 */
export async function waitForRunStart(options: {
  since: number;
  settled: Promise<unknown>;
  runs: () => Promise<readonly RunSummary[] | null>;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}): Promise<StartWait> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? 700;
  const deadline = now() + (options.timeoutMs ?? 20_000);
  let done = false;
  const settled = options.settled.then(
    () => (done = true),
    () => (done = true),
  );
  while (now() < deadline) {
    if (done) return 'settled';
    const runs = await options.runs().catch(() => null);
    if (done) return 'settled';
    if (runs?.some((run) => run.status === 'running' && run.startedAt >= options.since - 2_000)) {
      return 'started';
    }
    await Promise.race([sleep(interval), settled]);
  }
  return done ? 'settled' : 'timeout';
}
