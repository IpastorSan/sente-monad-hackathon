/**
 * The refusal demo (SEN-9), acts 1–5, in CI: the same `runRefusalDemo` the
 * live script runs, over the real AgentsService, PrivyAgentWalletProvider,
 * PrivyClient, AgentTransactionSender, AgentVenues/KuruVenue, gate and
 * AgentTools — with a fake Privy that APPLIES the compiled rules and checks
 * authorization signatures, and a fake chain. No network: global fetch is
 * stubbed to throw.
 */
import {
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
} from '@sente/venues/kuru';
import {
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  type Address,
  type PublicClient,
} from 'viem';

import { createOpenRouterKeys, CreditsService } from '../../credits/credits.service';
import { InMemoryCreditKeyStore } from '../../credits/store/credit-key-store';
import { FAKE_MANAGEMENT_KEY, fakeOpenRouter } from '../../credits/testing/fake-openrouter';
import { AgentsService } from '../agents.service';
import { ServerMandateOwners } from '../mandate-owner';
import { InMemoryAgentEventLog } from '../events/agent-event-log';
import { privyTransaction } from '../privy/agent-wallet';
import { generateAuthorizationKey } from '../privy/authorization-key';
import { PrivyAgentWalletProvider } from '../privy/privy-agent-wallet.provider';
import { PrivyClient } from '../privy/privy.client';
import { FAKE_APP_ID, FAKE_APP_SECRET } from '../privy/testing/fake-privy';
import { AgentRunnerService } from '../runner/agent-runner.service';
import { createOpenRouterClient } from '../runner/openrouter-client';
import { AGENT_RUNNER_DEFAULTS, type AgentRunnerConfig } from '../runner/runner.config';
import {
  assistant,
  fakeMessagesApi,
  text,
  toolUse,
  type Responder,
} from '../runner/testing/fake-messages';
import { WriteSpacer } from '../runner/write-spacing';
import { InMemoryAgentStore, type AgentRecord } from '../store/agent-store';
import { AgentTools } from '../tools/context';
import { ENCLAVE_REFUSAL_MESSAGE } from '../tools/refusals';
import { InMemoryAgentSecretStore } from '../venues/agent-secret-store';
import { AgentTransactionSender } from '../venues/agent-transactions';
import { AgentVenues } from '../venues/agent-venues';
import {
  agentKeyPatcher,
  approveProbe,
  DEMO_MARKET,
  DEMO_OFF_MARKET,
  demoMandateInput,
  demoRules,
  MODEL_LABEL,
  modelDriver,
  PrivyCallCounter,
  runRefusalDemo,
  SCRIPTED_LABEL,
  scriptedDriver,
  type DemoDriver,
  type DemoPlan,
} from './refusal-demo';
import { allows, fakeChain, fakeEnclave } from './testing/fake-enclave';

const USDC = KURU_TESTNET_TOKENS.USDC;
const PRINCIPAL = { userId: 'demo-owner' };

/** Chain reads KuruVenue makes on the paths the demo takes: market params, account, balances. */
function stubPublicClient(): PublicClient {
  const readContract = ({
    address,
    functionName,
    args,
  }: {
    address: Address;
    functionName: string;
    args?: readonly unknown[];
  }) => {
    if (functionName === 'getMarketParams') {
      const market = KURU_TESTNET_MARKETS.find((m) => isAddressEqual(m.address, address));
      if (!market) throw new Error(`no market ${address}`);
      return Promise.resolve([
        market.pricePrecision,
        market.sizePrecision,
        1n,
        0n,
        10n ** 30n,
        0n,
        0n,
      ]);
    }
    if (functionName === 'userRegistry') return Promise.resolve(0n);
    if (functionName === 'getBalance') {
      return Promise.resolve(isAddressEqual(args?.[1] as Address, USDC.address) ? 12_000_000n : 0n);
    }
    if (functionName === 'getSpotReservedBalance') return Promise.resolve(0n);
    return Promise.reject(new Error(`stub public client: no ${functionName}`));
  };
  return { readContract } as unknown as PublicClient;
}

const plan = (): DemoPlan => ({
  capUsdc: '1',
  overCapUsdc: '2',
  raisedCapUsdc: '2',
  offAllowlistOrder: { size: '0.002', price: '1000.00' },
  expiresAt: Math.floor(Date.now() / 1000) + 86_400,
});

async function world() {
  const agentKey = generateAuthorizationKey();
  const ownerKey = generateAuthorizationKey();
  const enclave = fakeEnclave({ appId: FAKE_APP_ID, agentKey, ownerKey });
  const client = new PrivyClient({
    appId: FAKE_APP_ID,
    appSecret: FAKE_APP_SECRET,
    fetch: enclave.fetch,
  });
  const provider = new PrivyAgentWalletProvider({
    client,
    agentKey,
    mandateOwnerKey: ownerKey,
    agentQuorumId: enclave.agentQuorumId,
    mandateQuorumId: enclave.mandateQuorumId,
  });
  const counter = PrivyCallCounter.wrap(provider);
  const chain = fakeChain();
  const sender = new AgentTransactionSender({ wallets: provider, chain: chain.client });
  const venues = new AgentVenues({
    publicClient: stubPublicClient(),
    sender,
    secrets: new InMemoryAgentSecretStore(),
  });
  const store = new InMemoryAgentStore();
  const events = new InMemoryAgentEventLog();
  const agents = new AgentsService(store, provider, new ServerMandateOwners());
  const venuesFor = (a: AgentRecord) =>
    venues.forAgent({ agentId: a.id, walletId: a.walletId, address: a.address });
  const tools = {
    off: new AgentTools({ store, events, precheck: false, venuesFor }),
    on: new AgentTools({ store, events, precheck: true, venuesFor }),
  };
  const demo = plan();

  // Act 1, as production does it: a real hire, which provisions a wallet
  // whose policy is the compiled demo mandate.
  const { agent } = await agents.hire(PRINCIPAL, {
    name: 'Refusal demo',
    systemPrompt: 'Trade only what the mandate allows.',
    strategy: 'Follow the run instruction.',
    model: 'anthropic/claude-sonnet-5',
    mandate: demoMandateInput(demo, demo.capUsdc),
  });

  const lines: string[] = [];
  const deps = (driver: DemoDriver) => ({
    driver,
    agents,
    events,
    principal: PRINCIPAL,
    counter,
    probe: approveProbe({
      wallets: provider,
      walletId: agent.walletId,
      counter,
      pendingNonce: () => chain.client.pendingNonce(agent.address),
      fees: () => chain.client.fees(),
    }),
    nonce: () => Promise.resolve(chain.nonceOf(agent.address)),
    patchWithAgentKey: agentKeyPatcher(client, agentKey),
    plan: demo,
    log: (line: string) => lines.push(line),
    act1Notes: ['hired through AgentsService.hire (fake Privy)'],
    settle: { pollMs: 0, timeoutMs: 1_000 },
    sleep: () => Promise.resolve(),
  });
  return {
    enclave,
    provider,
    counter,
    chain,
    store,
    events,
    agents,
    tools,
    agent,
    demo,
    lines,
    deps,
  };
}

describe('the refusal demo, acts 1–5 (fake Privy that applies the compiled rules)', () => {
  beforeEach(() => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('no network in this spec')));
  });
  afterEach(() => jest.restoreAllMocks());

  it('SCRIPTED: the enclave refuses, Sente refuses first, the owner amends, revoke stops it', async () => {
    const w = await world();
    const report = await runRefusalDemo(
      w.deps(scriptedDriver({ tools: w.tools, plan: w.demo })),
      w.agent,
    );

    const failed = report.checks.filter((c) => !c.pass);
    expect(failed).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.completed).toBe(true);
    expect(report.checks.map((c) => c.act)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5]));

    // Act 2: two refusals from the enclave, none from us, nothing sent before act 4.
    const refusals = await w.events.list(w.agent.id, { kind: 'refusal' });
    const byLayer = (layer: string) => refusals.filter((e) => e.layer === layer).map((e) => e.tool);
    expect(byLayer('enclave')).toEqual(['deposit', 'place_limit']);
    // Act 3's two; then act 5, where a revoked agent cannot even record a thesis.
    expect(byLayer('sente')).toEqual(['deposit', 'place_limit', 'record_thesis', 'deposit']);

    // Act 4: exactly the approve and the deposit reached the chain, and their
    // hashes are the ones the counter derived from the signed transactions.
    expect(w.chain.sent.map((t) => t.to?.toLowerCase())).toEqual([
      USDC.address.toLowerCase(),
      expect.any(String),
    ]);
    expect(report.landed.map((l) => l.hash)).toEqual(w.chain.sent.map((t) => t.hash));

    // After revoke the policy is empty: the enclave signs nothing.
    expect(w.enclave.policies.get(w.agent.policyId)?.rules).toEqual([]);

    // The output says, on every act, that no model is involved.
    const headings = w.lines.filter((l) => l.startsWith('=== ACT'));
    expect(headings).toHaveLength(5);
    for (const heading of headings) {
      expect(w.lines[w.lines.indexOf(heading) + 1]).toBe(`[${SCRIPTED_LABEL}]`);
    }
  });

  it('with the pre-check on, not one request reaches Privy', async () => {
    const w = await world();
    const driver = scriptedDriver({ tools: w.tools, plan: w.demo });
    const before = w.enclave.requests.length;
    const turn = await driver.overMandate(w.agent, true);
    expect(w.enclave.requests.length).toBe(before);
    expect(turn.calls.filter((c) => c.tool !== 'record_thesis').map((c) => c.outcome)).toEqual([
      expect.objectContaining({ ok: false, refusal: { layer: 'sente', code: 'deposit_over_cap' } }),
      expect.objectContaining({
        ok: false,
        refusal: { layer: 'sente', code: 'market_not_allowed' },
      }),
    ]);
  });

  it('MODEL: a model told to exceed its mandate gets the refusals as tool errors', async () => {
    const w = await world();
    const { size, price } = w.demo.offAllowlistOrder;
    const thesis = (id: string, market: string) =>
      assistant(
        [
          toolUse(id, 'record_thesis', {
            market,
            direction: 'long',
            thesis: 'Asked to.',
            invalidation: 'Refusal.',
          }),
        ],
        'tool_use',
      );
    const overMandate = (tag: string): Responder[] => [
      thesis(`${tag}-1`, DEMO_MARKET),
      assistant(
        [toolUse(`${tag}-2`, 'deposit', { market: DEMO_MARKET, asset: 'USDC', amount: '2' })],
        'tool_use',
      ),
      thesis(`${tag}-3`, DEMO_OFF_MARKET),
      assistant(
        [
          toolUse(`${tag}-4`, 'place_limit', {
            venue: 'kuru',
            market: DEMO_OFF_MARKET,
            side: 'buy',
            size,
            price,
          }),
        ],
        'tool_use',
      ),
      assistant([text('Both were refused; I cannot do this within my mandate.')], 'end_turn'),
    ];
    const api = fakeMessagesApi([
      ...overMandate('a2'),
      ...overMandate('a3'),
      thesis('a4-1', DEMO_MARKET),
      assistant(
        [toolUse('a4-2', 'deposit', { market: DEMO_MARKET, asset: 'USDC', amount: '2' })],
        'tool_use',
      ),
      assistant([text('Deposited 2 USDC.')], 'end_turn'),
    ]);

    const openrouter = fakeOpenRouter();
    const creditsConfig = {
      managementKey: FAKE_MANAGEMENT_KEY,
      sharedKey: undefined,
      mode: 'per-user' as const,
      defaultLimitUsd: 5,
    };
    const credits = new CreditsService(
      creditsConfig,
      createOpenRouterKeys(creditsConfig, openrouter.fetch),
      new InMemoryCreditKeyStore(),
    );
    const config: AgentRunnerConfig = {
      ...AGENT_RUNNER_DEFAULTS,
      tickSeconds: undefined,
      thinking: false,
      writeSpacingMs: 0,
    };
    const runner = (tools: AgentTools) =>
      new AgentRunnerService(
        w.agents,
        w.store,
        tools,
        w.events,
        credits,
        config,
        (key, { timeoutMs }) => createOpenRouterClient(key, { timeoutMs, fetch: api.fetch }),
        new WriteSpacer({ spacingMs: 0 }),
      );
    const driver = modelDriver({
      runners: { off: runner(w.tools.off), on: runner(w.tools.on) },
      principal: PRINCIPAL,
      plan: w.demo,
    });

    const report = await runRefusalDemo(w.deps(driver), w.agent);
    expect(report.checks.filter((c) => !c.pass)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(w.lines).toContain(`[${MODEL_LABEL}]`);
    expect(w.lines.some((l) => l.includes('the runner will not start a revoked agent'))).toBe(true);

    // The model itself saw both enclave refusals, as is_error tool results.
    const toolErrors = api.requests
      .flatMap((r) => (r.body['messages'] ?? []) as { content: unknown }[])
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []))
      .filter((b) => b['type'] === 'tool_result' && b['is_error'] === true)
      .map((b) => JSON.stringify(b['content']));
    expect(
      toolErrors.filter((c) => c.includes(ENCLAVE_REFUSAL_MESSAGE)).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('the fake enclave applies the rules it is given', () => {
  const demo = plan();
  const rules = demoRules(demo, '1');
  const approve = (amount: bigint) =>
    encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: ['0x0000000000000000000000000000000000000001', amount],
    });
  const tx = (over: Partial<Parameters<typeof privyTransaction>[0]> = {}) =>
    privyTransaction({
      to: USDC.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: ['0x0000000000000000000000000000000000000002', 1_000_000n],
      }),
      chainId: 10143,
      nonce: 0,
      gas: 80_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      ...over,
    });
  const now = Math.floor(Date.now() / 1000);

  it('refuses an approve to a spender other than AccountCore', () => {
    expect(allows(rules, tx(), now)).toBe(false);
    expect(allows(rules, tx({ data: approve(1n) }), now)).toBe(false);
  });

  it('checks the chain id, the amount and the expiry of the real approve rule', async () => {
    const w = await world();
    const probe = approveProbe({
      wallets: w.provider,
      walletId: w.agent.walletId,
      counter: w.counter,
      pendingNonce: () => Promise.resolve(0),
      fees: () => Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    });
    await expect(probe('1')).resolves.toBe('signed');
    await expect(probe('1.000001')).resolves.toBe('refused');

    const [signed] = w.counter.calls.filter((c) => c.outcome === 'signed');
    expect(signed?.tag).toBe('probe');

    const policy = w.enclave.policies.get(w.agent.policyId)!;
    const accountCoreApprove = tx({
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [KURU_TESTNET_CONTRACTS.accountCore, 1_000_000n],
      }),
    });
    expect(allows(policy.rules, accountCoreApprove, now)).toBe(true);
    expect(allows(policy.rules, { ...accountCoreApprove, chain_id: 1 }, now)).toBe(false);
    // The hire's own expiry, by the enclave's clock.
    expect(allows(policy.rules, accountCoreApprove, w.demo.expiresAt + 1)).toBe(false);
  });

  it('answers 401 to a policy PATCH approved by the agent key', async () => {
    const w = await world();
    const agentKeyOnly = agentKeyPatcher(
      new PrivyClient({ appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET, fetch: w.enclave.fetch }),
      generateAuthorizationKey(),
    );
    expect((await agentKeyOnly(w.agent.policyId, [])).status).toBe(401);
    expect(w.enclave.policies.get(w.agent.policyId)?.rules.length).toBeGreaterThan(0);
  });
});
