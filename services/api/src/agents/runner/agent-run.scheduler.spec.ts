import { Logger } from '@nestjs/common';

import { testAgent } from '../tools/testing/agent-fixture';
import { AgentRunScheduler } from './agent-run.scheduler';
import { assistant, text } from './testing/fake-messages';
import { deferred, runnerHarness, waitFor } from './testing/runner-harness';

beforeAll(() => Logger.overrideLogger(false));

const REVOKED_ID = '22222222-2222-4222-8222-222222222222';

describe('AgentRunScheduler', () => {
  it('stays off without AGENT_TICK_SECONDS, and turns on and off with it', async () => {
    const h = await runnerHarness();
    const off = new AgentRunScheduler(h.config, h.store, h.runner);
    off.onApplicationBootstrap();
    expect(off.enabled).toBe(false);

    const on = new AgentRunScheduler({ ...h.config, tickSeconds: 60 }, h.store, h.runner);
    on.onApplicationBootstrap();
    expect(on.enabled).toBe(true);
    on.onModuleDestroy();
    expect(on.enabled).toBe(false);
  });

  it('runs every active agent once per tick, as a scheduled run', async () => {
    const h = await runnerHarness({ responses: [assistant([text('nothing to do')], 'end_turn')] });
    await h.store.insert(
      testAgent({ id: REVOKED_ID, mcpTokenHash: 'b'.repeat(64), status: 'revoked' }),
    );
    const scheduler = new AgentRunScheduler({ ...h.config, tickSeconds: 60 }, h.store, h.runner);

    expect(await scheduler.tick()).toEqual([
      { agentId: h.agent.id, ran: true, stopReason: 'end_turn' },
    ]);
    const [summary] = await h.events.list(h.agent.id, { kind: 'run' });
    expect(summary!.detail).toMatchObject({ trigger: 'schedule' });
  });

  it('skips an agent whose previous run is still open', async () => {
    const hold = deferred();
    const h = await runnerHarness({
      responses: [
        async () => {
          await hold.promise;
          return assistant([text('done')], 'end_turn');
        },
      ],
    });
    const scheduler = new AgentRunScheduler({ ...h.config, tickSeconds: 60 }, h.store, h.runner);
    const first = scheduler.tick();
    await waitFor(() => h.api.requests.length === 1);

    expect(await scheduler.tick()).toEqual([
      { agentId: h.agent.id, ran: false, reason: 'run_in_progress' },
    ]);
    hold.resolve();
    expect(await first).toEqual([{ agentId: h.agent.id, ran: true, stopReason: 'end_turn' }]);
  });

  it('reports an agent that could not run, and never throws', async () => {
    const h = await runnerHarness({ creditsConfigured: false });
    const scheduler = new AgentRunScheduler({ ...h.config, tickSeconds: 60 }, h.store, h.runner);
    expect(await scheduler.tick()).toEqual([
      { agentId: h.agent.id, ran: false, reason: 'credits_unconfigured' },
    ]);
  });
});
