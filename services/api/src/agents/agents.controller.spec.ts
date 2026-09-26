import {
  BadRequestException,
  HttpException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { parseMandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';

import { Auth, type Principal } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ConsensusService, type PollTag, type TaggedBlock } from '../chain/consensus.service';
import { UnconfiguredAgentWalletProvider } from './agent-wallet.provider';
import { AgentsController } from './agents.controller';
import { AGENT_REFUSAL_REASONS, agentErrorStatus } from './agents.errors';
import { AgentsService } from './agents.service';
import { DeviceMandateOwners, ServerMandateOwners } from './mandate-owner';
import { InMemoryUserWalletRegistry } from '../wallet/store/user-wallet-registry';
import {
  AgentActivityQueryDto,
  AgentEventsQueryDto,
  AgentIdParamDto,
  AmendMandateDto,
  CreateAgentDto,
  ForkAgentDto,
  RevokeAgentDto,
} from './dto/agent.dto';
import { AGENT_EVENTS, InMemoryAgentEventLog } from './events/agent-event-log';
import { ReturnFundsService } from './recovery/return-funds.service';
import { AgentRunnerService } from './runner/agent-runner.service';
import { InMemoryAgentStore, mandateSinceOf } from './store/agent-store';
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
  let principal: Principal = { userId: 'alice' };
  const auth: Auth = { principal: () => principal };
  const events = new InMemoryAgentEventLog();
  // SEN-21. A real ConsensusService, fed through its tag reader — the socket
  // path is consensus.service.spec.ts's. `settle(n)` is what a block that has
  // been finalized looks like to the decoration.
  const byTag = new Map<PollTag, TaggedBlock>();
  const consensus = new ConsensusService({
    wsUrl: 'wss://example.invalid',
    readBlock: { getBlockByTag: (tag) => Promise.resolve(byTag.get(tag)) },
    logger: { log: () => undefined, warn: () => undefined },
    autoStart: false,
  });
  const service = new AgentsService(new InMemoryAgentStore(), wallets, new ServerMandateOwners());
  const controller = new AgentsController(
    service,
    auth,
    // The run route has its own spec (runner/run-route.spec.ts).
    {} as never,
    events,
    consensus,
    // POST /agents/:id/return has its own spec (recovery/return-funds.service.spec.ts).
    {} as never,
  );
  return {
    controller,
    service,
    events,
    consent: async (blockNumber: number) => {
      byTag.set('finalized', { number: blockNumber, id: `0x${'f'.repeat(64)}` });
      await consensus.pollOnce();
    },
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
    expect(wire.agent).toMatchObject({
      status: 'active',
      chainId: 10143,
      policyId: 'policy-1',
      public: false,
    });
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
      controller.revoke({ id: agent.id }, {}),
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
    const revoked = await controller.revoke({ id: agent.id }, {});
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

  describe('POST /agents/:id/fork (SEN-28)', () => {
    /** The forker's own mandate: narrower than the source's, on purpose. */
    const mine = () => ({
      ...(body()['mandate'] as Record<string, unknown>),
      maxOrderNotional: '25',
    });

    it("forks another user's agent into the caller's own agent, under the caller's mandate", async () => {
      const { controller, as } = setup();
      const source = await controller.hire(body() as unknown as CreateAgentDto);
      as('bob');

      const forked = await controller.fork({ id: source.agent.id }, { mandate: mine() });

      expect(forked.mcpToken).toMatch(/^sente_mcp_/);
      expect(forked.agent).toMatchObject({
        name: 'Momentum (fork)',
        strategy: source.agent.strategy,
        model: source.agent.model,
        status: 'active',
        public: false,
        forkedFrom: source.agent.id,
      });
      expect(forked.agent.id).not.toBe(source.agent.id);
      expect(forked.agent.address).not.toBe(source.agent.address);
      // A private source shares its strategy and its model, not its prompt.
      expect(forked.agent.systemPrompt).not.toBe(source.agent.systemPrompt);
      expect(source.agent.public).toBe(false);

      // The mandate that crossed is the FORKER's, and it parses back as written.
      const wire = JSON.parse(JSON.stringify(forked.agent)) as typeof forked.agent;
      expect(wire.mandate.maxOrderNotional).toBe('25');
      expect(parseMandate(wire.mandate)).toEqual(parseMandate(mine()));

      // Two agents now exist, one each, and neither is the other's.
      expect((await controller.list()).agents.map((a) => a.id)).toEqual([forked.agent.id]);
      as('alice');
      expect((await controller.list()).agents.map((a) => a.id)).toEqual([source.agent.id]);
      expect((await controller.list()).agents[0]).not.toHaveProperty('forkedFrom');
      expect((await controller.get({ id: source.agent.id })).name).toBe('Momentum');
    });

    it('copies a published prompt, honours a chosen name, and refuses a revoked source', async () => {
      const { controller, as } = setup();
      const published = await controller.hire(body({ public: true }) as unknown as CreateAgentDto);
      as('bob');
      const copy = await controller.fork(
        { id: published.agent.id },
        { mandate: mine(), name: 'My own desk' },
      );
      expect(copy.agent.name).toBe('My own desk');
      expect(copy.agent.systemPrompt).toBe(published.agent.systemPrompt);
      // A fork never republishes the prompt it copied.
      expect(copy.agent.public).toBe(false);

      as('alice');
      const revoked = await controller.hire(body() as unknown as CreateAgentDto);
      await controller.revoke({ id: revoked.agent.id }, {});
      const { status, body: refusalBody } = await httpError(
        controller.fork({ id: revoked.agent.id }, { mandate: mine() }),
      );
      expect(status).toBe(409);
      expect(refusalBody).toMatchObject({ reason: 'agent_revoked' });
    });

    it('answers an unknown source with a 404 and a bad mandate with a 400', async () => {
      const { controller } = setup();
      const source = await controller.hire(body() as unknown as CreateAgentDto);

      expect(
        await httpError(
          controller.fork({ id: '00000000-0000-4000-8000-000000000000' }, { mandate: mine() }),
        ),
      ).toMatchObject({ status: 404, body: { reason: 'agent_not_found' } });
      expect(
        await httpError(controller.fork({ id: source.agent.id }, { mandate: { version: 2 } })),
      ).toMatchObject({ status: 400, body: { reason: 'mandate_invalid' } });

      // Nothing was forked, and the source is untouched.
      expect((await controller.list()).agents.map((a) => a.name)).toEqual(['Momentum']);
    });
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

    it('decorates order, fill and close events with how far Monad has taken their block', async () => {
      const h = setup();
      const { agent } = await h.controller.hire(body() as unknown as CreateAgentDto);
      const at = { agentId: agent.id, runId: 'run-2' };
      const TRACKED = 74_000_020;
      await h.events.append({
        ...at,
        kind: 'order',
        tool: 'place_limit',
        detail: { orderId: '9:1', blockNumber: TRACKED },
      });
      await h.events.append({
        ...at,
        kind: 'fill',
        tool: 'place_limit',
        detail: { orderId: '9:1', blockNumber: TRACKED },
      });
      // An order the venue never reported a block for, a thesis, and a fill on
      // a block old enough to have fallen out of the tracking window.
      await h.events.append({
        ...at,
        kind: 'order',
        tool: 'cancel_order',
        detail: { orderId: '9:2' },
      });
      await h.events.append({ ...at, kind: 'thesis', detail: { market: 'MON-USDC' } });
      await h.events.append({
        ...at,
        kind: 'fill',
        tool: 'place_limit',
        detail: { orderId: '9:3', blockNumber: 74_000_099 },
      });
      // SEN-20 gave `close` a `blockNumber` and SEN-21 did not read it, so
      // closing a position was the one trade whose row had no ramp (SEN-35).
      await h.events.append({
        ...at,
        kind: 'close',
        tool: 'close_position',
        detail: { symbol: 'MON-USDC', realizedPnl: '12.4', blockNumber: TRACKED },
      });
      await h.consent(TRACKED);

      const page = await h.controller.listEvents({ id: agent.id }, {});
      const events = page.events;

      expect(events[0]!.consensus).toEqual({
        state: 'Finalized',
        at: { finalized: expect.any(Number) },
      });
      // The fill of the same order landed in the same block, so it reads the same.
      expect(events[1]!.consensus).toEqual(events[0]!.consensus);
      expect(events[2]).not.toHaveProperty('consensus'); // no block to ask about
      expect(events[3]).not.toHaveProperty('consensus'); // a thesis has no block
      expect(events[4]!.consensus).toEqual({ state: 'unknown', at: {} });
      // A close carries a block, so it gets the ramp too.
      expect(events[5]!.consensus).toEqual(events[0]!.consensus);

      // `detail` is the log's, byte for byte: the decoration adds a sibling.
      expect(events[0]!.detail).toEqual({ orderId: '9:1', blockNumber: TRACKED });
      expect(JSON.stringify(page)).not.toContain('undefined');
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

  /**
   * SEN-56: the redesign's per-agent cards and its home-screen feed. The
   * arithmetic is `events/summary.spec.ts`'s; this covers ownership, the wire
   * shape, and that each figure reaches the route.
   */
  describe('GET /agents/summaries and GET /agents/activity (SEN-56)', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    /** Alice hires two agents and Bob one, each with a little history. */
    async function seeded() {
      const h = setup();
      const hireAs = async (userId: string, name: string) => {
        h.as(userId);
        return (await h.controller.hire(body({ name }) as unknown as CreateAgentDto)).agent;
      };
      const alpha = await hireAs('alice', 'Alpha');
      const beta = await hireAs('alice', 'Beta');
      const mallory = await hireAs('bob', 'Mallory');
      h.as('alice');

      const on = (agentId: string) => ({ agentId, runId: 'run-1' });
      await h.events.append({ ...on(alpha.id), kind: 'thesis', detail: { market: 'MON-USDC' } });
      await h.events.append({
        ...on(alpha.id),
        kind: 'order',
        tool: 'place_market',
        detail: {
          status: 'ok',
          intent: { venue: 'kuru', kind: 'order', market: '0xabc', notional: '42.5' },
          blockNumber: 74_000_030,
        },
      });
      await h.events.append({
        ...on(alpha.id),
        kind: 'fill',
        tool: 'place_market',
        detail: { symbol: 'MON-USDC', blockNumber: 74_000_030 },
      });
      await h.events.append({
        ...on(alpha.id),
        kind: 'verdict',
        tool: 'place_market',
        detail: { realisedPnl: '4.95', pnlAsset: 'USDC', blockNumber: 74_000_030 },
      });
      await h.events.append({
        ...on(beta.id),
        kind: 'refusal',
        layer: 'enclave',
        detail: { code: 'policy_violation' },
      });
      await h.events.append({
        ...on(mallory.id),
        kind: 'fill',
        detail: { symbol: 'MON-USDC', blockNumber: 74_000_031 },
      });
      await h.events.append({ ...on(alpha.id), kind: 'run', detail: { stopReason: 'end_turn' } });
      return { ...h, alpha, beta, mallory };
    }

    it("summarises every agent the caller owns, revoked ones included, and nobody else's", async () => {
      const { controller, consent, alpha, beta } = await seeded();
      await controller.revoke({ id: beta.id }, {});
      await consent(74_000_030);

      const { summaries } = await controller.summaries();

      expect(summaries.map((s) => s.agentId)).toEqual([alpha.id, beta.id]);
      expect(summaries[0]).toEqual({
        agentId: alpha.id,
        trades: 1,
        held: 0,
        theses: 1,
        pnl: { last24h: '4.95', allTime: '4.95' },
        largestOrderNotional: '42.5',
        mandateSince: new Date(alpha.createdAt).getTime(),
        // The verdict, not the run after it — shaped like an /events item, ramp included.
        lastEvent: {
          seq: 4,
          agentId: alpha.id,
          runId: 'run-1',
          at: expect.any(Number),
          kind: 'verdict',
          tool: 'place_market',
          detail: { realisedPnl: '4.95', pnlAsset: 'USDC', blockNumber: 74_000_030 },
          consensus: { state: 'Finalized', at: { finalized: expect.any(Number) } },
        },
      });
      expect(summaries[1]).toMatchObject({
        agentId: beta.id,
        trades: 0,
        held: 1,
        pnl: { last24h: '0', allTime: '0' },
        largestOrderNotional: null,
        lastEvent: { kind: 'refusal', layer: 'enclave' },
      });
      expect(summaries[1]!.lastEvent).not.toHaveProperty('consensus');
      // The same item /events serves, byte for byte.
      const page = await controller.listEvents({ id: alpha.id }, {});
      expect(summaries[0]!.lastEvent).toEqual(page.events[3]);
    });

    it('answers a user with no agents with empty lists, not an error', async () => {
      const { controller, as } = await seeded();
      as('carol');
      expect(await controller.summaries()).toEqual({ summaries: [] });
      expect(await controller.activity({})).toEqual({ events: [] });
    });

    it('moves mandateSince on a committed amend, and on nothing else', async () => {
      jest.useFakeTimers({ now: 1_800_000_000_000, doNotFake: ['nextTick', 'setImmediate'] });
      const { controller } = setup();
      const { agent } = await controller.hire(body() as unknown as CreateAgentDto);
      const since = async () => (await controller.summaries()).summaries[0]!.mandateSince;
      expect(await since()).toBe(1_800_000_000_000);

      jest.setSystemTime(1_800_000_060_000);
      await controller.amendMandate(
        { id: agent.id },
        { mandate: body()['mandate'] as Record<string, unknown> },
      );
      expect(await since()).toBe(1_800_000_060_000);

      // A refused amend leaves the mandate — and so its start — where it was.
      jest.setSystemTime(1_800_000_120_000);
      await httpError(controller.amendMandate({ id: agent.id }, { mandate: { version: 2 } }));
      expect(await since()).toBe(1_800_000_060_000);
      // A revoke moves `updatedAt`, not the mandate.
      await controller.revoke({ id: agent.id }, {});
      expect(await since()).toBe(1_800_000_060_000);
    });

    it('falls back to createdAt for an agent stored before mandateSince existed', () => {
      const createdAt = new Date(1_700_000_000_000);
      expect(mandateSinceOf({ createdAt })).toBe(createdAt);
      const amended = new Date(1_700_000_500_000);
      expect(mandateSinceOf({ createdAt, mandateSince: amended })).toBe(amended);
    });

    it("lists the newest moves across the caller's agents, runs left out, nobody else's", async () => {
      const { controller, consent, alpha, beta } = await seeded();
      await consent(74_000_030);

      const { events } = await controller.activity({});

      expect(events.map((e) => [e.kind, e.agentId, e.agentName])).toEqual([
        ['refusal', beta.id, 'Beta'],
        ['verdict', alpha.id, 'Alpha'],
        ['fill', alpha.id, 'Alpha'],
        ['order', alpha.id, 'Alpha'],
        ['thesis', alpha.id, 'Alpha'],
      ]);
      // Each is an /events item with the agent's name beside it, consensus included.
      const page = await controller.listEvents({ id: alpha.id }, {});
      expect(events[1]).toEqual({ ...page.events[3], agentName: 'Alpha' });
      expect(events[1]!.consensus).toMatchObject({ state: 'Finalized' });
      expect(events[0]).not.toHaveProperty('consensus');

      const two = await controller.activity({ limit: 2 });
      expect(two.events.map((e) => e.kind)).toEqual(['refusal', 'verdict']);
    });

    it('defaults the activity page to 20 events', async () => {
      const { controller, events, alpha } = await seeded();
      for (let i = 0; i < 30; i += 1) {
        await events.append({ agentId: alpha.id, kind: 'thesis', detail: { market: `M-${i}` } });
      }
      expect((await controller.activity({})).events).toHaveLength(20);
    });

    it('validates the activity query like the events query', async () => {
      await expect(
        pipe.transform({ limit: '50' }, { type: 'query', metatype: AgentActivityQueryDto }),
      ).resolves.toEqual({ limit: 50 });
      for (const query of [{ limit: '0' }, { limit: '51' }, { limit: 'x' }, { kind: 'fill' }]) {
        await expect(
          pipe.transform(query, { type: 'query', metatype: AgentActivityQueryDto }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    /**
     * Route precedence can only be proved through the router: a controller
     * method called directly never goes near `:id`. So this boots the real
     * controller behind Nest's HTTP adapter, with the auth guard stubbed and
     * the global ValidationPipe as main.ts configures it — which is what would
     * answer a 400 if `:id` captured `summaries` and failed its UUID check.
     */
    describe('over HTTP', () => {
      let app: INestApplication | undefined;

      afterEach(async () => {
        await app?.close();
      });

      it('never lets :id capture summaries or activity', async () => {
        const h = await seeded();
        const moduleRef = await Test.createTestingModule({
          controllers: [AgentsController],
          providers: [
            { provide: AgentsService, useValue: h.service },
            { provide: Auth, useValue: { principal: () => ({ userId: 'alice' }) } },
            { provide: AgentRunnerService, useValue: {} },
            { provide: AGENT_EVENTS, useValue: h.events },
            { provide: ConsensusService, useValue: { stateOf: () => undefined } },
            { provide: ReturnFundsService, useValue: {} },
          ],
        })
          .overrideGuard(SessionAuthGuard)
          .useValue({ canActivate: () => true })
          .compile();
        app = moduleRef.createNestApplication({ logger: false });
        app.useGlobalPipes(pipe);
        await app.listen(0, '127.0.0.1');
        const base = await app.getUrl();
        const get = async (path: string) => {
          const response = await fetch(new URL(path, base));
          return { status: response.status, body: (await response.json()) as unknown };
        };

        const summaries = await get('/agents/summaries');
        expect(summaries.status).toBe(200);
        expect(summaries.body).toMatchObject({
          summaries: [{ agentId: h.alpha.id }, { agentId: h.beta.id }],
        });

        const activity = await get('/agents/activity?limit=1');
        expect(activity.status).toBe(200);
        expect(activity.body).toMatchObject({ events: [{ kind: 'refusal', agentName: 'Beta' }] });
        expect(await get('/agents/activity?limit=51')).toMatchObject({ status: 400 });

        // `:id` still routes, and still refuses what is not a UUID.
        expect(await get(`/agents/${h.alpha.id}`)).toMatchObject({
          status: 200,
          body: { id: h.alpha.id },
        });
        expect(await get('/agents/not-a-uuid')).toMatchObject({ status: 400 });
        expect(await get(`/agents/${h.mallory.id}`)).toMatchObject({ status: 404 });
      });
    });
  });

  /**
   * SEN-44 over HTTP: one route per verb, two body shapes, and the owner model
   * deciding which. The service spec covers what each does; this covers that
   * the route hands the right one over and refuses a body that is neither.
   */
  describe('a device-owned mandate (SEN-44)', () => {
    async function deviceSetup() {
      const registry = new InMemoryUserWalletRegistry();
      await registry.bind({
        userId: 'alice',
        walletId: 'user-wallet-alice',
        address: `0x${'b'.repeat(40)}`,
        ownerQuorumId: 'kq-device-alice',
        devicePublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-fake',
      });
      const wallets = new FakeAgentWalletProvider();
      const base = setup(wallets);
      const controller = new AgentsController(
        new AgentsService(new InMemoryAgentStore(), wallets, new DeviceMandateOwners(registry)),
        { principal: () => ({ userId: 'alice' }) },
        {} as never,
        base.events,
        {} as never,
        {} as never,
      );
      return { controller, wallets };
    }

    it('says who owns each mandate, so the app knows whether to ask for a signature', async () => {
      const server = setup();
      const device = await deviceSetup();
      expect(
        (await server.controller.hire(body() as unknown as CreateAgentDto)).agent.ownerKind,
      ).toBe('server');
      expect(
        (await device.controller.hire(body() as unknown as CreateAgentDto)).agent.ownerKind,
      ).toBe('device');
    });

    it('prepares, then commits with the signature, over the two routes', async () => {
      const { controller, wallets } = await deviceSetup();
      const { agent } = await controller.hire(body() as unknown as CreateAgentDto);

      const prepared = await controller.prepareMandate(
        { id: agent.id },
        { mandate: body({})['mandate'] as Record<string, unknown> },
      );
      expect(prepared.summary).toMatchObject({ kind: 'amend', agentId: agent.id });
      expect(prepared.payload.method).toBe('PATCH');
      expect(new Date(prepared.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const amended = await controller.amendMandate(
        { id: agent.id },
        { prepareId: prepared.prepareId, signature: wallets.acceptedSignature },
      );
      expect(amended.ownerKind).toBe('device');
      expect(wallets.policyUpdates).toHaveLength(1);

      const revokePrepare = await controller.prepareRevoke({ id: agent.id });
      const revoked = await controller.revoke(
        { id: agent.id },
        { prepareId: revokePrepare.prepareId, signature: wallets.acceptedSignature },
      );
      expect(revoked).toMatchObject({ status: 'revoked', policyCleared: true });
    });

    it('moves mandateSince when a signed amend commits (SEN-56)', async () => {
      jest.useFakeTimers({ now: 1_800_000_000_000, doNotFake: ['nextTick', 'setImmediate'] });
      try {
        const { controller, wallets } = await deviceSetup();
        const { agent } = await controller.hire(body() as unknown as CreateAgentDto);
        const since = async () => (await controller.summaries()).summaries[0]!.mandateSince;

        jest.setSystemTime(1_800_000_060_000);
        const prepared = await controller.prepareMandate(
          { id: agent.id },
          { mandate: body()['mandate'] as Record<string, unknown> },
        );
        // Preparing changes nothing: only the commit installs the mandate.
        expect(await since()).toBe(1_800_000_000_000);

        jest.setSystemTime(1_800_000_120_000);
        await controller.amendMandate(
          { id: agent.id },
          { prepareId: prepared.prepareId, signature: wallets.acceptedSignature },
        );
        expect(await since()).toBe(1_800_000_120_000);
      } finally {
        jest.useRealTimers();
      }
    });

    it('refuses the one-step routes, and a half-given approval', async () => {
      const { controller } = await deviceSetup();
      const { agent } = await controller.hire(body() as unknown as CreateAgentDto);

      expect(
        await httpError(
          controller.amendMandate(
            { id: agent.id },
            { mandate: body()['mandate'] as Record<string, unknown> },
          ),
        ),
      ).toMatchObject({ status: 409, body: { reason: 'mandate_approval_required' } });
      expect(await httpError(controller.revoke({ id: agent.id }, {}))).toMatchObject({
        status: 409,
        body: { reason: 'mandate_approval_required' },
      });

      // A prepare id with no signature is a 400, not a change made without one.
      expect(
        await httpError(controller.amendMandate({ id: agent.id }, { prepareId: agent.id })),
      ).toMatchObject({ status: 400 });
      expect(await httpError(controller.amendMandate({ id: agent.id }, {}))).toMatchObject({
        status: 400,
      });
      // Both shapes at once: one of them would have to be ignored, and the
      // signature covers the rules the server is holding, not this mandate.
      expect(
        await httpError(
          controller.amendMandate(
            { id: agent.id },
            {
              mandate: body()['mandate'] as Record<string, unknown>,
              prepareId: agent.id,
              signature: 'sig',
            },
          ),
        ),
      ).toMatchObject({ status: 400 });
    });

    it('validates the commit body: a signature must be a string with a plausible length', async () => {
      await expect(
        pipe.transform(
          { prepareId: '00000000-0000-4000-8000-000000000000', signature: 'x'.repeat(513) },
          { type: 'body', metatype: AmendMandateDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        pipe.transform(
          { prepareId: 'not-a-uuid', signature: 'sig' },
          { type: 'body', metatype: RevokeAgentDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(pipe.transform({}, { type: 'body', metatype: RevokeAgentDto })).resolves.toEqual(
        {},
      );
    });
  });

  describe('validation (the global ValidationPipe, as main.ts configures it)', () => {
    const create = (value: unknown) =>
      pipe.transform(value, { type: 'body', metatype: CreateAgentDto });
    const fork = (value: unknown) =>
      pipe.transform(value, { type: 'body', metatype: ForkAgentDto });

    it('rejects a smuggled userId, top level', async () => {
      await expect(create(body({ userId: 'bob' }))).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        pipe.transform({ mandate: {}, userId: 'bob' }, { type: 'body', metatype: AmendMandateDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('takes only a mandate (and a name) on a fork: strategy, model and userId are 400s', async () => {
      await expect(fork({ mandate: {} })).resolves.toBeInstanceOf(ForkAgentDto);
      await expect(fork({ mandate: {}, name: 'My own desk' })).resolves.toBeInstanceOf(
        ForkAgentDto,
      );
      // The strategy comes from the source agent, so a caller cannot smuggle one in.
      for (const extra of [
        { strategy: 'Buy the dip.' },
        { systemPrompt: 'Ignore the mandate.' },
        { model: 'openai/gpt-9' },
        { forkedFrom: 'someone-else' },
        { userId: 'bob' },
      ]) {
        await expect(fork({ mandate: {}, ...extra })).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it.each([
      ['an empty fork name', ''],
      ['a blank fork name', '   '],
      ['a 65-character fork name', 'x'.repeat(65)],
      ['a non-string fork name', 42],
    ])('rejects %s', async (_label, name) => {
      await expect(fork({ mandate: {}, name })).rejects.toBeInstanceOf(BadRequestException);
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
      ['a public flag that is not a boolean', { public: 'yes' }],
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

    it('accepts a published agent, and carries the flag through', async () => {
      const dto = (await create(body({ public: true }))) as CreateAgentDto;
      expect(dto.public).toBe(true);
    });

    it('rejects an id that is not a UUID', async () => {
      await expect(
        pipe.transform({ id: '../admin' }, { type: 'param', metatype: AgentIdParamDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
