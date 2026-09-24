import { BadRequestException, HttpException, Logger, ValidationPipe } from '@nestjs/common';

import type { Auth } from '../../auth/principal';
import { AgentsController } from '../agents.controller';
import { RunAgentDto } from '../dto/agent.dto';
import { apiError, assistant, text } from './testing/fake-messages';
import { deferred, runnerHarness, waitFor } from './testing/runner-harness';

beforeAll(() => Logger.overrideLogger(false));

async function routeHarness(options: Parameters<typeof runnerHarness>[0] = {}) {
  const h = await runnerHarness(options);
  let userId = h.agent.userId;
  const auth: Auth = { principal: () => ({ userId }) };
  // The run route never reads consensus (SEN-21); the events route does, and
  // has its own spec.
  const controller = new AgentsController(
    h.agents,
    auth,
    h.runner,
    h.events,
    {} as never,
    {} as never,
  );
  return {
    ...h,
    controller,
    post: (body: RunAgentDto = {}) => controller.run({ id: h.agent.id }, body),
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
    throw new Error(`expected HttpException, got ${String(error)}`);
  return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
}

describe('POST /agents/:id/run', () => {
  it('answers 200 with the run', async () => {
    const r = await routeHarness({ responses: [assistant([text('Nothing to do.')], 'end_turn')] });
    const result = await r.post({ instruction: 'Check the book.' });
    expect(result).toMatchObject({ stopReason: 'end_turn', finalText: 'Nothing to do.' });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run' });
  });

  it('answers 200 for a quiet model stop too: the stop reason says which', async () => {
    const r = await routeHarness({ responses: [assistant([text('no')], 'refusal')] });
    expect((await r.post()).stopReason).toBe('refusal');
  });

  it('answers 402 credits_exhausted with the run attached', async () => {
    const r = await routeHarness({ responses: [apiError(402, 'Insufficient credits')] });
    const { status, body } = await httpError(r.post());
    expect(status).toBe(402);
    expect(body).toMatchObject({
      statusCode: 402,
      reason: 'credits_exhausted',
      run: { stopReason: 'credits_exhausted' },
    });
  });

  it('answers 502 model_error with the run attached', async () => {
    const r = await routeHarness({ responses: [apiError(400, 'bad tools')] });
    const { status, body } = await httpError(r.post());
    expect(status).toBe(502);
    expect(body).toMatchObject({ reason: 'model_error', run: { stopReason: 'model_error' } });
  });

  it('answers 409 run_in_progress to a second concurrent run', async () => {
    const hold = deferred();
    const r = await routeHarness({
      responses: [
        async () => {
          await hold.promise;
          return assistant([text('done')], 'end_turn');
        },
      ],
    });
    const first = r.post();
    await waitFor(() => r.api.requests.length === 1);
    expect(await httpError(r.post())).toMatchObject({
      status: 409,
      body: { reason: 'run_in_progress' },
    });
    hold.resolve();
    await first;
  });

  it('answers 409 agent_revoked, 404 for another user, 503 without credits', async () => {
    const revoked = await routeHarness();
    await revoked.store.update(revoked.agent.id, { status: 'revoked' });
    expect(await httpError(revoked.post())).toMatchObject({
      status: 409,
      body: { reason: 'agent_revoked' },
    });

    const other = await routeHarness();
    other.as('bob');
    expect(await httpError(other.post())).toMatchObject({
      status: 404,
      body: { reason: 'agent_not_found' },
    });

    const unconfigured = await routeHarness({ creditsConfigured: false });
    expect(await httpError(unconfigured.post())).toMatchObject({
      status: 503,
      body: { reason: 'credits_unconfigured' },
    });
  });

  describe('validation', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const body = (value: unknown) => pipe.transform(value, { type: 'body', metatype: RunAgentDto });

    it('accepts no body and an instruction up to 2,000 characters', async () => {
      await expect(body({})).resolves.toBeInstanceOf(RunAgentDto);
      await expect(body({ instruction: 'x'.repeat(2_000) })).resolves.toBeInstanceOf(RunAgentDto);
    });

    it.each([
      ['a 2,001-character instruction', { instruction: 'x'.repeat(2_001) }],
      ['a non-string instruction', { instruction: 42 }],
      ['a smuggled userId', { userId: 'bob' }],
      ['a smuggled model', { model: 'openai/gpt-5' }],
    ])('rejects %s', async (_label, value) => {
      await expect(body(value)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
