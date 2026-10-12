/**
 * `GET /public/agents/:id` (SEN-193): what anyone may read about an agent, and
 * everything they may not.
 *
 * The allowlist case plants every private value the record and its log carry
 * and fails if any of them, or any key outside `PUBLIC_AGENT_KEYS`, reaches
 * the response.
 */
import { HttpException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { parseMandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import type { Address } from 'viem';

import { IpRateLimiter } from '../../gas/rate-limit/ip-rate-limiter';
import { InMemoryAgentEventLog } from '../events/agent-event-log';
import type { AgentPortfolioService } from '../portfolio/portfolio.service';
import { InMemoryAgentStore, type AgentRecord } from '../store/agent-store';
import {
  PUBLIC_AGENT_RATE_MAX,
  PUBLIC_AGENT_RATE_WINDOW_MS,
  PublicAgentController,
} from './public-agent.controller';
import { PUBLIC_AGENT_KEYS, scrubMessage, type PublicAgentDto } from './public-agent.dto';
import { PUBLIC_AGENT_TTL_MS, PublicAgentService } from './public-agent.service';

const USDC = KURU_TESTNET_TOKENS.USDC.address;
const MARKET = KURU_TESTNET_MARKETS[0]!.address;

const ID = '6f1c3c1e-6c1b-4d3e-9a43-2a1f0b9d7e11';
const OTHER = '0b6f0d2c-1e0a-4a8b-8f1b-6c2d3e4f5a6b';
const AGENT_ADDRESS = '0xAbC0000000000000000000000000000000000001' as Address;
/** The owner's signer (their user id) and their Privy wallet (the return address). */
const OWNER = '0x1111111111111111111111111111111111111111';
const RETURN_TO = '0x2222222222222222222222222222222222222222';
const RUN_ID = '9d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6';

/** Every private value an agent carries. None may appear in a public answer. */
const SECRETS = [
  OWNER,
  RETURN_TO,
  RUN_ID,
  'wallet-PRIVY-SECRET',
  'policy-PRIVY-SECRET',
  'mcp-hash-SECRET',
  'PRIVATE PROMPT',
  'PRIVATE STRATEGY',
  'TRANSCRIPT SECRET',
  'quorum-SECRET',
];

function mandate(expiresAt = 4_000_000_000) {
  return parseMandate({
    version: 1,
    chainId: 10143,
    expiresAt,
    venues: ['kuru'],
    kuru: { markets: [MARKET], maxDepositAtoms: { [USDC]: '1000000000' } },
    perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
    maxOrderNotional: '250',
    returnTo: RETURN_TO,
  });
}

function agent(over: Partial<AgentRecord> = {}): AgentRecord {
  const at = new Date('2026-10-01T10:00:00.000Z');
  return {
    id: ID,
    userId: OWNER,
    name: 'Night desk',
    systemPrompt: 'PRIVATE PROMPT',
    strategy: 'PRIVATE STRATEGY',
    model: 'anthropic/claude-sonnet-5',
    mandate: mandate(),
    walletId: 'wallet-PRIVY-SECRET',
    address: AGENT_ADDRESS,
    policyId: 'policy-PRIVY-SECRET',
    ownerKind: 'device',
    mcpTokenHash: 'mcp-hash-SECRET',
    status: 'active',
    policyCleared: false,
    public: false,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

const NOW = Date.parse('2026-10-12T12:00:00.000Z');

async function setup(
  options: {
    agents?: AgentRecord[];
    profileName?: string | null;
    portfolio?: () => Promise<unknown>;
  } = {},
) {
  const store = new InMemoryAgentStore();
  for (const record of options.agents ?? [agent()]) await store.insert(record);
  const events = new InMemoryAgentEventLog();
  const clock = { now: NOW };
  const portfolios = {
    portfolio:
      options.portfolio ??
      (() =>
        Promise.resolve({
          totals: { approxUsd: '512.40', byQuote: { USDC: '0', AUSD: '0' }, note: 'note' },
        })),
  } as unknown as AgentPortfolioService;
  const service = new PublicAgentService(
    store,
    events,
    { get: () => ({ name: options.profileName ?? null, avatarSeed: '7' }) },
    portfolios,
    () => clock.now,
  );
  const controller = new PublicAgentController(
    service,
    new IpRateLimiter(PUBLIC_AGENT_RATE_MAX, PUBLIC_AGENT_RATE_WINDOW_MS),
  );
  return { store, events, service, controller, clock };
}

/** Every key at every depth of a JSON value. */
function keysOf(value: unknown, path = ''): string[] {
  if (Array.isArray(value))
    return value.flatMap((item) => keysOf(item, `${path.replace(/\.$/, '')}[].`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    `${path}${key}`,
    ...keysOf(inner, `${path}${key}.`),
  ]);
}

/** The deep key set of the answer, so a new nested field fails here until it is listed. */
const ALLOWED_DEEP_KEYS = new Set([
  ...PUBLIC_AGENT_KEYS,
  'owner.name',
  'owner.avatarSeed',
  'mandate.version',
  'mandate.chainId',
  'mandate.expiresAt',
  'mandate.venues',
  'mandate.kuru',
  'mandate.kuru.markets',
  'mandate.kuru.maxDepositAtoms',
  `mandate.kuru.maxDepositAtoms.${USDC}`,
  'mandate.perpl',
  'mandate.perpl.maxCollateralAtoms',
  'mandate.perpl.maxLeverage',
  'mandate.perpl.markets',
  'mandate.maxOrderNotional',
  'mandateAnchor.mandateHash',
  'mandateAnchor.txHash',
  'mandateAnchor.chainId',
  'mandateAnchor.registry',
  'mandateAnchor.agentTokenId',
  'mandateAnchor.policyHash',
  'mandateAnchor.status',
  'mandateAnchor.anchoredAt',
  'prompt.systemPrompt',
  'prompt.strategy',
  'pnl.allTime',
  'pnl.last24h',
  'pnl.allTimePartial',
  'counts.trades',
  'counts.held',
  'counts.theses',
  'balance.approxUsd',
  'balance.note',
  ...['venue', 'symbol', 'side', 'price', 'size', 'txHash', 'at'].map((k) => `fills[].${k}`),
  ...['layer', 'code', 'message', 'at'].map((k) => `refusals[].${k}`),
]);

const TX = `0x${'ab'.repeat(32)}`;

async function seedLog(events: InMemoryAgentEventLog) {
  await events.append({
    agentId: ID,
    runId: RUN_ID,
    kind: 'run',
    detail: { transcript: 'TRANSCRIPT SECRET', trigger: 'manual' },
  });
  await events.append({
    agentId: ID,
    runId: RUN_ID,
    kind: 'fill',
    tool: 'place_order',
    detail: {
      venue: 'kuru',
      symbol: 'MON-USDC',
      side: 'buy',
      filledSize: '10',
      averageFillPrice: '0.5',
      orderId: 'order-1',
      txHash: TX,
      args: { returnTo: RETURN_TO },
    },
  });
  await events.append({
    agentId: ID,
    runId: RUN_ID,
    kind: 'refusal',
    layer: 'enclave',
    tool: 'transfer',
    detail: {
      code: 'policy_violation',
      message: `Transfer to ${RETURN_TO.toUpperCase().replace('0X', '0x')} in run ${RUN_ID} refused`,
      precheck: true,
      args: { to: OWNER, quorum: 'quorum-SECRET' },
      intent: { to: RETURN_TO },
    },
  });
  await events.append({
    agentId: ID,
    kind: 'verdict',
    detail: { realisedPnl: '12.5', pnlAsset: 'USDC', held: true },
  });
}

describe('GET /public/agents/:id', () => {
  it('is an unguarded GET /public/agents/:id', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PublicAgentController)).toBe('public/agents');
    expect(Reflect.getMetadata(PATH_METADATA, PublicAgentController.prototype.get)).toBe(':id');
    expect(Reflect.getMetadata(GUARDS_METADATA, PublicAgentController)).toBeUndefined();
  });

  it('answers only allowlisted fields, and no private value reaches it', async () => {
    const { controller, events } = await setup();
    await seedLog(events);

    const answer = await controller.get(ID, '1.2.3.4');
    const json = JSON.stringify(answer);

    expect(Object.keys(answer).sort()).toEqual([...PUBLIC_AGENT_KEYS].sort());
    const unexpected = keysOf(JSON.parse(json)).filter((key) => !ALLOWED_DEEP_KEYS.has(key));
    expect(unexpected).toEqual([]);
    for (const secret of SECRETS) {
      expect(json.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(answer.prompt).toBeNull();
    expect(answer.returnsToOwner).toBe(true);
  });

  it('shows the mandate, the record and the agent wallet', async () => {
    const { controller, events, store } = await setup({ profileName: 'Based Whale' });
    await store.insert(agent({ id: OTHER, forkedFrom: ID, mcpTokenHash: 'other-hash' }));
    await seedLog(events);

    const answer = await controller.get(ID, '1.2.3.4');

    expect(answer).toMatchObject<Partial<PublicAgentDto>>({
      id: ID,
      name: 'Night desk',
      sigilSeed: ID,
      owner: { name: 'Based Whale', avatarSeed: `owner/${ID}` },
      status: 'active',
      address: AGENT_ADDRESS,
      copies: 1,
      balance: { approxUsd: '512.40', note: 'note' },
      pnl: { allTime: '12.5', last24h: '12.5', allTimePartial: false },
      counts: { trades: 1, held: 1, theses: 0 },
      mandateAnchor: null,
    });
    expect(answer.mandate.maxOrderNotional).toBe('250');
    expect(answer.fills).toEqual([
      expect.objectContaining({ symbol: 'MON-USDC', side: 'buy', txHash: TX, venue: 'kuru' }),
    ]);
    expect(answer.refusals).toEqual([
      expect.objectContaining({
        layer: 'enclave',
        code: 'policy_violation',
        message: 'Transfer to the owner’s wallet in run … refused',
      }),
    ]);
  });

  it('shows the prompt and strategy only when the owner published them', async () => {
    const { controller } = await setup({ agents: [agent({ public: true })] });
    const answer = await controller.get(ID, '1.2.3.4');
    expect(answer.prompt).toEqual({
      systemPrompt: 'PRIVATE PROMPT',
      strategy: 'PRIVATE STRATEGY',
    });
  });

  it('says expired and revoked', async () => {
    const expired = await setup({ agents: [agent({ mandate: mandate(1_700_000_000) })] });
    expect((await expired.controller.get(ID, 'a')).status).toBe('expired');
    const revoked = await setup({
      agents: [agent({ status: 'revoked', revokedAt: new Date(NOW - 1000) })],
    });
    const answer = await revoked.controller.get(ID, 'a');
    expect(answer.status).toBe('revoked');
    expect(answer.revokedAt).toBe(new Date(NOW - 1000).toISOString());
  });

  it('carries the on-chain mandate anchor when the record has one (SEN-194)', async () => {
    const anchored = {
      ...agent(),
      mandateAnchor: {
        mandateHash: `0x${'cd'.repeat(32)}`,
        status: 'active',
        txHash: TX,
        chainId: 10143,
        registry: AGENT_ADDRESS,
        agentTokenId: '42',
        anchoredAt: new Date(NOW).toISOString(),
      },
    } as AgentRecord;
    const { controller } = await setup({ agents: [anchored] });
    expect((await controller.get(ID, 'a')).mandateAnchor).toEqual({
      mandateHash: `0x${'cd'.repeat(32)}`,
      txHash: TX,
      chainId: 10143,
      registry: AGENT_ADDRESS,
      agentTokenId: '42',
      status: 'active',
      anchoredAt: new Date(NOW).toISOString(),
    });
  });

  it('answers balance null, not an error, when the wallet cannot be read', async () => {
    const { controller } = await setup({ portfolio: () => Promise.reject(new Error('rpc down')) });
    expect((await controller.get(ID, 'a')).balance).toBeNull();
  });

  it('is a 404 for an unknown id and for a malformed one', async () => {
    const { controller } = await setup();
    for (const id of [OTHER, 'not-a-uuid', '../agents']) {
      await expect(controller.get(id, 'a')).rejects.toMatchObject({ status: 404 });
    }
  });

  it('rate-limits per client IP', async () => {
    const { controller } = await setup();
    for (let i = 0; i < PUBLIC_AGENT_RATE_MAX; i++) await controller.get(ID, '9.9.9.9');
    const refused = controller.get(ID, '9.9.9.9');
    await expect(refused).rejects.toBeInstanceOf(HttpException);
    await expect(refused).rejects.toMatchObject({ status: 429 });
    await expect(controller.get(ID, '8.8.8.8')).resolves.toMatchObject({ id: ID });
  });

  it('serves one answer for the cache window, then reads again', async () => {
    const { service, store, clock } = await setup();
    const reads = jest.spyOn(store, 'get');

    await service.get(ID);
    await service.get(ID);
    expect(reads).toHaveBeenCalledTimes(1);

    clock.now += PUBLIC_AGENT_TTL_MS;
    await service.get(ID);
    expect(reads).toHaveBeenCalledTimes(2);
  });
});

describe('scrubMessage', () => {
  it('takes out owner addresses in any case and internal ids, and cuts long messages', () => {
    const mixed = '0xAbCdEf0000000000000000000000000000000001';
    expect(scrubMessage(`to ${mixed}`, [mixed.toLowerCase()])).toBe('to the owner’s wallet');
    expect(scrubMessage(`from ${OWNER}`, [OWNER])).toBe('from the owner’s wallet');
    expect(scrubMessage(`run ${RUN_ID}`, [])).toBe('run …');
    expect(scrubMessage('x'.repeat(500), []).length).toBe(240);
  });
});
