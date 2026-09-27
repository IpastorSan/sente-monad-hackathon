import { Logger } from '@nestjs/common';

import { CreditsRefusedError } from '../../credits/credits.errors';
import type { CreditsView } from '../../credits/credits.service';
import { AGENT_SCHEDULE_DEFAULTS, type AgentScheduleConfig } from './runner.config';
import { CREDITS_CACHE_MS, ScheduleGuard } from './schedule-guard';

beforeAll(() => Logger.overrideLogger(false));

const T0 = Date.parse('2026-09-27T10:00:00.000Z');
const MIDNIGHT = Date.parse('2026-09-28T00:00:00.000Z');
const RESETS_AT = '2026-10-01T00:00:00.000Z';
const ALPHA = { id: 'agent-a', userId: 'alice' };
const BETA = { id: 'agent-b', userId: 'alice' };

function view(remainingUsd: number | null, resetsAt: string | null = RESETS_AT): CreditsView {
  return { limitUsd: 5, remainingUsd, usageMonthUsd: 0, resetsAt };
}

function guardWith(status: () => Promise<CreditsView>, config: Partial<AgentScheduleConfig> = {}) {
  const credits = { status: jest.fn(status) };
  const guard = new ScheduleGuard({ ...AGENT_SCHEDULE_DEFAULTS, ...config }, credits);
  return { guard, credits };
}

describe('ScheduleGuard (SEN-71)', () => {
  it('lets a run through with enough credits, or an unlimited key', async () => {
    expect(await guardWith(async () => view(1)).guard.check(ALPHA, T0)).toEqual({ ok: true });
    expect(await guardWith(async () => view(null)).guard.check(ALPHA, T0)).toEqual({ ok: true });
  });

  it('holds a run under the minimum, and an empty key until it resets', async () => {
    const low = guardWith(async () => view(0.05));
    expect(await low.guard.check(ALPHA, T0)).toEqual({ ok: false, reason: 'credits_low' });
    expect(low.guard.pausedFor(ALPHA.id, T0)).toEqual({ reason: 'credits_low', until: null });

    const empty = guardWith(async () => view(0));
    expect(await empty.guard.check(ALPHA, T0)).toEqual({
      ok: false,
      reason: 'credits_exhausted',
      until: Date.parse(RESETS_AT),
    });
  });

  it('lets a first run through before the owner has a key: the run mints it', async () => {
    const { guard } = guardWith(() =>
      Promise.reject(new CreditsRefusedError('not_provisioned', 'no key')),
    );
    expect(await guard.check(ALPHA, T0)).toEqual({ ok: true });
  });

  it('holds a run when the credits cannot be read', async () => {
    const { guard } = guardWith(() =>
      Promise.reject(new CreditsRefusedError('status_unavailable', 'OpenRouter is down')),
    );
    expect(await guard.check(ALPHA, T0)).toEqual({ ok: false, reason: 'credits_unavailable' });
  });

  it('reads the credits once per user per minute', async () => {
    const { guard, credits } = guardWith(async () => view(1));
    await guard.check(ALPHA, T0);
    await guard.check(BETA, T0 + 1_000);
    await guard.check(ALPHA, T0 + CREDITS_CACHE_MS - 1);
    expect(credits.status).toHaveBeenCalledTimes(1);
    await guard.check(ALPHA, T0 + CREDITS_CACHE_MS);
    expect(credits.status).toHaveBeenCalledTimes(2);
  });

  it('caps scheduled starts per UTC day, seeded ones included', async () => {
    const { guard } = guardWith(async () => view(1), { maxRunsPerDay: 3 });
    // Yesterday's run doesn't count.
    guard.seedStarts(ALPHA.id, [T0 - 86_400_000, T0 - 60_000], T0);
    guard.recordStart(ALPHA.id, T0);
    expect(await guard.check(ALPHA, T0)).toEqual({ ok: true });
    guard.recordStart(ALPHA.id, T0 + 1);
    expect(await guard.check(ALPHA, T0 + 2)).toEqual({
      ok: false,
      reason: 'daily_cap',
      until: MIDNIGHT,
    });
    expect(await guard.check(BETA, T0 + 2)).toEqual({ ok: true });
    expect(await guard.check(ALPHA, MIDNIGHT)).toEqual({ ok: true });
  });

  it('pauses an agent whose run hit a 402 until the key resets, whatever the key says', async () => {
    // OpenRouter answered 402 although the key still reports budget.
    const { guard, credits } = guardWith(async () => view(2));
    await guard.check(ALPHA, T0);
    await guard.onRunEnded(ALPHA, 'credits_exhausted', T0 + 10);
    // The cache was dropped so the reset is read fresh.
    expect(credits.status).toHaveBeenCalledTimes(2);

    const until = Date.parse(RESETS_AT);
    expect(await guard.check(ALPHA, T0 + CREDITS_CACHE_MS * 5)).toEqual({
      ok: false,
      reason: 'credits_exhausted',
      until,
    });
    expect(guard.pausedFor(ALPHA.id, until - 1)).toEqual({ reason: 'credits_exhausted', until });
    expect(guard.pausedFor(ALPHA.id, until)).toBeNull();
    expect(await guard.check(ALPHA, until)).toEqual({ ok: true });
  });

  it('ignores every other way a run ends', async () => {
    const { guard, credits } = guardWith(async () => view(2));
    await guard.onRunEnded(ALPHA, 'end_turn', T0);
    await guard.onRunEnded(ALPHA, 'model_error', T0);
    expect(credits.status).not.toHaveBeenCalled();
  });
});
