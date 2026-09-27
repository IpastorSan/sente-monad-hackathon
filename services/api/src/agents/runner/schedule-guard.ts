import { Inject, Injectable, Logger } from '@nestjs/common';

import { CreditsRefusedError } from '../../credits/credits.errors';
import { CreditsService, type CreditsView } from '../../credits/credits.service';
import type { AgentRecord } from '../store/agent-store';
import type { RunStopReason } from './agent-runner.service';
import { errorText } from './openrouter-client';
import { AGENT_SCHEDULE_CONFIG, type AgentScheduleConfig } from './runner.config';

/** Why a scheduled run was held back. Wire-stable: `GET /agents/:id/schedule` returns it. */
export type ScheduleBlockReason =
  'credits_low' | 'credits_exhausted' | 'credits_unavailable' | 'daily_cap';

/** `until` is epoch ms; absent when nothing but a later check can lift the block. */
export type ScheduleVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ScheduleBlockReason; readonly until?: number };

export interface SchedulePause {
  readonly reason: ScheduleBlockReason;
  readonly until: number | null;
}

/** Long enough that a 15 s poll over many agents is one OpenRouter read per user a minute. */
export const CREDITS_CACHE_MS = 60_000;

const DAY_MS = 86_400_000;

type CachedCredits =
  | { readonly at: number; readonly view: CreditsView }
  | { readonly at: number; readonly refusal: string };

type GuardAgent = Pick<AgentRecord, 'id' | 'userId'>;

/**
 * Decides whether a SCHEDULED run may start (SEN-71). A manual run never asks:
 * the owner pressed the button and sees the outcome.
 *
 * Why a guard at all: at a 60 s cadence one agent may run 1,440 times a day,
 * each spending its owner's OpenRouter budget unprompted, and a run on an
 * empty key still costs a model round trip to learn it (plan-backend.md,
 * "Scheduler cost"). So, cheapest check first:
 *
 * 1. a pause set when a run ended `credits_exhausted`, until the key resets;
 * 2. the per-agent daily cap (UTC day);
 * 3. the owner's credits, read through `CreditsService.status` and cached
 *    60 s per user — every agent of one owner shares one read.
 *
 * In-process state, like the runner's; the daily count is re-seeded from the
 * event log at boot by the scheduler.
 */
@Injectable()
export class ScheduleGuard {
  private readonly logger = new Logger(ScheduleGuard.name);
  private readonly credits = new Map<string, CachedCredits>();
  /** Set only by a run that ended `credits_exhausted`: no credits read lifts it early. */
  private readonly exhausted = new Map<string, number>();
  private readonly starts = new Map<string, { day: number; count: number }>();
  /** The last refusal per agent, for `GET /agents/:id/schedule`. */
  private readonly blocked = new Map<string, SchedulePause>();

  constructor(
    @Inject(AGENT_SCHEDULE_CONFIG) private readonly config: AgentScheduleConfig,
    @Inject(CreditsService) private readonly creditsService: Pick<CreditsService, 'status'>,
  ) {}

  async check(agent: GuardAgent, now: number): Promise<ScheduleVerdict> {
    const verdict = await this.evaluate(agent, now);
    if (verdict.ok) this.blocked.delete(agent.id);
    else this.blocked.set(agent.id, { reason: verdict.reason, until: verdict.until ?? null });
    return verdict;
  }

  /** Counts a scheduled start against today's cap. */
  recordStart(agentId: string, now: number): void {
    const day = utcDay(now);
    const current = this.starts.get(agentId);
    this.starts.set(agentId, {
      day,
      count: current?.day === day ? current.count + 1 : 1,
    });
  }

  /** Boot: today's scheduled starts from the durable log, so a restart doesn't reset the cap. */
  seedStarts(agentId: string, startedAt: readonly number[], now: number): void {
    const day = utcDay(now);
    const count = startedAt.filter((at) => utcDay(at) === day).length;
    if (count > 0) this.starts.set(agentId, { day, count });
  }

  /**
   * A run that ended `credits_exhausted` (OpenRouter's 402) pauses the agent
   * until the key's limit resets, read fresh. Without a known reset the
   * credits check on each poll stands in, since it sees the empty key too.
   */
  async onRunEnded(agent: GuardAgent, stopReason: RunStopReason, now: number): Promise<void> {
    if (stopReason !== 'credits_exhausted') return;
    this.credits.delete(agent.userId);
    const cached = await this.creditsOf(agent.userId, now);
    const resetsAt = 'view' in cached ? cached.view.resetsAt : null;
    if (resetsAt === null) return;
    const until = Date.parse(resetsAt);
    if (Number.isNaN(until) || until <= now) return;
    this.exhausted.set(agent.id, until);
    this.blocked.set(agent.id, { reason: 'credits_exhausted', until });
  }

  /** Why the agent's scheduled runs are held back right now, if they are. */
  pausedFor(agentId: string, now: number): SchedulePause | null {
    const pause = this.blocked.get(agentId);
    if (!pause) return null;
    if (pause.until !== null && pause.until <= now) {
      this.blocked.delete(agentId);
      return null;
    }
    return pause;
  }

  /** Drops what the guard holds for an agent that is no longer scheduled. */
  forget(agentId: string): void {
    this.exhausted.delete(agentId);
    this.starts.delete(agentId);
    this.blocked.delete(agentId);
  }

  private async evaluate(agent: GuardAgent, now: number): Promise<ScheduleVerdict> {
    const pausedUntil = this.exhausted.get(agent.id);
    if (pausedUntil !== undefined) {
      if (pausedUntil > now) return { ok: false, reason: 'credits_exhausted', until: pausedUntil };
      this.exhausted.delete(agent.id);
    }

    const today = this.starts.get(agent.id);
    if (today?.day === utcDay(now) && today.count >= this.config.maxRunsPerDay) {
      return { ok: false, reason: 'daily_cap', until: utcDay(now) + DAY_MS };
    }

    const cached = await this.creditsOf(agent.userId, now);
    if ('refusal' in cached) {
      // No key yet: the run mints one with the default limit before spending
      // anything (AgentRunnerService.userKey), so there is nothing to guard.
      return cached.refusal === 'not_provisioned'
        ? { ok: true }
        : { ok: false, reason: 'credits_unavailable' };
    }
    const { remainingUsd, resetsAt } = cached.view;
    if (remainingUsd === null) return { ok: true };
    if (remainingUsd <= 0) {
      const until = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
      return {
        ok: false,
        reason: 'credits_exhausted',
        ...(Number.isNaN(until) ? {} : { until }),
      };
    }
    if (remainingUsd < this.config.minCreditsUsd) return { ok: false, reason: 'credits_low' };
    return { ok: true };
  }

  private async creditsOf(userId: string, now: number): Promise<CachedCredits> {
    const cached = this.credits.get(userId);
    if (cached && now - cached.at < CREDITS_CACHE_MS) return cached;
    let fresh: CachedCredits;
    try {
      fresh = { at: now, view: await this.creditsService.status({ userId }, new Date(now)) };
    } catch (error) {
      const refusal = error instanceof CreditsRefusedError ? error.reason : 'error';
      if (refusal !== 'not_provisioned') {
        this.logger.warn(`credits for ${userId} unavailable: ${errorText(error)}`);
      }
      fresh = { at: now, refusal };
    }
    this.credits.set(userId, fresh);
    return fresh;
  }
}

/** Start of the UTC day holding `ms`, epoch ms. */
function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}
