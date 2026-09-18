/**
 * SEN-27: the ERC-8004 identity a hire gets and the reputation a verdict writes.
 *
 * Everything here runs against a fake client: no RPC, no key, no chain. The
 * measured gas limits, the registry addresses and the self-feedback rule were
 * verified against the live testnet deployment (see `docs/erc8004.md` and the
 * module comment in `erc8004.ts`).
 */
import { getAddress } from 'viem';

import type { Verdict } from '../events/verdict';
import { AgentsService } from '../agents.service';
import { ServerMandateOwners } from '../mandate-owner';
import { InMemoryAgentEventLog, type NewAgentEvent } from '../events/agent-event-log';
import { InMemoryAgentStore, type AgentRecord } from '../store/agent-store';
import { FakeAgentWalletProvider } from '../testing/fake-agent-wallet.provider';
import { AgentTools } from '../tools/context';
import { GATED_TOOLS } from '../tools/gate';
import { MON_USDC, NOW, testAgent, testMandateInput } from '../tools/testing/agent-fixture';
import { fakeVenues } from '../tools/testing/fake-venues';
import {
  agentRegistryId,
  agentUriFor,
  createErc8004Client,
  ERC8004_GAS,
  ERC8004_IDENTITY_REGISTRY,
  ERC8004_MAINNET_IDENTITY,
  ERC8004_MAINNET_REPUTATION,
  ERC8004_MAX_AGENT_URI_CHARS,
  ERC8004_PNL_TAG,
  ERC8004_REPUTATION_REGISTRY,
  ERC8004_VALUE_DECIMALS,
  Erc8004Reputation,
  isSelfFeedback,
  loadErc8004Config,
  mandateSummary,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  pnlBasisPoints,
  ReputationEventLog,
  ZERO_FEEDBACK_HASH,
  type Erc8004Client,
  type Erc8004FeedbackWrite,
  type Erc8004ReputationOptions,
} from './erc8004';

/** The registration file inside a `data:` agentURI, decoded. */
function registrationJson(uri: string): Record<string, unknown> {
  const base64 = uri.replace('data:application/json;base64,', '');
  expect(base64).not.toBe(uri);
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Record<string, unknown>;
}

const REGISTRAR = `0x${'11'.repeat(32)}`;
const REVIEWER = `0x${'22'.repeat(32)}`;

/**
 * The chain, as a spec sees it: what was written, and a way to make the next
 * write fail.
 */
class FakeErc8004Client implements Erc8004Client {
  readonly registrations: string[] = [];
  readonly feedback: Erc8004FeedbackWrite[] = [];
  nextAgentId = 1874n;
  registerError: Error | undefined;
  feedbackError: Error | undefined;

  register(agentUri: string): Promise<{ agentId: bigint; txHash: `0x${string}` }> {
    if (this.registerError) return Promise.reject(this.registerError);
    this.registrations.push(agentUri);
    return Promise.resolve({ agentId: this.nextAgentId, txHash: `0x${'ab'.repeat(32)}` });
  }

  giveFeedback(
    feedback: Erc8004FeedbackWrite,
  ): Promise<{ txHash: `0x${string}`; blockNumber: bigint }> {
    if (this.feedbackError) return Promise.reject(this.feedbackError);
    this.feedback.push(feedback);
    return Promise.resolve({ txHash: `0x${'cd'.repeat(32)}`, blockNumber: 42n });
  }
}

function reputation(
  client: Erc8004Client | undefined,
  agents: { get(id: string): Promise<AgentRecord | undefined> } = {
    get: () => Promise.resolve(undefined),
  },
  over: Partial<Erc8004ReputationOptions> = {},
): Erc8004Reputation {
  return new Erc8004Reputation({
    ...(client ? { client } : {}),
    agents,
    agentBaseUrl: 'https://sente.lol',
    ...over,
  });
}

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    agentId: 'agent-1',
    market: 'MON-USDC',
    venue: 'kuru',
    direction: 'long',
    thesisSeq: 7,
    fills: 2,
    realisedPnl: '2.5',
    pnlAsset: 'USDC',
    costBasis: '100',
    held: true,
    closedAt: 1_789_000_000_000,
    ...over,
  };
}

describe('ERC-8004 addresses', () => {
  it('uses the testnet pair, which is the one with code', () => {
    expect(ERC8004_IDENTITY_REGISTRY).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e');
    expect(ERC8004_REPUTATION_REGISTRY).toBe('0x8004B663056A597Dffe9eCcC1965A193B7388713');
    expect(getAddress(ERC8004_IDENTITY_REGISTRY)).toBe(ERC8004_IDENTITY_REGISTRY);
  });

  it('keeps mainnet as constants only, and names them apart from testnet', () => {
    expect(ERC8004_MAINNET_IDENTITY).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(ERC8004_MAINNET_REPUTATION).toBe('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63');
    expect(ERC8004_MAINNET_IDENTITY).not.toBe(ERC8004_IDENTITY_REGISTRY);
  });

  it('names an agent the way the spec does', () => {
    expect(agentRegistryId()).toBe(`eip155:10143:${ERC8004_IDENTITY_REGISTRY}`);
  });

  it('pins fixed gas limits above the measured ones', () => {
    // Measured 2026-09-17: register 685,052 typical / 849,887 at the URI cap;
    // giveFeedback 278,412–295,694 across agent ids and clients.
    expect(ERC8004_GAS.register).toBeGreaterThanOrEqual(849_887n);
    expect(ERC8004_GAS.feedback).toBeGreaterThanOrEqual(295_694n);
  });
});

describe('pnlBasisPoints', () => {
  it('is signed basis points with two decimals', () => {
    expect(pnlBasisPoints('2.5', '100')).toEqual({ value: 25_000n, valueDecimals: 2 });
    expect(pnlBasisPoints('-1.25', '100')).toEqual({ value: -12_500n, valueDecimals: 2 });
    expect(pnlBasisPoints('0', '100')).toEqual({ value: 0n, valueDecimals: 2 });
    expect(ERC8004_VALUE_DECIMALS).toBe(2);
    expect(ERC8004_PNL_TAG).toBe('pnl');
  });

  it('reads money in the thesis direction, whatever the venue quoted in', () => {
    // Perpl: 12.5 AUSD lost on 100 AUSD of notional.
    expect(pnlBasisPoints('-12.5', '100')).toEqual({ value: -125_000n, valueDecimals: 2 });
  });

  it('is exact across decimals — no floating point anywhere', () => {
    // 1.5 / 3.0 = 0.5 = 5000 bps; with six-decimal atoms on both sides.
    expect(pnlBasisPoints('1.500000', '3.000000')).toEqual({ value: 500_000n, valueDecimals: 2 });
    expect(pnlBasisPoints('0.333333', '1')).toEqual({ value: 333_333n, valueDecimals: 2 });
  });

  it('rounds half away from zero, on both signs', () => {
    // 1/3 of a basis point: 33.33 in valueDecimals 2.
    expect(pnlBasisPoints('1', '3000')?.value).toBe(333n);
    expect(pnlBasisPoints('-1', '3000')?.value).toBe(-333n);
  });

  it('refuses a cost basis that is not positive: the ratio has no meaning', () => {
    expect(pnlBasisPoints('2.5', '0')).toBeUndefined();
    expect(pnlBasisPoints('2.5', '0.0')).toBeUndefined();
    expect(pnlBasisPoints('2.5', '-100')).toBeUndefined();
    expect(pnlBasisPoints('2.5', '')).toBeUndefined();
    expect(pnlBasisPoints('2.5', 'one hundred')).toBeUndefined();
    expect(pnlBasisPoints('NaN', '100')).toBeUndefined();
  });

  it('refuses a value that does not fit the registry int128', () => {
    // 1e40 realised against a cost basis of 1 is 1e46 basis points — outside int128.
    expect(pnlBasisPoints(`1${'0'.repeat(40)}`, '1')).toBeUndefined();
    // And it is the boundary, not a blanket refusal: 1e32 bps still fits.
    expect(pnlBasisPoints(`1${'0'.repeat(26)}`, '1')?.value).toBe(10n ** 32n);
  });
});

describe('the registration file', () => {
  const input = {
    id: 'agent-1',
    name: 'Momentum',
    model: 'anthropic/claude-sonnet-5',
    strategy: 'Buy strength.',
    address: getAddress(`0x${'4'.repeat(40)}`),
    mandate: testAgent().mandate,
    agentBaseUrl: 'https://sente.lol',
    mcpEndpoint: 'https://api.sente.lol/mcp',
  };

  it('carries what the plan asks for: name, model, mandate, wallet, Ledger link', () => {
    const json = registrationJson(agentUriFor(input));

    expect(json['type']).toBe('https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
    expect(json['name']).toBe('Momentum');
    expect(json['description']).toContain('anthropic/claude-sonnet-5');
    expect(json['description']).toContain('Buy strength.');
    expect(json['description']).toContain('max order 250');
    expect(json['description']).toContain(input.address);
    expect(json['description']).toContain('https://sente.lol/agents/agent-1');
    expect(json['services']).toEqual([
      { name: 'web', endpoint: 'https://sente.lol/agents/agent-1' },
      { name: 'MCP', endpoint: 'https://api.sente.lol/mcp', version: '2025-06-18' },
    ]);
    expect(json['active']).toBe(true);
    expect(json['x402Support']).toBe(false);
    expect(json['supportedTrust']).toEqual(['reputation']);
    // The agentId is assigned BY the registration call, so it cannot be in it.
    expect(json['registrations']).toEqual([]);
  });

  it('omits the image rather than inventing a URL that 404s', () => {
    expect(registrationJson(agentUriFor(input))['image']).toBeUndefined();
    expect(
      registrationJson(agentUriFor({ ...input, imageUrl: 'https://sente.lol/agent.png' }))['image'],
    ).toBe('https://sente.lol/agent.png');
  });

  it('caps the name and the description, so the gas limit stays a bound', () => {
    // The largest file this module can build: every variable field at its cap.
    const most = agentUriFor({
      ...input,
      name: 'N'.repeat(500),
      strategy: 'x'.repeat(5_000),
      imageUrl: 'https://sente.lol/agent.png',
    });
    const json = registrationJson(most);

    expect(most.length).toBeLessThanOrEqual(ERC8004_MAX_AGENT_URI_CHARS);
    expect((json['name'] as string).length).toBeLessThanOrEqual(MAX_NAME_CHARS);
    expect((json['description'] as string).length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    // And the gas limit is sized for that length, not for the typical one.
    expect(ERC8004_GAS.register).toBeGreaterThanOrEqual(849_887n);
  });

  it('summarises the mandate in words, without raw atoms', () => {
    const summary = mandateSummary(testAgent().mandate);
    expect(summary).toContain('venues kuru+perpl');
    expect(summary).toContain('BTC-PERP at up to 5x');
    expect(summary).toContain('max order 250');
  });
});

describe('Erc8004Reputation.registerOnHire', () => {
  it('mints an identity and returns the agentId to store', async () => {
    const client = new FakeErc8004Client();
    const agent = testAgent({ name: 'Momentum' });

    const outcome = await reputation(client).registerOnHire(agent);

    expect(outcome).toMatchObject({ ok: true, agentId: '1874' });
    expect(client.registrations).toHaveLength(1);
    const uri = client.registrations[0]!;
    expect(uri.startsWith('data:application/json;base64,')).toBe(true);
    const json = JSON.parse(Buffer.from(uri.split(',')[1]!, 'base64').toString('utf8')) as {
      name: string;
      services: { endpoint: string }[];
    };
    expect(json.name).toBe('Momentum');
    expect(json.services[0]!.endpoint).toBe(`https://sente.lol/agents/${agent.id}`);
  });

  it('refuses, without throwing, when no registrar key is configured', async () => {
    const outcome = await reputation(undefined).registerOnHire(testAgent());
    expect(outcome).toMatchObject({ ok: false, reason: 'not_configured' });
  });

  it('refuses, without throwing, when the registry write fails', async () => {
    const client = new FakeErc8004Client();
    client.registerError = new Error('RPC is down');
    const outcome = await reputation(client).registerOnHire(testAgent());
    expect(outcome).toMatchObject({ ok: false, reason: 'write_failed' });
    expect(outcome.ok === false && outcome.message).toContain('RPC is down');
  });
});

describe('Erc8004Reputation.recordVerdict', () => {
  const registered = (agentId: string) => (id: string) =>
    id === 'agent-1'
      ? Promise.resolve(testAgent({ id, erc8004AgentId: agentId }))
      : Promise.resolve(undefined);

  it('writes the realised PnL in basis points, tagged pnl and the venue', async () => {
    const client = new FakeErc8004Client();
    const outcome = await reputation(client, { get: registered('1874') }).recordVerdict(verdict());

    expect(outcome).toMatchObject({ ok: true, agentId: '1874', tag1: 'pnl', tag2: 'kuru' });
    expect(client.feedback).toEqual([
      {
        agentId: 1874n,
        value: 25_000n,
        valueDecimals: 2,
        tag1: 'pnl',
        tag2: 'kuru',
        endpoint: '',
        feedbackURI: '',
        feedbackHash: ZERO_FEEDBACK_HASH,
      },
    ]);
  });

  it('tags the venue, so Kuru and Perpl PnL are separable on chain', async () => {
    const client = new FakeErc8004Client();
    const rep = reputation(client, { get: registered('1874') });
    await rep.recordVerdict(verdict({ thesisSeq: 8, venue: 'perpl', realisedPnl: '-1.25' }));
    expect(client.feedback[0]).toMatchObject({ tag2: 'perpl', value: -12_500n });
  });

  it('refuses an agent with no on-chain identity', async () => {
    const client = new FakeErc8004Client();
    const outcome = await reputation(client, {
      get: () => Promise.resolve(testAgent()),
    }).recordVerdict(verdict());
    expect(outcome).toMatchObject({ ok: false, reason: 'not_registered' });
    expect(client.feedback).toHaveLength(0);
  });

  it('refuses a thesis that is still open, and one with no cost basis', async () => {
    const client = new FakeErc8004Client();
    const rep = reputation(client, { get: registered('1874') });
    expect(await rep.recordVerdict(verdict({ held: 'open' }))).toMatchObject({
      ok: false,
      reason: 'thesis_open',
    });
    expect(await rep.recordVerdict(verdict({ costBasis: '0' }))).toMatchObject({
      ok: false,
      reason: 'notional_unknown',
    });
    expect(client.feedback).toHaveLength(0);
  });

  it('publishes one thesis once, however often the verdict is replayed', async () => {
    const client = new FakeErc8004Client();
    const rep = reputation(client, { get: registered('1874') });
    expect(await rep.recordVerdict(verdict())).toMatchObject({ ok: true });
    expect(await rep.recordVerdict(verdict())).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(client.feedback).toHaveLength(1);
  });

  it('refuses self-feedback instead of spending gas on a revert', async () => {
    const client = new FakeErc8004Client();
    const outcome = await reputation(
      client,
      { get: registered('1874') },
      { selfFeedback: true },
    ).recordVerdict(verdict());
    expect(outcome).toMatchObject({ ok: false, reason: 'self_feedback_refused' });
    expect(client.feedback).toHaveLength(0);
  });

  it('never throws when the registry write fails: a landed close stays landed', async () => {
    const client = new FakeErc8004Client();
    client.feedbackError = new Error('Execution reverted: agent not registered');
    const outcome = await reputation(client, { get: registered('1874') }).recordVerdict(verdict());
    expect(outcome).toMatchObject({ ok: false, reason: 'write_failed' });
  });

  it('queues writes, and whenIdle() waits for them', async () => {
    const client = new FakeErc8004Client();
    const rep = reputation(client, { get: registered('1874') });
    void rep.recordVerdict(verdict({ thesisSeq: 1 }));
    void rep.recordVerdict(verdict({ thesisSeq: 2 }));
    await rep.whenIdle();
    expect(client.feedback.map((f) => f.value)).toEqual([25_000n, 25_000n]);
  });
});

describe('ReputationEventLog', () => {
  const openLog = () => {
    const inner = new InMemoryAgentEventLog();
    const client = new FakeErc8004Client();
    const rep = reputation(client, {
      get: (id) => Promise.resolve(testAgent({ id, erc8004AgentId: '1874' })),
    });
    return { log: new ReputationEventLog(inner, rep), client, rep, inner };
  };

  const verdictEvent = (): NewAgentEvent => ({
    agentId: 'agent-1',
    kind: 'verdict',
    tool: 'close_position',
    detail: { ...verdict() },
  });

  it('publishes a verdict appended to the log', async () => {
    const { log, client, rep } = openLog();
    await log.append(verdictEvent());
    await rep.whenIdle();
    expect(client.feedback).toHaveLength(1);
    expect(client.feedback[0]).toMatchObject({ agentId: 1874n, tag1: 'pnl', tag2: 'kuru' });
  });

  it('leaves every other kind alone', async () => {
    const { log, client, rep } = openLog();
    await log.append({ agentId: 'agent-1', kind: 'thesis', detail: { market: 'MON-USDC' } });
    await log.append({ agentId: 'agent-1', kind: 'fill', detail: { symbol: 'MON-USDC' } });
    await rep.whenIdle();
    expect(client.feedback).toHaveLength(0);
  });

  it('still stores the event when the registry is unreachable', async () => {
    const { log, client, rep, inner } = openLog();
    client.feedbackError = new Error('RPC is down');
    const stored = await log.append(verdictEvent());
    await rep.whenIdle();
    expect(stored.seq).toBe(1);
    expect(await inner.list('agent-1')).toHaveLength(1);
  });

  it('reads through to the log it wraps', async () => {
    const { log } = openLog();
    await log.append({ agentId: 'agent-1', kind: 'thesis', detail: { market: 'MON-USDC' } });
    expect(await log.list('agent-1')).toHaveLength(1);
    expect(await log.list('agent-1', { kind: 'run' })).toHaveLength(0);
  });
});

describe('a thesis settled by its fills reaches the registry (SEN-47)', () => {
  it('publishes feedback for a Kuru round trip, which never calls close_position', async () => {
    const client = new FakeErc8004Client();
    const agent = testAgent({ erc8004AgentId: '1874' });
    const rep = reputation(client, {
      get: (id) => Promise.resolve(id === agent.id ? agent : undefined),
    });
    const inner = new InMemoryAgentEventLog();
    const store = new InMemoryAgentStore();
    await store.insert(agent);
    const fakes = fakeVenues();
    const tools = new AgentTools({
      store,
      events: new ReputationEventLog(inner, rep),
      precheck: true,
      venuesFor: () => Promise.resolve(fakes.venues),
      now: () => NOW,
    });
    const ctx = tools.context(agent, { runId: 'run-1' });
    const call = (name: string, args: unknown) => {
      const tool = GATED_TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      return tool.invoke(ctx, args);
    };

    await call('record_thesis', {
      market: MON_USDC,
      direction: 'long',
      thesis: 'Breaking out.',
      invalidation: 'Back under 3.',
    });
    const order = {
      venue: 'kuru',
      market: MON_USDC,
      side: 'buy',
      size: '10',
      slippageLimitPrice: '3.5',
    };
    expect((await call('place_market', order)).ok).toBe(true);
    expect(
      (await call('place_market', { ...order, side: 'sell', slippageLimitPrice: '4' })).ok,
    ).toBe(true);
    await rep.whenIdle();

    // Spot closes through an ordinary sell, so before SEN-47 this round trip
    // produced no `verdict` event and the registry heard nothing.
    expect(await inner.list(agent.id, { kind: 'verdict' })).toHaveLength(1);
    expect(client.feedback).toHaveLength(1);
    expect(client.feedback[0]).toMatchObject({
      agentId: 1874n,
      tag1: ERC8004_PNL_TAG,
      tag2: 'kuru',
      valueDecimals: ERC8004_VALUE_DECIMALS,
      // 5 USDC made on a 35 USDC cost basis: 1,428.57 basis points.
      value: 142_857n,
    });
  });
});

describe('AgentsService.hire with ERC-8004', () => {
  const wallet = () => new FakeAgentWalletProvider();

  function hireInput() {
    return {
      name: 'Momentum',
      systemPrompt: 'Trade carefully.',
      strategy: 'Buy strength.',
      model: 'anthropic/claude-sonnet-5',
      mandate: testMandateInput(),
    };
  }

  it('stores the agentId the registry returned', async () => {
    const store = new InMemoryAgentStore();
    const client = new FakeErc8004Client();
    const service = new AgentsService(
      store,
      wallet(),
      new ServerMandateOwners(),
      undefined,
      reputation(client, { get: (id) => store.get(id) }),
    );

    const { agent } = await service.hire({ userId: 'alice' }, hireInput());

    expect(agent.erc8004AgentId).toBe('1874');
    expect(client.registrations).toHaveLength(1);
    // The registrar signs, never the agent's wallet: no policy rule was added.
    expect(await store.get(agent.id)).toMatchObject({ erc8004AgentId: '1874' });
  });

  it('hires the agent anyway when the registration fails', async () => {
    const store = new InMemoryAgentStore();
    const client = new FakeErc8004Client();
    client.registerError = new Error('insufficient funds for gas');
    const service = new AgentsService(store, wallet(), new ServerMandateOwners(), undefined, reputation(client));

    const { agent } = await service.hire({ userId: 'alice' }, hireInput());

    expect(agent.status).toBe('active');
    expect(agent.erc8004AgentId).toBeUndefined();
  });

  it('hires without an identity when ERC-8004 is not wired at all', async () => {
    const store = new InMemoryAgentStore();
    const service = new AgentsService(store, wallet(), new ServerMandateOwners());
    const { agent } = await service.hire({ userId: 'alice' }, hireInput());
    expect(agent.status).toBe('active');
    expect(agent.erc8004AgentId).toBeUndefined();
  });
});

describe('configuration', () => {
  it('is disabled, not broken, with no keys', () => {
    const config = loadErc8004Config({});
    expect(config.registrarKey).toBeUndefined();
    expect(createErc8004Client(config)).toBeUndefined();
    expect(isSelfFeedback(config)).toBe(false);
  });

  it('accepts a key with or without the 0x prefix, and never echoes a bad one', () => {
    expect(loadErc8004Config({ ERC8004_REGISTRAR_KEY: REGISTRAR }).registrarKey).toBe(REGISTRAR);
    expect(loadErc8004Config({ ERC8004_REGISTRAR_KEY: REGISTRAR.slice(2) }).registrarKey).toBe(
      REGISTRAR,
    );
    expect(() => loadErc8004Config({ ERC8004_REGISTRAR_KEY: 'not-a-key' })).toThrow(
      /ERC8004_REGISTRAR_KEY is not a 0x-prefixed 32-byte hex private key/,
    );
    try {
      loadErc8004Config({ ERC8004_REGISTRAR_KEY: 'secret-value' });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-value');
    }
  });

  it('knows the registrar cannot be its own reviewer', () => {
    expect(isSelfFeedback(loadErc8004Config({ ERC8004_REGISTRAR_KEY: REGISTRAR }))).toBe(false);
    expect(
      isSelfFeedback(
        loadErc8004Config({ ERC8004_REGISTRAR_KEY: REGISTRAR, ERC8004_REVIEWER_KEY: REGISTRAR }),
      ),
    ).toBe(true);
    expect(
      isSelfFeedback(
        loadErc8004Config({ ERC8004_REGISTRAR_KEY: REGISTRAR, ERC8004_REVIEWER_KEY: REVIEWER }),
      ),
    ).toBe(false);
  });

  it('builds a real client from the keys, exposing addresses and never key material', () => {
    const config = loadErc8004Config({
      ERC8004_REGISTRAR_KEY: REGISTRAR,
      ERC8004_REVIEWER_KEY: REVIEWER,
      ERC8004_REGISTER_GAS: '800000',
    });
    const client = createErc8004Client(config);
    expect(client).toBeDefined();
    expect(config.registerGas).toBe(800_000n);
    expect(config.feedbackGas).toBe(ERC8004_GAS.feedback);
  });

  it('rejects a gas override that is not a positive integer', () => {
    expect(() =>
      loadErc8004Config({ ERC8004_REGISTRAR_KEY: REGISTRAR, ERC8004_REGISTER_GAS: '0' }),
    ).toThrow(/ERC8004_REGISTER_GAS must be greater than zero/);
  });
});
