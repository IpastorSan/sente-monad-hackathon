import { HttpException, Logger } from '@nestjs/common';

import type { Auth } from '../../../auth/principal';
import { EnclaveRefusedError } from '../../agents.errors';
import { MON_USDC } from '../../tools/testing/agent-fixture';
import { apiError, assistant, text, toolUse } from '../testing/fake-messages';
import { deferred, FIRST_USER_KEY, runnerHarness, waitFor } from '../testing/runner-harness';
import { AgentRunsController } from './agent-runs.controller';
import type { TranscriptEntry } from './run-transcript';

beforeAll(() => Logger.overrideLogger(false));

const THESIS = {
  market: MON_USDC,
  direction: 'long',
  thesis: `Breaking out. (leaked: Bearer abc.def and ${FIRST_USER_KEY})`,
  invalidation: 'Back under 3.2.',
};
const BID = { venue: 'kuru', market: MON_USDC, side: 'buy', size: '10', price: '3.5' };
const thinking = (value: string) => ({ type: 'thinking', thinking: value, signature: 'sig' });

const kinds = (entries: readonly TranscriptEntry[]) => entries.map((e) => e.kind);

async function controllerFor(h: Awaited<ReturnType<typeof runnerHarness>>) {
  let userId = h.agent.userId;
  const auth: Auth = { principal: () => ({ userId }) };
  return {
    controller: new AgentRunsController(h.agents, auth, h.transcripts),
    as: (id: string) => {
      userId = id;
    },
  };
}

async function httpError(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof HttpException))
    throw new Error(`expected HttpException: ${String(error)}`);
  return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
}

describe('run transcript, recorded by the runner', () => {
  it('records start, snapshot, thinking, text, calls, results, usage and end — in order', async () => {
    const h = await runnerHarness({
      responses: [
        assistant(
          [
            thinking('MON book is thin on the ask.'),
            text('Recording a thesis.'),
            toolUse('tu_1', 'record_thesis', THESIS),
          ],
          'tool_use',
          { costUsd: 0.001 },
        ),
        assistant(
          [
            { type: 'redacted_thinking', data: 'opaque' },
            toolUse('tu_2', 'place_limit', { ...BID, size: '100000' }),
          ],
          'tool_use',
          { costUsd: 0.002 },
        ),
        assistant([toolUse('tu_3', 'place_limit', BID)], 'tool_use'),
        assistant([toolUse('tu_4', 'place_limit', { ...BID, size: 1 })], 'tool_use'),
        assistant([text(`Done. My key is ${FIRST_USER_KEY}.`)], 'end_turn', { costUsd: 0.0005 }),
      ],
    });
    h.kuru.onWrite = () =>
      Promise.reject(
        new EnclaveRefusedError({ walletId: 'wallet-1', method: 'eth_signTransaction' }),
      );

    const result = await h.run({ instruction: 'Look at MON-USDC.' });
    const [summary] = h.transcripts.list(h.agent.id);
    expect(summary).toMatchObject({
      runId: result.runId,
      status: 'ended',
      stopReason: 'end_turn',
      trigger: 'manual',
      model: 'anthropic/claude-sonnet-5',
      iterations: 5,
      toolCalls: 4,
      inputTokens: 500,
      outputTokens: 100,
      costUsd: 0.0035,
    });

    const { entries } = h.transcripts.read(h.agent.id, result.runId)!;
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));
    expect(kinds(entries)).toEqual([
      'start',
      'note',
      'thinking',
      'text',
      'tool_call',
      'usage',
      'tool_result',
      'thinking',
      'tool_call',
      'usage',
      'tool_result',
      'tool_call',
      'usage',
      'tool_result',
      'tool_call',
      'usage',
      'tool_result',
      'text',
      'usage',
      'end',
    ]);
    const at = (seq: number) => entries[seq - 1]!;

    expect(at(1)).toMatchObject({
      kind: 'start',
      trigger: 'manual',
      instruction: 'Look at MON-USDC.',
      thinkingRequested: false,
    });
    expect(at(2)).toMatchObject({ kind: 'note' });
    expect((at(2) as { text: string }).text).toContain('kuru:MON-USDC');
    expect(at(3)).toMatchObject({
      kind: 'thinking',
      visibility: 'visible',
      source: 'thinking',
      text: 'MON book is thin on the ask.',
    });
    expect(at(5)).toMatchObject({
      kind: 'tool_call',
      toolUseId: 'tu_1',
      tool: 'record_thesis',
      market: MON_USDC,
    });
    expect(at(6)).toMatchObject({
      kind: 'usage',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
    });
    expect(at(7)).toMatchObject({ kind: 'tool_result', toolUseId: 'tu_1', status: 'ok' });
    expect(at(8)).toMatchObject({ kind: 'thinking', visibility: 'redacted' });
    expect(at(8)).not.toHaveProperty('text');
    expect(at(9)).toMatchObject({
      kind: 'tool_call',
      input: expect.stringContaining('size=100000'),
    });
    // Over the notional cap: refused by our own precheck, before any signing.
    expect(at(11)).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'tu_2',
      status: 'refused',
      layer: 'sente',
      code: 'notional_over_cap',
    });
    // Within the mandate, refused by the enclave.
    expect(at(14)).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'tu_3',
      status: 'refused',
      layer: 'enclave',
    });
    // A number where the schema wants a string: rejected before the gate.
    expect(at(17)).toMatchObject({
      kind: 'tool_result',
      tool: 'place_limit',
      status: 'refused',
      code: 'invalid_input',
    });
    expect(at(17)).not.toHaveProperty('toolUseId');
    expect(at(20)).toMatchObject({
      kind: 'end',
      stopReason: 'end_turn',
      iterations: 5,
      toolCalls: 4,
      inputTokens: 500,
      outputTokens: 100,
      costUsd: 0.0035,
      thinkingTurns: 2,
    });

    // Nothing in it carries the key, a bearer token or the like.
    const wire = JSON.stringify(entries);
    expect(wire).not.toContain(FIRST_USER_KEY);
    expect(wire).not.toContain('abc.def');
    expect(wire).toContain('[redacted]');
  });

  it('is readable while the run is still going, and the cursor returns only what is new', async () => {
    const hold = deferred();
    const h = await runnerHarness({
      responses: [
        assistant([toolUse('tu_1', 'get_balances', {})], 'tool_use'),
        async () => {
          await hold.promise;
          return assistant([text('All quiet.')], 'end_turn');
        },
      ],
    });
    const { controller } = await controllerFor(h);
    const running = h.run();
    await waitFor(() => h.api.requests.length === 2);

    const { runs } = await controller.list({ id: h.agent.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'running', iterations: 1, toolCalls: 1 });
    const runId = runs[0]!.runId;

    const first = await controller.read({ id: h.agent.id, runId }, {});
    expect(kinds(first.entries)).toEqual(['start', 'note', 'tool_call', 'usage', 'tool_result']);
    expect(first.nextSeq).toBe(5);

    const empty = await controller.read({ id: h.agent.id, runId }, { after: first.nextSeq });
    expect(empty).toMatchObject({ entries: [], nextSeq: 5 });

    hold.resolve();
    await running;
    const rest = await controller.read({ id: h.agent.id, runId }, { after: first.nextSeq });
    expect(kinds(rest.entries)).toEqual(['text', 'usage', 'end']);
    expect(rest.run).toMatchObject({ status: 'ended', stopReason: 'end_turn' });
    expect(rest.nextSeq).toBe(8);
  });

  it('ends a failed run honestly, with the redacted error', async () => {
    const h = await runnerHarness({
      responses: [apiError(400, `bad request for ${FIRST_USER_KEY}`)],
    });
    const result = await h.run();
    const { entries, run } = h.transcripts.read(h.agent.id, result.runId)!;
    expect(run).toMatchObject({ status: 'ended', stopReason: 'model_error', iterations: 0 });
    const end = entries.at(-1)!;
    expect(end).toMatchObject({ kind: 'end', stopReason: 'model_error', thinkingTurns: 0 });
    expect(JSON.stringify(entries)).not.toContain(FIRST_USER_KEY);
  });

  it('keeps the last ten runs of an agent', async () => {
    const h = await runnerHarness({
      responses: Array.from({ length: 12 }, () => assistant([text('ok')], 'end_turn')),
    });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await h.run()).runId);
    const held = h.transcripts.list(h.agent.id).map((r) => r.runId);
    expect(held).toEqual(ids.slice(2).reverse());
    expect(h.transcripts.read(h.agent.id, ids[0]!)).toBeUndefined();
  });
});

describe('GET /agents/:id/runs', () => {
  it('is owner-only: another user gets 404 agent_not_found, not an empty list', async () => {
    const h = await runnerHarness({ responses: [assistant([text('ok')], 'end_turn')] });
    const { runId } = await h.run();
    const { controller, as } = await controllerFor(h);
    as('0xsomeoneelse');
    expect(await httpError(controller.list({ id: h.agent.id }))).toMatchObject({
      status: 404,
      body: { reason: 'agent_not_found' },
    });
    expect(await httpError(controller.read({ id: h.agent.id, runId }, {}))).toMatchObject({
      status: 404,
      body: { reason: 'agent_not_found' },
    });
  });

  it('answers 404 run_not_found for a run it does not hold, or one of another agent', async () => {
    const a = await runnerHarness({ responses: [assistant([text('ok')], 'end_turn')] });
    const { controller } = await controllerFor(a);
    const missing = 'run-00000000-0000-4000-8000-000000000000';
    expect(await httpError(controller.read({ id: a.agent.id, runId: missing }, {}))).toMatchObject({
      status: 404,
      body: { reason: 'run_not_found' },
    });

    // Same store, a run filed under another agent id.
    a.transcripts.start({
      runId: 'run-11111111-1111-4111-8111-111111111111',
      agentId: 'other-agent',
      trigger: 'manual',
      model: 'm',
      startedAt: 1,
    });
    expect(
      await httpError(
        controller.read({ id: a.agent.id, runId: 'run-11111111-1111-4111-8111-111111111111' }, {}),
      ),
    ).toMatchObject({ status: 404, body: { reason: 'run_not_found' } });
  });
});
