import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { AgentRefusedError } from '../agents.errors';
import { AGENT_EVENTS, type AgentEvent, type AgentEventLog } from '../events/agent-event-log';
import { AGENT_STORE, type AgentRecord, type AgentStore } from '../store/agent-store';
import { AgentRunnerService, type RunStopReason } from './agent-runner.service';
import { errorText } from './openrouter-client';
import {
  AGENT_RUNNER_CONFIG,
  AGENT_SCHEDULE_CONFIG,
  type AgentRunnerConfig,
  type AgentScheduleConfig,
} from './runner.config';
import { ScheduleGuard, type SchedulePause } from './schedule-guard';
import type { RunWake } from '../watchers/wake';
import { WatcherService } from '../watchers/watcher.service';

export type TickOutcome =
  | { readonly agentId: string; readonly ran: true; readonly stopReason: RunStopReason }
  | { readonly agentId: string; readonly ran: false; readonly reason: string };

/** Where an agent's cadence comes from: its own `schedule`, or `AGENT_TICK_SECONDS`. */
export type CadenceSource = 'agent' | 'global';

/** `GET /agents/:id/schedule` (SEN-71), in the wire shape of plan-backend.md. */
export interface AgentScheduleStatusDto {
  everySeconds: number | null;
  source: CadenceSource | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  paused: { reason: SchedulePause['reason']; until: string | null } | null;
  /**
   * SEN-182: set when the agent has watchers. Each tick then checks them
   * without the model, and `nextRunAt` is the next CHECK: a run starts only
   * when a watcher fires, or at `nextHeartbeatAt` if none does.
   */
  watchers: { count: number; heartbeatSeconds: number } | null;
}

/**
 * Runs agents on their own cadence (SEN-71; SEN-8 had one global tick).
 *
 * One poll timer (`AGENT_SCHEDULER_POLL_SECONDS`) looks for due agents. An
 * agent's cadence is its own `schedule.everySeconds` (SEN-67), else
 * `AGENT_TICK_SECONDS`, else it runs manually only. It is due once
 * `now ≥ lastStart + cadence`.
 *
 * - `lastStart` is seeded from the durable event log's last `run` event
 *   (SEN-65), so a restart neither re-runs every agent at once nor forgets
 *   one — nor, for a weekly agent, runs it early or skips a week (SEN-158).
 *   An agent with no history is phased from its hire (`unrunStart`).
 * - Due runs go through a concurrency limiter
 *   (`AGENT_SCHEDULE_MAX_CONCURRENT`), then through `ScheduleGuard` (credits
 *   and the daily cap). A held-back agent keeps its `lastStart`, so it is
 *   asked again next poll rather than a whole cadence later.
 * - An agent whose previous run is still open is skipped
 *   (`run_in_progress`), so a slow run never stacks up behind itself.
 *
 * - An agent with WATCHERS (SEN-182) is not run when due: its watchers are
 *   checked, with no model call, and a run starts only when one fires or
 *   its heartbeat comes due (no run of any trigger for `heartbeatSeconds`).
 *   That run carries a `wake` naming what fired. A wake the guard holds back
 *   stays pending and is retried on the next poll, so an edge that fired is
 *   not lost to a credits blip; it is dropped after a heartbeat's length.
 *
 * In-process only, like the rest of the agent state. Chainlink CRE replaces
 * this timer in Phase 5.
 */
@Injectable()
export class AgentRunScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentRunScheduler.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Epoch ms of each agent's last scheduled start (or seeded equivalent). */
  private readonly lastStart = new Map<string, number>();
  /** Agents this scheduler has queued or is running, so two polls never take one twice. */
  private readonly claimed = new Set<string>();
  /** Epoch ms of each watching agent's last run of any trigger, for its heartbeat. */
  private readonly lastRun = new Map<string, number>();
  /** Wakes decided but not yet started (the guard held them back). */
  private readonly pending = new Map<string, RunWake>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    @Inject(AGENT_RUNNER_CONFIG) private readonly runnerConfig: AgentRunnerConfig,
    @Inject(AGENT_SCHEDULE_CONFIG) private readonly config: AgentScheduleConfig,
    @Inject(AGENT_STORE) private readonly store: Pick<AgentStore, 'listActive'>,
    @Inject(AgentRunnerService)
    private readonly runner: Pick<AgentRunnerService, 'run' | 'isRunning'>,
    @Inject(AGENT_EVENTS) private readonly events: Pick<AgentEventLog, 'list'>,
    private readonly guard: ScheduleGuard,
    /** SEN-182. Optional and last, so the specs that build the scheduler by hand need not know it. */
    @Optional() @Inject(WatcherService) private readonly watchers?: WatcherService,
  ) {}

  get enabled(): boolean {
    return this.timer !== undefined;
  }

  onApplicationBootstrap(): void {
    const seconds = this.config.pollSeconds;
    if (seconds === undefined) return;
    this.timer = setInterval(() => void this.poll(), seconds * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The agent's cadence in seconds and where it comes from, or null for manual-only. */
  cadenceOf(
    agent: Pick<AgentRecord, 'schedule'>,
  ): { everySeconds: number; source: CadenceSource } | null {
    if (agent.schedule) return { everySeconds: agent.schedule.everySeconds, source: 'agent' };
    if (this.runnerConfig.tickSeconds !== undefined) {
      return { everySeconds: this.runnerConfig.tickSeconds, source: 'global' };
    }
    return null;
  }

  /**
   * One pass: starts every due agent and resolves once those runs end. Agents
   * that are not due, or have no cadence, are left out of the result. Never
   * throws.
   */
  async poll(now: number = Date.now()): Promise<TickOutcome[]> {
    let agents: AgentRecord[];
    try {
      agents = await this.store.listActive();
    } catch (error) {
      this.logger.error(`poll: could not list agents: ${errorText(error)}`);
      return [];
    }
    this.prune(new Set(agents.map((agent) => agent.id)));

    const due: { agent: AgentRecord; at: number; start: () => Promise<TickOutcome> }[] = [];
    const skipped: TickOutcome[] = [];
    for (const agent of agents) {
      const cadence = this.cadenceOf(agent);
      if (!cadence) continue;
      const at = (await this.seed(agent, cadence.everySeconds, now)) + cadence.everySeconds * 1000;
      let wake = this.pending.get(agent.id);
      if (wake && (!this.watching(agent.id) || now - wake.at > this.heartbeatMs(agent.id))) {
        this.pending.delete(agent.id);
        wake = undefined;
      }
      if (!wake && now < at) continue;
      if (this.claimed.has(agent.id) || this.runner.isRunning(agent.id)) {
        skipped.push({ agentId: agent.id, ran: false, reason: 'run_in_progress' });
        continue;
      }
      const pending = wake;
      const start = pending
        ? () => this.runDue(agent, pending)
        : this.watching(agent.id)
          ? () => this.watchDue(agent, now)
          : () => this.runDue(agent);
      due.push({ agent, at, start });
    }
    // Most overdue first, so a full limiter serves the longest wait first.
    due.sort((a, b) => a.at - b.at);
    return [...skipped, ...(await Promise.all(due.map(({ start }) => start())))];
  }

  /** What `GET /agents/:id/schedule` returns. */
  async status(agent: AgentRecord, now: number = Date.now()): Promise<AgentScheduleStatusDto> {
    const cadence = this.cadenceOf(agent);
    let lastRunAt: number | null = null;
    try {
      const [last] = await this.events.list(agent.id, { kind: 'run', limit: 1 });
      if (last) lastRunAt = startedAtOf(last);
    } catch (error) {
      this.logger.warn(`status: could not read ${agent.id}'s log: ${errorText(error)}`);
    }

    let nextRunAt: number | null = null;
    let paused: SchedulePause | null = null;
    if (cadence && agent.status === 'active' && this.config.pollSeconds !== undefined) {
      paused = this.guard.pausedFor(agent.id, now);
      const at = (await this.seed(agent, cadence.everySeconds, now)) + cadence.everySeconds * 1000;
      if (!paused) nextRunAt = Math.max(at, now);
      // A pause with no end (low or unreadable credits) has no next run to promise.
      else if (paused.until !== null) nextRunAt = Math.max(at, paused.until, now);
    }

    return {
      everySeconds: cadence?.everySeconds ?? null,
      source: cadence?.source ?? null,
      lastRunAt: iso(lastRunAt),
      nextRunAt: iso(nextRunAt),
      paused: paused ? { reason: paused.reason, until: iso(paused.until) } : null,
      watchers: this.watchers?.summary(agent.id) ?? null,
    };
  }

  private watching(agentId: string): boolean {
    return this.watchers?.has(agentId) ?? false;
  }

  private heartbeatMs(agentId: string): number {
    return (this.watchers?.heartbeatSeconds(agentId) ?? Infinity) * 1000;
  }

  /**
   * A due agent with watchers: check them without the model, and start a run
   * only when one fires or the heartbeat is due. The check itself moves the
   * agent's next due time a cadence on, like a run would.
   */
  private async watchDue(agent: AgentRecord, now: number): Promise<TickOutcome> {
    const watchers = this.watchers!;
    this.claimed.add(agent.id);
    let wake: RunWake;
    try {
      const idle = now - (await this.lastRunOf(agent.id, now));
      const heartbeat = idle >= this.heartbeatMs(agent.id);
      // One store write: the check also counts the model call it saved, unless a run follows.
      const fired = await watchers.check(agent, now, { waking: heartbeat });
      this.lastStart.set(agent.id, now);
      if (fired.length > 0) {
        wake = { reason: 'watchers', at: now, fired };
      } else if (heartbeat) {
        wake = { reason: 'heartbeat', at: now, fired: [], idleSeconds: Math.round(idle / 1000) };
      } else {
        return { agentId: agent.id, ran: false, reason: 'watching' };
      }
    } catch (error) {
      this.logger.warn(`poll: could not check ${agent.id}'s watchers: ${errorText(error)}`);
      return { agentId: agent.id, ran: false, reason: 'watchers_unavailable' };
    } finally {
      this.claimed.delete(agent.id);
    }
    this.pending.set(agent.id, wake);
    return this.runDue(agent, wake);
  }

  /**
   * When the agent last ran, any trigger: the cached value, refreshed from
   * the log once it looks like a heartbeat is due, so a manual run in
   * between counts.
   */
  private async lastRunOf(agentId: string, now: number): Promise<number> {
    const known = this.lastRun.get(agentId) ?? now;
    if (now - known < this.heartbeatMs(agentId)) return known;
    try {
      const [last] = await this.events.list(agentId, { kind: 'run', limit: 1 });
      if (last) {
        const at = Math.max(known, startedAtOf(last));
        this.lastRun.set(agentId, at);
        return at;
      }
    } catch (error) {
      this.logger.warn(`heartbeat: could not read ${agentId}'s log: ${errorText(error)}`);
    }
    return known;
  }

  private async runDue(agent: AgentRecord, wake?: RunWake): Promise<TickOutcome> {
    this.claimed.add(agent.id);
    try {
      await this.acquire();
      try {
        return await this.runGuarded(agent, wake);
      } finally {
        this.release();
      }
    } finally {
      this.claimed.delete(agent.id);
    }
  }

  private async runGuarded(agent: AgentRecord, wake?: RunWake): Promise<TickOutcome> {
    const now = Date.now();
    const verdict = await this.guard.check(agent, now);
    if (!verdict.ok) return { agentId: agent.id, ran: false, reason: verdict.reason };
    // A manual run may have started while this one waited for a slot.
    if (this.runner.isRunning(agent.id)) {
      return { agentId: agent.id, ran: false, reason: 'run_in_progress' };
    }
    this.lastStart.set(agent.id, now);
    this.lastRun.set(agent.id, now);
    this.guard.recordStart(agent.id, now);
    if (wake) {
      this.pending.delete(agent.id);
      this.watchers?.record(agent.id, wake.reason === 'heartbeat' ? 'heartbeat' : 'wake', now);
    }
    try {
      const result = await this.runner.run({ userId: agent.userId }, agent.id, {
        trigger: 'schedule',
        ...(wake ? { wake } : {}),
      });
      await this.guard.onRunEnded(agent, result.stopReason, Date.now());
      return { agentId: agent.id, ran: true, stopReason: result.stopReason };
    } catch (error) {
      const reason =
        error instanceof AgentRefusedError || hasReason(error) ? error.reason : 'error';
      if (reason !== 'run_in_progress') {
        this.logger.warn(`poll: agent ${agent.id} did not run: ${errorText(error)}`);
      }
      return { agentId: agent.id, ran: false, reason };
    }
  }

  /**
   * The agent's `lastStart`, seeding it on first sight from the durable log:
   * the last `run` of any trigger, and today's scheduled runs for the daily
   * cap. With no history, see `unrunStart`.
   */
  private async seed(agent: AgentRecord, everySeconds: number, now: number): Promise<number> {
    const known = this.lastStart.get(agent.id);
    if (known !== undefined) return known;
    let runs: AgentEvent[] = [];
    try {
      // Every run, not the last `maxRunsPerDay`: manual runs would push
      // today's scheduled ones out of a page and under-count the cap.
      runs = await this.events.list(agent.id, { kind: 'run' });
    } catch (error) {
      this.logger.warn(`seed: could not read ${agent.id}'s log: ${errorText(error)}`);
    }
    // Another poll or a status read may have seeded it during the await.
    const raced = this.lastStart.get(agent.id);
    if (raced !== undefined) return raced;
    const last = runs.at(-1);
    const start = last
      ? startedAtOf(last)
      : unrunStart(agent.createdAt.getTime(), everySeconds, now);
    this.lastStart.set(agent.id, start);
    this.lastRun.set(agent.id, last ? start : agent.createdAt.getTime());
    this.guard.seedStarts(
      agent.id,
      runs.filter((event) => event.detail['trigger'] === 'schedule').map(startedAtOf),
      now,
    );
    return start;
  }

  /** Forgets revoked or deleted agents, so a long-lived process doesn't grow. */
  private prune(active: ReadonlySet<string>): void {
    for (const id of this.lastStart.keys()) {
      if (!active.has(id) && !this.claimed.has(id)) {
        this.lastStart.delete(id);
        this.lastRun.delete(id);
        this.pending.delete(id);
        this.guard.forget(id);
      }
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.config.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    // The releasing run hands its slot straight over, so `active` stays put.
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}

/** The most a never-run agent's first start is pulled forward to spread agents out. */
const AGENT_SCHEDULE_SPREAD_SECONDS = 3_600;

/**
 * `lastStart` for an agent that has never run: the latest cadence boundary
 * counted from its hire, pulled back by a random spread so agents hired
 * together don't all fire on the same poll.
 *
 * Phased from the hire rather than from boot (SEN-158): with weekly cadences
 * a random point in the last cadence meant a restart re-rolled a never-run
 * agent's first run anywhere in the next 7 days — immediately, or a week
 * late. Counting from `createdAt` gives the same answer on every boot. The
 * spread is capped at an hour, since a week-wide one would be the same
 * re-roll again.
 */
function unrunStart(createdAt: number, everySeconds: number, now: number): number {
  const cadence = everySeconds * 1000;
  const boundary = createdAt + Math.max(0, Math.floor((now - createdAt) / cadence)) * cadence;
  const spread = Math.min(everySeconds, AGENT_SCHEDULE_SPREAD_SECONDS) * 1000;
  return boundary - Math.random() * spread;
}

/** When the run started: its summary's `startedAt`, else when it was logged. */
function startedAtOf(event: AgentEvent): number {
  const startedAt = event.detail['startedAt'];
  const parsed = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN;
  return Number.isNaN(parsed) ? event.at : parsed;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function hasReason(error: unknown): error is { reason: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { reason?: unknown }).reason === 'string'
  );
}
