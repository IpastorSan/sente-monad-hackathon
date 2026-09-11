import { Logger, type LoggerService } from '@nestjs/common';

import { CreditsRefusedError } from '../../credits/credits.errors';
import { AgentRefusedError } from '../agents.errors';
import { GATED_TOOLS } from '../tools/gate';
import { MON_USDC } from '../tools/testing/agent-fixture';
import { SENTE_PREAMBLE } from './prompt';
import { apiError, assistant, text, toolUse } from './testing/fake-messages';
import { deferred, FIRST_USER_KEY, runnerHarness, waitFor } from './testing/runner-harness';

/** Everything the process would print: Nest's logger and the console. */
const printed: string[] = [];
const capture = (...args: unknown[]) => {
  printed.push(args.map(String).join(' '));
};
const captureLogger: LoggerService = {
  log: capture,
  error: capture,
  warn: capture,
  debug: capture,
  verbose: capture,
  fatal: capture,
};

beforeAll(() => {
  Logger.overrideLogger(captureLogger);
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(console, method).mockImplementation(capture);
  }
});
beforeEach(() => {
  printed.length = 0;
});

const THESIS = {
  market: MON_USDC,
  direction: 'long',
  thesis: 'MON is breaking out of its range.',
  invalidation: 'Back under 3.2; cancel the bid.',
};
const BID = { venue: 'kuru', market: MON_USDC, side: 'buy', size: '10', price: '3.5' };

describe('AgentRunnerService', () => {
  it('runs tool_use -> tool_result -> end_turn, with the agent’s model and prompt, billed to its owner', async () => {
    const h = await runnerHarness({
      responses: [
        assistant(
          [text('Recording a thesis.'), toolUse('tu_1', 'record_thesis', THESIS)],
          'tool_use',
          {
            costUsd: 0.001,
          },
        ),
        assistant([toolUse('tu_2', 'place_limit', BID)], 'tool_use', { costUsd: 0.002 }),
        assistant([text('One bid resting. Nothing else to do.')], 'end_turn', { costUsd: 0.0005 }),
      ],
    });

    const result = await h.run({ instruction: 'Look at MON-USDC.' });

    expect(result).toMatchObject({
      agentId: h.agent.id,
      trigger: 'manual',
      model: 'anthropic/claude-sonnet-5',
      stopReason: 'end_turn',
      iterations: 3,
      toolCalls: 2,
      finalText: 'One bid resting. Nothing else to do.',
      costUsd: 0.0035,
    });
    expect(result.runId).toMatch(/^run-/);
    expect(result.events.map((e) => e.kind)).toEqual(['thesis', 'order', 'run']);
    expect(result.events.every((e) => e.runId === result.runId)).toBe(true);
    expect(result.events[2]!.detail).toMatchObject({
      stopReason: 'end_turn',
      iterations: 3,
      toolCalls: 2,
      costUsd: 0.0035,
      trigger: 'manual',
      instruction: 'Look at MON-USDC.',
    });
    expect(h.kuru.writes().map((c) => c.method)).toEqual(['placeLimit']);

    // The owner's key was provisioned on first use and sent as a Bearer token.
    expect(h.openrouter.calls.some((c) => c.method === 'POST' && c.url.endsWith('/keys'))).toBe(
      true,
    );
    const first = h.api.requests[0]!;
    expect(first.headers['authorization']).toBe(`Bearer ${FIRST_USER_KEY}`);
    expect(first.headers).not.toHaveProperty('x-api-key');

    // The request: the agent's model, the bounds, the gated tools, no extras.
    expect(first.body).toMatchObject({ model: 'anthropic/claude-sonnet-5', max_tokens: 4096 });
    expect(first.body).not.toHaveProperty('thinking');
    expect(first.body).not.toHaveProperty('provider');
    expect(first.body).not.toHaveProperty('max_iterations');
    expect((first.body['tools'] as { name: string }[]).map((t) => t.name)).toEqual(
      GATED_TOOLS.map((t) => t.name),
    );
    const system = first.body['system'] as string;
    expect(system.startsWith(SENTE_PREAMBLE)).toBe(true);
    expect(system).toContain('<strategy>\nBuy strength.\n</strategy>');

    // The first message is the tick snapshot, read through the gated tools.
    const tick = h.api.messagesOf(0)[0]!;
    expect(tick.role).toBe('user');
    const tickText = tick.content as string;
    expect(tickText).toMatch(/^Tick: \d{4}-/);
    expect(tickText).toContain('"asset": "USDC"');
    expect(tickText).toContain('"kuru:MON-USDC"');
    expect(tickText).toContain('"perpl:BTC-PERP"');
    expect(tickText).toContain('"positions"');
    expect(tickText).toContain(
      '<user_run_instruction>\nLook at MON-USDC.\n</user_run_instruction>',
    );

    // Each tool result went back to the model on the next request.
    const results = (i: number) =>
      h.api.messagesOf(i).at(-1)!.content as {
        type: string;
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }[];
    expect(results(1)[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
    expect(results(1)[0]!.content).toContain('"recorded":true');
    expect(results(2)[0]).toMatchObject({ tool_use_id: 'tu_2' });
    expect(results(2)[0]!.is_error).toBeUndefined();

    // Each assistant turn's tool calls were logged.
    expect(printed.some((line) => /turn 1: record_thesis/.test(line))).toBe(true);
    expect(printed.some((line) => /turn 2: place_limit/.test(line))).toBe(true);
  });

  it('returns a refusal to the model as an error result, and the run carries on', async () => {
    const h = await runnerHarness({
      responses: [
        // No thesis first: the gate refuses.
        assistant([toolUse('tu_1', 'place_limit', BID)], 'tool_use'),
        assistant([text('Refused; stopping.')], 'end_turn'),
      ],
    });
    const result = await h.run();
    const [refusal] = h.api.messagesOf(1).at(-1)!.content as {
      content: string;
      is_error: boolean;
    }[];
    expect(refusal).toMatchObject({ is_error: true });
    expect(refusal!.content).toMatch(/^Refused by Sente mandate: thesis_required/);
    expect(result.stopReason).toBe('end_turn');
    expect(result.events.map((e) => e.kind)).toEqual(['refusal', 'run']);
    expect(h.kuru.writes()).toEqual([]);
  });

  it('honours max_iterations', async () => {
    const reads = Array.from({ length: 5 }, (_, i) =>
      assistant([toolUse(`tu_${i}`, 'get_balances', {})], 'tool_use'),
    );
    const h = await runnerHarness({ responses: reads, config: { maxIterations: 2 } });
    const result = await h.run();
    expect(result).toMatchObject({ stopReason: 'max_iterations', iterations: 2, toolCalls: 2 });
    expect(h.api.requests).toHaveLength(2);
  });

  it.each(['refusal', 'max_tokens', 'model_context_window_exceeded'] as const)(
    'records a quiet %s stop',
    async (reason) => {
      const h = await runnerHarness({ responses: [assistant([text('…')], reason)] });
      const result = await h.run();
      expect(result.stopReason).toBe(reason);
      expect(result.events.at(-1)).toMatchObject({ kind: 'run', detail: { stopReason: reason } });
      expect(printed.some((line) => line.includes(`ended: ${reason}`))).toBe(true);
    },
  );

  it('maps an OpenRouter 402 to credits_exhausted, recorded', async () => {
    const h = await runnerHarness({ responses: [apiError(402, 'Insufficient credits')] });
    const result = await h.run();
    expect(result).toMatchObject({ stopReason: 'credits_exhausted', iterations: 0 });
    expect(result.error).toMatch(/402/);
    expect(result.events).toEqual([
      expect.objectContaining({
        kind: 'run',
        detail: expect.objectContaining({ stopReason: 'credits_exhausted' }),
      }),
    ]);
  });

  it('does not call the model at all when the key has nothing left', async () => {
    const h = await runnerHarness();
    await h.credits.provision(h.principal);
    h.openrouter.spend('hash1', 5);
    const result = await h.run();
    expect(result.stopReason).toBe('credits_exhausted');
    expect(h.api.requests).toEqual([]);
  });

  it('maps any other API failure to model_error', async () => {
    const h = await runnerHarness({ responses: [apiError(400, 'tools: unsupported schema')] });
    const result = await h.run();
    expect(result.stopReason).toBe('model_error');
    expect(result.error).toMatch(/400.*unsupported schema/);
  });

  it('refuses a second concurrent run of the same agent with run_in_progress', async () => {
    const hold = deferred();
    const h = await runnerHarness({
      responses: [
        async () => {
          await hold.promise;
          return assistant([text('done')], 'end_turn');
        },
        assistant([text('again')], 'end_turn'),
      ],
    });

    const first = h.run();
    await waitFor(() => h.api.requests.length === 1);
    const second: unknown = await h.run().catch((e: unknown) => e);
    expect(second).toBeInstanceOf(AgentRefusedError);
    expect(second).toMatchObject({ reason: 'run_in_progress' });
    expect(h.runner.isRunning(h.agent.id)).toBe(true);

    hold.resolve();
    expect((await first).stopReason).toBe('end_turn');
    expect(h.runner.isRunning(h.agent.id)).toBe(false);
    expect((await h.run()).stopReason).toBe('end_turn');
  });

  it('refuses a revoked agent before spending anything, and another user’s agent as not found', async () => {
    const h = await runnerHarness({ responses: [assistant([text('x')], 'end_turn')] });
    await h.store.update(h.agent.id, { status: 'revoked' });
    await expect(h.run()).rejects.toMatchObject({ reason: 'agent_revoked' });
    await expect(h.runner.run({ userId: 'bob' }, h.agent.id)).rejects.toMatchObject({
      reason: 'agent_not_found',
    });
    expect(h.api.requests).toEqual([]);
    expect(h.openrouter.calls).toEqual([]);
  });

  it('stops a run whose agent is revoked mid-run, before that turn’s tools execute', async () => {
    const revoking = await runnerHarness({
      responses: [
        async () => {
          await revoking.store.update(revoking.agent.id, { status: 'revoked' });
          return assistant([toolUse('tu_1', 'record_thesis', THESIS)], 'tool_use');
        },
      ],
    });
    const result = await revoking.run();
    expect(result).toMatchObject({ stopReason: 'agent_revoked', iterations: 1 });
    expect(result.events.map((e) => e.kind)).toEqual(['run']);
  });

  it('enforces the wall-clock timeout', async () => {
    const h = await runnerHarness({ responses: ['hang'], config: { timeoutMs: 100 } });
    const started = Date.now();
    const result = await h.run();
    expect(result.stopReason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('refuses with credits_unconfigured when there is no management key, and frees the slot', async () => {
    const h = await runnerHarness({ creditsConfigured: false });
    const error: unknown = await h.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CreditsRefusedError);
    expect(error).toMatchObject({ reason: 'credits_unconfigured' });
    expect(h.runner.isRunning(h.agent.id)).toBe(false);
  });

  it('pins Kimi to its provider, and sends thinking only when the flag is on', async () => {
    const h = await runnerHarness({
      agent: { model: 'moonshotai/kimi-k2.6' },
      config: { thinking: true },
      responses: [assistant([text('ok')], 'end_turn')],
    });
    await h.run();
    expect(h.api.requests[0]!.body).toMatchObject({
      model: 'moonshotai/kimi-k2.6',
      provider: { order: ['Moonshot AI'], allow_fallbacks: false },
      thinking: { type: 'adaptive' },
    });
  });

  it('spaces the signing writes of one turn apart', async () => {
    const h = await runnerHarness({
      config: { writeSpacingMs: 80 },
      responses: [
        assistant([toolUse('tu_1', 'record_thesis', THESIS)], 'tool_use'),
        // Two orders in ONE turn: the Tool Runner runs them with Promise.all.
        assistant(
          [
            toolUse('tu_2', 'place_limit', BID),
            toolUse('tu_3', 'place_limit', { ...BID, price: '3.4' }),
          ],
          'tool_use',
        ),
        assistant([text('done')], 'end_turn'),
      ],
    });
    const stamps: number[] = [];
    h.kuru.onWrite = () => {
      stamps.push(Date.now());
      return Promise.resolve();
    };
    const result = await h.run();
    expect(result.stopReason).toBe('end_turn');
    expect(stamps).toHaveLength(2);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(75);
  });

  it('never prints the user’s key, nor puts it in a result or an event', async () => {
    const h = await runnerHarness({
      responses: [
        assistant([toolUse('tu_1', 'get_balances', {})], 'tool_use'),
        assistant([text('fine')], 'end_turn'),
        // An upstream that echoes the key back in its error text.
        apiError(401, `invalid key ${FIRST_USER_KEY} for this model`),
      ],
    });
    const ok = await h.run();
    const failed = await h.run();

    expect(failed.stopReason).toBe('model_error');
    expect(failed.error).toContain('[redacted]');
    // It was used: that is the point of it.
    expect(h.api.requests[0]!.headers['authorization']).toBe(`Bearer ${FIRST_USER_KEY}`);
    // And it is nowhere else.
    const everything = [
      ...printed,
      JSON.stringify(ok),
      JSON.stringify(failed),
      JSON.stringify(await h.events.list(h.agent.id)),
    ].join('\n');
    expect(printed.length).toBeGreaterThan(0);
    expect(everything).not.toContain(FIRST_USER_KEY);
    expect(everything).not.toContain('PLAINTEXT');
  });
});
