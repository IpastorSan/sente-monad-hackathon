import { Logger } from '@nestjs/common';

import type { CreditsView } from '../../credits/credits.service';
import { AgentsController } from '../agents.controller';
import { InMemoryAgentEventLog } from '../events/agent-event-log';
import { InMemoryAgentStore, type AgentRecord } from '../store/agent-store';
import { testAgent } from '../tools/testing/agent-fixture';
import { AgentRunScheduler } from './agent-run.scheduler';
import type { RunResult, RunStopReason } from './agent-runner.service';
import {
  AGENT_RUNNER_DEFAULTS,
  AGENT_SCHEDULE_DEFAULTS,
  type AgentScheduleConfig,
} from './runner.config';
import { ScheduleGuard } from './schedule-guard';
import { assistant, text } from './testing/fake-messages';
import { deferred, runnerHarness } from './testing/runner-harness';

beforeAll(() => Logger.overrideLogger(false));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const T0 = Date.parse('2026-09-27T10:00:00.000Z');
const RESETS_AT = '2026-10-01T00:00:00.000Z';
const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

/** A runner that records who it ran; `hold` keeps runs open until released. */
class FakeRunner {
  readonly calls: string[] = [];
  readonly running = new Set<string>();
  hold: Promise<void> | undefined;
  stopReason: RunStopReason = 'end_turn';

  isRunning(agentId: string): boolean {
    return this.running.has(agentId);
  }

  async run(_principal: unknown, agentId: string, options?: { trigger?: string }) {
    expect(options?.trigger).toBe('schedule');
    this.calls.push(agentId);
    this.running.add(agentId);
    try {
      await this.hold;
      return { stopReason: this.stopReason } as RunResult;
    } finally {
      this.running.delete(agentId);
    }
  }

  count(agentId: string): number {
    return this.calls.filter((id) => id === agentId).length;
  }
}

async function setup(
  options: {
    agents?: Partial<AgentRecord>[];
    tickSeconds?: number;
    schedule?: Partial<AgentScheduleConfig>;
    credits?: () => Promise<CreditsView>;
  } = {},
) {
  const store = new InMemoryAgentStore();
  const agents = (options.agents ?? [{ schedule: { everySeconds: 60 } }]).map((patch, i) =>
    testAgent({ id: IDS[i], mcpTokenHash: String(i).repeat(64), ...patch }),
  );
  for (const agent of agents) await store.insert(agent);
  const events = new InMemoryAgentEventLog();
  const runner = new FakeRunner();
  const credits = {
    status: jest.fn(
      options.credits ??
        (async (): Promise<CreditsView> => ({
          limitUsd: 5,
          remainingUsd: 4,
          usageMonthUsd: 1,
          resetsAt: RESETS_AT,
        })),
    ),
  };
  const config = { ...AGENT_SCHEDULE_DEFAULTS, ...options.schedule };
  const guard = new ScheduleGuard(config, credits);
  const scheduler = new AgentRunScheduler(
    { ...AGENT_RUNNER_DEFAULTS, thinking: false, tickSeconds: options.tickSeconds },
    config,
    store,
    runner,
    events,
    guard,
  );
  /** A past `run` summary, as the runner writes it. */
  const ran = (agentId: string, startedAt: number, trigger = 'schedule') =>
    events.append({
      agentId,
      kind: 'run',
      at: startedAt + 5_000,
      detail: { trigger, startedAt: new Date(startedAt).toISOString() },
    });
  return { store, agents, events, runner, credits, guard, scheduler, ran };
}

/** Lets pending promise chains settle without moving the fake clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('AgentRunScheduler (SEN-71)', () => {
  it('polls every 15 s by default, and stays off with AGENT_SCHEDULER_POLL_SECONDS=off', async () => {
    const off = await setup({ schedule: { pollSeconds: undefined } });
    off.scheduler.onApplicationBootstrap();
    expect(off.scheduler.enabled).toBe(false);

    const on = await setup();
    on.scheduler.onApplicationBootstrap();
    expect(on.scheduler.enabled).toBe(true);
    on.scheduler.onModuleDestroy();
    expect(on.scheduler.enabled).toBe(false);
  });

  it('runs each agent on its own cadence', async () => {
    jest.useFakeTimers({ now: T0 });
    const h = await setup({
      agents: [{ schedule: { everySeconds: 60 } }, { schedule: { everySeconds: 300 } }, {}],
    });
    const [fast, slow, manual] = h.agents;
    await h.ran(fast!.id, T0 - 60_000);
    await h.ran(slow!.id, T0 - 60_000);
    h.scheduler.onApplicationBootstrap();

    await jest.advanceTimersByTimeAsync(300_000);
    h.scheduler.onModuleDestroy();

    // Due at T0, first seen at T0+15 s, then every 60 s: 15, 75, 135, 195, 255.
    expect(h.runner.count(fast!.id)).toBe(5);
    // Due at T0+240 s.
    expect(h.runner.count(slow!.id)).toBe(1);
    // No schedule and no AGENT_TICK_SECONDS: manual only.
    expect(h.runner.count(manual!.id)).toBe(0);
  });

  it('still runs agents without a schedule every AGENT_TICK_SECONDS, if it is set', async () => {
    jest.useFakeTimers({ now: T0 });
    const h = await setup({ agents: [{}, { schedule: { everySeconds: 600 } }], tickSeconds: 120 });
    const [legacy, own] = h.agents;
    await h.ran(legacy!.id, T0 - 120_000);
    await h.ran(own!.id, T0 - 120_000);

    expect(await h.scheduler.poll()).toEqual([
      { agentId: legacy!.id, ran: true, stopReason: 'end_turn' },
    ]);
    expect(await h.scheduler.status(own!)).toMatchObject({ everySeconds: 600, source: 'agent' });
    expect(await h.scheduler.status(legacy!)).toMatchObject({
      everySeconds: 120,
      source: 'global',
      nextRunAt: new Date(T0 + 120_000).toISOString(),
    });
  });

  it('seeds lastStart at boot from the last run event, any trigger', async () => {
    jest.useFakeTimers({ now: T0 });
    const h = await setup();
    const agent = h.agents[0]!;
    await h.ran(agent.id, T0 - 3_600_000);
    await h.ran(agent.id, T0 - 30_000, 'manual');

    expect(await h.scheduler.poll()).toEqual([]);
    jest.setSystemTime(T0 + 29_999);
    expect(await h.scheduler.poll()).toEqual([]);
    jest.setSystemTime(T0 + 30_000);
    expect(await h.scheduler.poll()).toEqual([
      { agentId: agent.id, ran: true, stopReason: 'end_turn' },
    ]);
  });

  it('spreads agents with no history over their cadence instead of running them all at once', async () => {
    jest.useFakeTimers({ now: T0 });
    jest.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
    const h = await setup({
      agents: [{ schedule: { everySeconds: 60 } }, { schedule: { everySeconds: 60 } }],
    });
    const [early, late] = h.agents;

    expect(await h.scheduler.poll()).toEqual([]);
    // lastStart = now − 0.75 × 60 s: due 15 s after boot; the other 45 s after.
    jest.setSystemTime(T0 + 15_000);
    expect(await h.scheduler.poll()).toEqual([
      { agentId: late!.id, ran: true, stopReason: 'end_turn' },
    ]);
    jest.setSystemTime(T0 + 45_000);
    expect(await h.scheduler.poll()).toEqual([
      { agentId: early!.id, ran: true, stopReason: 'end_turn' },
    ]);
  });

  describe('weekly cadences (SEN-158)', () => {
    const WEEK = 604_800;
    const DAY_MS = 86_400_000;

    it('after a restart, runs a weekly agent a week after its last run: not now, not a week late', async () => {
      jest.useFakeTimers({ now: T0 });
      const h = await setup({ agents: [{ schedule: { everySeconds: WEEK } }] });
      const agent = h.agents[0]!;
      await h.ran(agent.id, T0 - 3 * DAY_MS);

      expect(await h.scheduler.status(agent)).toMatchObject({
        nextRunAt: new Date(T0 + 4 * DAY_MS).toISOString(),
      });
      expect(await h.scheduler.poll()).toEqual([]);
      jest.setSystemTime(T0 + 4 * DAY_MS - 1);
      expect(await h.scheduler.poll()).toEqual([]);
      jest.setSystemTime(T0 + 4 * DAY_MS);
      expect(await h.scheduler.poll()).toEqual([
        { agentId: agent.id, ran: true, stopReason: 'end_turn' },
      ]);
    });

    it('phases a never-run weekly agent from its hire, so every boot agrees on its first run', async () => {
      jest.useFakeTimers({ now: T0 });
      jest.spyOn(Math, 'random').mockReturnValue(1);
      const hiredAt = T0 - 3 * DAY_MS;
      const h = await setup({
        agents: [{ schedule: { everySeconds: WEEK }, createdAt: new Date(hiredAt) }],
      });
      const agent = h.agents[0]!;

      // At most an hour of spread, however long the cadence.
      const first = hiredAt + 7 * DAY_MS - 3_600_000;
      expect(await h.scheduler.status(agent)).toMatchObject({
        nextRunAt: new Date(first).toISOString(),
      });
      expect(await h.scheduler.poll()).toEqual([]);
      jest.setSystemTime(first);
      expect(await h.scheduler.poll()).toEqual([
        { agentId: agent.id, ran: true, stopReason: 'end_turn' },
      ]);
    });
  });

  it('runs at most AGENT_SCHEDULE_MAX_CONCURRENT at once, the rest as slots free up', async () => {
    jest.useFakeTimers({ now: T0 });
    jest.spyOn(Math, 'random').mockReturnValue(1);
    const h = await setup({
      agents: IDS.map(() => ({ schedule: { everySeconds: 60 } })),
      schedule: { maxConcurrent: 2 },
    });
    const hold = deferred();
    h.runner.hold = hold.promise;

    const poll = h.scheduler.poll();
    await settle();
    expect(h.runner.calls).toHaveLength(2);
    expect(h.runner.running.size).toBe(2);

    hold.resolve();
    expect((await poll).filter((o) => o.ran)).toHaveLength(4);
    expect(h.runner.calls).toHaveLength(4);
  });

  it('skips an agent whose previous run is still open, scheduled or manual', async () => {
    jest.useFakeTimers({ now: T0 });
    jest.spyOn(Math, 'random').mockReturnValue(1);
    const h = await setup({
      agents: [{ schedule: { everySeconds: 60 } }, { schedule: { everySeconds: 60 } }],
    });
    const [slow, manual] = h.agents;
    h.runner.running.add(manual!.id);
    const hold = deferred();
    h.runner.hold = hold.promise;

    const first = h.scheduler.poll();
    await settle();
    // A minute on, `slow` is due again but its first run is still open.
    jest.setSystemTime(T0 + 60_000);
    expect(await h.scheduler.poll()).toEqual(
      expect.arrayContaining([
        { agentId: slow!.id, ran: false, reason: 'run_in_progress' },
        { agentId: manual!.id, ran: false, reason: 'run_in_progress' },
      ]),
    );
    hold.resolve();
    expect(await first).toEqual(
      expect.arrayContaining([
        { agentId: manual!.id, ran: false, reason: 'run_in_progress' },
        { agentId: slow!.id, ran: true, stopReason: 'end_turn' },
      ]),
    );
    expect(h.runner.calls).toEqual([slow!.id]);
  });

  it('skips a run when credits are low, without calling the runner, and retries next poll', async () => {
    jest.useFakeTimers({ now: T0 });
    jest.spyOn(Math, 'random').mockReturnValue(1);
    let remainingUsd = 0.05;
    const h = await setup({
      credits: async () => ({
        limitUsd: 5,
        remainingUsd,
        usageMonthUsd: 4.95,
        resetsAt: RESETS_AT,
      }),
    });
    const agent = h.agents[0]!;

    expect(await h.scheduler.poll()).toEqual([
      { agentId: agent.id, ran: false, reason: 'credits_low' },
    ]);
    expect(h.runner.calls).toEqual([]);
    expect(await h.scheduler.status(agent)).toMatchObject({
      paused: { reason: 'credits_low', until: null },
      nextRunAt: null,
    });

    // Topped up: the next poll after the credits cache expires runs it.
    remainingUsd = 3;
    jest.setSystemTime(T0 + 60_000);
    expect(await h.scheduler.poll()).toEqual([
      { agentId: agent.id, ran: true, stopReason: 'end_turn' },
    ]);
  });

  it('pauses an agent whose run ended credits_exhausted until the credits reset', async () => {
    jest.useFakeTimers({ now: T0 });
    jest.spyOn(Math, 'random').mockReturnValue(1);
    const h = await setup();
    const agent = h.agents[0]!;
    h.runner.stopReason = 'credits_exhausted';

    expect(await h.scheduler.poll()).toEqual([
      { agentId: agent.id, ran: true, stopReason: 'credits_exhausted' },
    ]);
    h.runner.stopReason = 'end_turn';
    jest.setSystemTime(T0 + 3_600_000);
    expect(await h.scheduler.poll()).toEqual([
      { agentId: agent.id, ran: false, reason: 'credits_exhausted' },
    ]);
    expect(await h.scheduler.status(agent)).toMatchObject({
      paused: { reason: 'credits_exhausted', until: RESETS_AT },
      nextRunAt: RESETS_AT,
    });

    jest.setSystemTime(Date.parse(RESETS_AT));
    expect(await h.scheduler.poll()).toEqual([
      { agentId: agent.id, ran: true, stopReason: 'end_turn' },
    ]);
    expect(h.runner.calls).toHaveLength(2);
  });

  it('stops an agent at the daily cap, counting today’s scheduled runs from the log', async () => {
    jest.useFakeTimers({ now: T0 });
    const h = await setup({ schedule: { maxRunsPerDay: 3 } });
    const agent = h.agents[0]!;
    await h.ran(agent.id, T0 - 86_400_000);
    await h.ran(agent.id, T0 - 7_200_000);
    await h.ran(agent.id, T0 - 3_600_000, 'manual');
    await h.ran(agent.id, T0 - 60_000);

    // Two scheduled runs today already (yesterday's and the manual one don't count); one more fits.
    expect(await h.scheduler.poll()).toEqual([
      { agentId: agent.id, ran: true, stopReason: 'end_turn' },
    ]);
    jest.setSystemTime(T0 + 60_000);
    expect(await h.scheduler.poll()).toEqual([
      { agentId: agent.id, ran: false, reason: 'daily_cap' },
    ]);
    expect(await h.scheduler.status(agent)).toMatchObject({
      paused: { reason: 'daily_cap', until: '2026-09-28T00:00:00.000Z' },
    });
  });

  it('never throws when the store fails', async () => {
    const h = await setup();
    jest.spyOn(h.store, 'listActive').mockRejectedValue(new Error('disk gone'));
    expect(await h.scheduler.poll()).toEqual([]);
  });

  it('drives the real runner: a scheduled run is recorded as one', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(1);
    const r = await runnerHarness({
      responses: [assistant([text('nothing to do')], 'end_turn')],
      agent: { schedule: { everySeconds: 60 } },
    });
    // Before the owner has a key the guard lets the run through; the run mints it.
    const guard = new ScheduleGuard(AGENT_SCHEDULE_DEFAULTS, r.credits);
    const scheduler = new AgentRunScheduler(
      r.config,
      AGENT_SCHEDULE_DEFAULTS,
      r.store,
      r.runner,
      r.events,
      guard,
    );

    expect(await scheduler.poll()).toEqual([
      { agentId: r.agent.id, ran: true, stopReason: 'end_turn' },
    ]);
    const [summary] = await r.events.list(r.agent.id, { kind: 'run' });
    expect(summary!.detail).toMatchObject({ trigger: 'schedule' });
  });
});

describe('GET /agents/:id/schedule (SEN-71)', () => {
  function controllerFor(h: Awaited<ReturnType<typeof setup>>) {
    const service = { get: (_p: unknown, id: string) => h.store.get(id).then((a) => a!) };
    return new AgentsController(
      service as never,
      { principal: () => ({ userId: 'alice' }) },
      {} as never,
      h.events,
      {} as never,
      {} as never,
      h.scheduler,
    );
  }

  it('reports the cadence, the last run, the next one, and no pause', async () => {
    jest.useFakeTimers({ now: T0 });
    const h = await setup();
    const agent = h.agents[0]!;
    await h.ran(agent.id, T0 - 20_000, 'manual');

    expect(await controllerFor(h).getSchedule({ id: agent.id })).toEqual({
      everySeconds: 60,
      source: 'agent',
      lastRunAt: new Date(T0 - 20_000).toISOString(),
      nextRunAt: new Date(T0 + 40_000).toISOString(),
      paused: null,
      watchers: null,
    });
  });

  it('reports a manual-only agent as having no cadence', async () => {
    const h = await setup({ agents: [{}] });
    expect(await controllerFor(h).getSchedule({ id: h.agents[0]!.id })).toEqual({
      everySeconds: null,
      source: null,
      lastRunAt: null,
      nextRunAt: null,
      paused: null,
      watchers: null,
    });
  });
});
