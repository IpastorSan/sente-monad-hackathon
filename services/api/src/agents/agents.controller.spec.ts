import { BadRequestException, HttpException, ValidationPipe } from '@nestjs/common';
import { parseMandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';

import type { GasDripAuth, GasDripPrincipal } from '../gas/auth/gas-drip-auth';
import { UnconfiguredAgentWalletProvider } from './agent-wallet.provider';
import { AgentsController } from './agents.controller';
import { AGENT_REFUSAL_REASONS, agentErrorStatus } from './agents.errors';
import { AgentsService } from './agents.service';
import {
  AgentEventsQueryDto,
  AgentIdParamDto,
  AmendMandateDto,
  CreateAgentDto,
} from './dto/agent.dto';
import { InMemoryAgentEventLog } from './events/agent-event-log';
import { InMemoryAgentStore } from './store/agent-store';
import { FakeAgentWalletProvider } from './testing/fake-agent-wallet.provider';

const USDC = KURU_TESTNET_TOKENS.USDC.address;

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Momentum',
    systemPrompt: 'Trade carefully.',
    strategy: 'Buy strength.',
    model: 'anthropic/claude-sonnet-5',
    mandate: {
      version: 1,
      chainId: 10143,
      expiresAt: 2_000_000_000,
      venues: ['kuru'],
      kuru: {
        markets: [KURU_TESTNET_MARKETS[0]!.address],
        maxDepositAtoms: { [USDC]: '1000000000' },
      },
      perpl: { maxCollateralAtoms: '500000000', maxLeverage: 5, markets: [] },
      maxOrderNotional: '250',
      rollingCap: { windowSeconds: 3600, capAtoms: '2000000000', token: USDC },
    },
    ...over,
  };
}

/** The controller as a caller sees it: `as` switches the authenticated user. */
function setup(wallets = new FakeAgentWalletProvider()) {
  let principal: GasDripPrincipal = { userId: 'alice' };
  const auth: GasDripAuth = { principal: () => principal };
  const events = new InMemoryAgentEventLog();
  const controller = new AgentsController(
    new AgentsService(new InMemoryAgentStore(), wallets),
    auth,
    // The run route has its own spec (runner/run-route.spec.ts).
    {} as never,
    events,
  );
  return {
    controller,
    events,
    as(userId: string) {
      principal = { userId };
    },
  };
}

async function httpError(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof HttpException))
    throw new Error(`expected HttpException, got ${String(error)}`);
  return { status: error.getStatus(), body: error.getResponse() };
}

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

describe('AgentsController', () => {
  it('hires: the token once, the mandate as JSON that parses back to what was stored', async () => {
    const { controller } = setup();
    const hired = await controller.hire(body() as unknown as CreateAgentDto);

    expect(hired.mcpToken).toMatch(/^sente_mcp_/);
    const wire = JSON.parse(JSON.stringify(hired)) as typeof hired;
    expect(wire.agent.mandate.kuru.maxDepositAtoms[USDC]).toBe('1000000000');
    expect(wire.agent.mandate.perpl.maxCollateralAtoms).toBe('500000000');
    expect(wire.agent.mandate.rollingCap?.capAtoms).toBe('2000000000');
    expect(parseMandate(wire.agent.mandate)).toEqual(parseMandate(body()['mandate']));
    expect(wire.agent).toMatchObject({ status: 'active', chainId: 10143, policyId: 'policy-1' });
    expect(wire.agent).not.toHaveProperty('mcpTokenHash');
    expect(wire.agent).not.toHaveProperty('userId');

    const read = await controller.get({ id: hired.agent.id });
    expect(JSON.stringify(read)).not.toContain(hired.mcpToken);
    expect((await controller.list()).agents.map((a) => a.id)).toEqual([hired.agent.id]);
  });

  it("answers another user's agent with a 404", async () => {
    const { controller, as } = setup();
    const { agent } = await controller.hire(body() as unknown as CreateAgentDto);
    as('bob');

    for (const attempt of [
      controller.get({ id: agent.id }),
      controller.amendMandate(
        { id: agent.id },
        { mandate: body()['mandate'] as Record<string, unknown> },
      ),
      controller.revoke({ id: agent.id }),
    ]) {
      const { status, body: response } = await httpError(attempt);
      expect(status).toBe(404);
      expect(response).toMatchObject({ reason: 'agent_not_found' });
    }
    expect((await controller.list()).agents).toEqual([]);
  });

  it('maps refusals to their status and a stable reason', async () => {
    const { controller } = setup();
    expect(
      await httpError(controller.hire(body({ model: 'x/y' }) as unknown as CreateAgentDto)),
    ).toMatchObject({ status: 400, body: { reason: 'model_not_allowed' } });
    expect(
      await httpError(
        controller.hire(body({ mandate: { version: 2 } }) as unknown as CreateAgentDto),
      ),
    ).toMatchObject({ status: 400, body: { reason: 'mandate_invalid' } });

    const { agent } = await controller.hire(body() as unknown as CreateAgentDto);
    const revoked = await controller.revoke({ id: agent.id });
    expect(revoked).toMatchObject({ status: 'revoked', policyCleared: true });
    expect(revoked.revokedAt).toEqual(expect.any(String));
    expect(
      await httpError(
        controller.amendMandate(
          { id: agent.id },
          { mandate: body()['mandate'] as Record<string, unknown> },
        ),
      ),
    ).toMatchObject({ status: 409, body: { reason: 'agent_revoked' } });

    const unconfigured = setup(new UnconfiguredAgentWalletProvider() as never).controller;
    expect(await httpError(unconfigured.hire(body() as unknown as CreateAgentDto))).toMatchObject({
      status: 503,
      body: { reason: 'agent_wallets_unconfigured' },
    });
  });

  it('has a status for every refusal reason', () => {
    for (const reason of AGENT_REFUSAL_REASONS) {
      expect(agentErrorStatus(reason)).toBeGreaterThanOrEqual(400);
    }
  });

  describe('GET /agents/:id/events', () => {
    /** Hires as alice and records one thesis, one fill (bigint detail) and one refusal. */
    async function seeded() {
      const h = setup();
      const { agent } = await h.controller.hire(body() as unknown as CreateAgentDto);
      const at = { agentId: agent.id, runId: 'run-1' };
      await h.events.append({ ...at, kind: 'thesis', detail: { market: 'MON-USDC' } });
      await h.events.append({
        ...at,
        kind: 'fill',
        tool: 'place_market',
        detail: { orderId: '4:812', blockNumber: 74_000_012, amountAtoms: 25_000_000n },
      });
      await h.events.append({ ...at, kind: 'refusal', layer: 'sente', detail: { code: 'oops' } });
      return { ...h, agentId: agent.id };
    }

    it('returns the log oldest-first, bigints as strings, with nextSeq', async () => {
      const { controller, agentId } = await seeded();
      const page = await controller.listEvents({ id: agentId }, {});

      expect(page.events.map((e) => e.kind)).toEqual(['thesis', 'fill', 'refusal']);
      expect(page.events[1]).toMatchObject({ kind: 'fill', runId: 'run-1', tool: 'place_market' });
      expect(page.events[1]!.detail).toEqual({
        orderId: '4:812',
        blockNumber: 74_000_012,
        amountAtoms: '25000000', // a bigint on the wire is a decimal string
      });
      expect(page.events[2]!.layer).toBe('sente');
      expect(page.nextSeq).toBe(3);

      // The cursor pages forward: what comes after seq 2 is only the refusal.
      const next = await controller.listEvents({ id: agentId }, { afterSeq: 2 });
      expect(next.events.map((e) => e.seq)).toEqual([3]);
      expect(next.nextSeq).toBe(3);
      // A cursor past the end is empty, and echoes the cursor back.
      const done = await controller.listEvents({ id: agentId }, { afterSeq: 3 });
      expect(done.events).toEqual([]);
      expect(done.nextSeq).toBe(3);
    });

    it('filters by kind and clamps to the most recent N', async () => {
      const { controller, agentId } = await seeded();
      const orders = await controller.listEvents({ id: agentId }, { kind: 'fill' });
      expect(orders.events.map((e) => e.kind)).toEqual(['fill']);

      const lastTwo = await controller.listEvents({ id: agentId }, { limit: 2 });
      expect(lastTwo.events.map((e) => e.seq)).toEqual([2, 3]);
      expect(lastTwo.nextSeq).toBe(3);
    });

    it("answers another user's agent with a 404, not an empty log", async () => {
      const { controller, as, agentId } = await seeded();
      as('bob');
      expect(await httpError(controller.listEvents({ id: agentId }, {}))).toMatchObject({
        status: 404,
        body: { reason: 'agent_not_found' },
      });
    });

    it('validates the query (the global ValidationPipe, as main.ts configures it)', async () => {
      // Nest's ValidationPipe coerces the raw query strings to numbers at
      // runtime (`@Type(() => Number)` on the DTO). Specs call the controller
      // with already-typed values, as the rest of this file does.
      await expect(
        pipe.transform(
          { afterSeq: 10, kind: 'close', limit: 250 },
          { type: 'query', metatype: AgentEventsQueryDto },
        ),
      ).resolves.toEqual({ afterSeq: 10, kind: 'close', limit: 250 });

      for (const query of [
        { afterSeq: '-1' },
        { afterSeq: 'x' },
        { kind: 'nonsense' },
        { limit: '0' },
        { limit: '501' },
        { runId: 'sneaked-in' }, // not a query param the route knows
      ]) {
        await expect(
          pipe.transform(query, { type: 'query', metatype: AgentEventsQueryDto }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });
  });

  describe('validation (the global ValidationPipe, as main.ts configures it)', () => {
    const create = (value: unknown) =>
      pipe.transform(value, { type: 'body', metatype: CreateAgentDto });

    it('rejects a smuggled userId, top level', async () => {
      await expect(create(body({ userId: 'bob' }))).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        pipe.transform({ mandate: {}, userId: 'bob' }, { type: 'body', metatype: AmendMandateDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('passes the mandate through untouched, for parseMandate to judge', async () => {
      const dto = (await create(body())) as CreateAgentDto;
      expect(dto.mandate).toEqual(body()['mandate']);
    });

    it.each([
      ['an empty name', { name: '' }],
      ['a blank name', { name: '   ' }],
      ['a 65-character name', { name: 'x'.repeat(65) }],
      ['an 8,001-character system prompt', { systemPrompt: 'x'.repeat(8_001) }],
      ['a 2,001-character strategy', { strategy: 'x'.repeat(2_001) }],
      ['a missing model', { model: undefined }],
      ['a mandate that is not an object', { mandate: 'kuru please' }],
    ])('rejects %s', async (_label, over) => {
      await expect(create(body(over))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts the limits exactly', async () => {
      await expect(
        create(
          body({
            name: 'x'.repeat(64),
            systemPrompt: 'x'.repeat(8_000),
            strategy: 'x'.repeat(2_000),
          }),
        ),
      ).resolves.toBeInstanceOf(CreateAgentDto);
    });

    it('rejects an id that is not a UUID', async () => {
      await expect(
        pipe.transform({ id: '../admin' }, { type: 'param', metatype: AgentIdParamDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
