import { compileMandate, parseMandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';

import { UnconfiguredAgentWalletProvider } from './agent-wallet.provider';
import { AgentRefusedError, AgentWalletsUnconfiguredError } from './agents.errors';
import { AgentsService, type HireAgentInput } from './agents.service';
import { InMemoryAgentStore, type AgentRecord } from './store/agent-store';
import { hashMcpToken } from './store/mcp-token';
import { FakeAgentWalletProvider } from './testing/fake-agent-wallet.provider';

const ALICE = { userId: 'alice' };
const BOB = { userId: 'bob' };

const MARKET_A = KURU_TESTNET_MARKETS[0]!.address;
const MARKET_B = KURU_TESTNET_MARKETS[1]!.address;
const USDC = KURU_TESTNET_TOKENS.USDC.address;

/** A mandate as it arrives over JSON: atoms as decimal strings, an address lowercase. */
function mandateInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    chainId: 10143,
    expiresAt: 2_000_000_000,
    venues: ['kuru', 'perpl'],
    kuru: { markets: [MARKET_A.toLowerCase()], maxDepositAtoms: { [USDC]: '1000000000' } },
    perpl: { maxCollateralAtoms: '500000000', maxLeverage: 5, markets: ['BTC-PERP'] },
    maxOrderNotional: '250',
    ...over,
  };
}

function hireInput(over: Partial<HireAgentInput> = {}): HireAgentInput {
  return {
    name: 'Momentum',
    systemPrompt: 'Trade carefully.',
    strategy: 'Buy strength.',
    model: 'anthropic/claude-sonnet-5',
    mandate: mandateInput(),
    ...over,
  };
}

function setup() {
  const store = new InMemoryAgentStore();
  const wallets = new FakeAgentWalletProvider();
  const service = new AgentsService(store, wallets);
  return { store, wallets, service };
}

async function refusal(promise: Promise<unknown>): Promise<AgentRefusedError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AgentRefusedError)) {
    throw new Error(`expected an AgentRefusedError, got ${String(error)}`);
  }
  return error;
}

/** Every record the store holds, serialised — what a database would persist. */
async function persisted(store: InMemoryAgentStore, ...users: string[]): Promise<string> {
  const records: AgentRecord[] = [];
  for (const user of users) records.push(...(await store.listByUser(user)));
  return JSON.stringify(records, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

describe('AgentsService', () => {
  describe('hire', () => {
    it('provisions with exactly the compiled rules and stores the agent', async () => {
      const { service, wallets, store } = setup();
      const { agent } = await service.hire(ALICE, hireInput());

      const expected = compileMandate(parseMandate(mandateInput()));
      expect(wallets.provisioned).toHaveLength(1);
      expect(wallets.provisioned[0]!.rules).toEqual(expected);
      expect(wallets.provisioned[0]!.displayName).toBe(`sente-agent-${agent.id}`);

      expect(agent).toMatchObject({
        userId: 'alice',
        name: 'Momentum',
        model: 'anthropic/claude-sonnet-5',
        walletId: 'wallet-1',
        policyId: 'policy-1',
        status: 'active',
        policyCleared: false,
      });
      // Stored parsed: bigint atoms and checksummed addresses.
      expect(agent.mandate.kuru.markets).toEqual([MARKET_A]);
      expect(agent.mandate.perpl.maxCollateralAtoms).toBe(500_000_000n);
      expect(await store.get(agent.id)).toEqual(agent);
    });

    it('refuses an invalid mandate before any Privy call', async () => {
      const { service, wallets, store } = setup();
      const cases = [
        // A JS number for atoms: precision loss is refused, not coerced.
        mandateInput({ perpl: { maxCollateralAtoms: 5e8, maxLeverage: 5, markets: [] } }),
        mandateInput({ kuru: { markets: [USDC], maxDepositAtoms: {} } }), // not a market
        mandateInput({ maxOrderNotional: 250 }),
        mandateInput({ userId: 'bob' }), // unknown field
        mandateInput({ expiresAt: 1_000_000_000 }), // 2001: already expired
        'not an object',
      ];
      for (const mandate of cases) {
        const error = await refusal(service.hire(ALICE, hireInput({ mandate })));
        expect(error.reason).toBe('mandate_invalid');
        expect(error.message).toMatch(/^invalid mandate: /);
      }
      expect(wallets.provisioned).toHaveLength(0);
      expect(await store.listByUser('alice')).toEqual([]);
    });

    it('refuses a model that is not on the allowlist, before any Privy call', async () => {
      const { service, wallets } = setup();
      const error = await refusal(service.hire(ALICE, hireInput({ model: 'openai/gpt-9' })));
      expect(error.reason).toBe('model_not_allowed');
      expect(error.message).toContain('anthropic/claude-sonnet-5');
      expect(wallets.provisioned).toHaveLength(0);
    });

    it('stores nothing when the provider fails', async () => {
      const { service, wallets, store } = setup();
      wallets.provisionError = new Error('privy 500');
      const error = await refusal(service.hire(ALICE, hireInput()));
      expect(error.reason).toBe('wallet_provision_failed');
      expect(error.message).not.toContain('privy 500');
      expect(await store.listByUser('alice')).toEqual([]);
    });

    it('lets "not configured" through with its own reason', async () => {
      const store = new InMemoryAgentStore();
      const service = new AgentsService(store, new UnconfiguredAgentWalletProvider());
      await expect(service.hire(ALICE, hireInput())).rejects.toBeInstanceOf(
        AgentWalletsUnconfiguredError,
      );
    });
  });

  describe('the MCP token', () => {
    it('is returned once and never stored in plaintext', async () => {
      const { service, store } = setup();
      const { agent, mcpToken } = await service.hire(ALICE, hireInput());

      expect(mcpToken).toMatch(/^sente_mcp_[A-Za-z0-9_-]{43}$/);
      expect(agent.mcpTokenHash).toBe(hashMcpToken(mcpToken));
      expect(agent.mcpTokenHash).not.toContain(mcpToken);
      expect(await persisted(store, 'alice')).not.toContain(mcpToken);

      // Nothing after hire hands it out again.
      const reads = [await service.get(ALICE, agent.id), ...(await service.list(ALICE))];
      expect(
        JSON.stringify(reads, (_k, v: unknown) => (typeof v === 'bigint' ? '' : v)),
      ).not.toContain(mcpToken);
    });

    it('is unique per agent', async () => {
      const { service } = setup();
      const first = await service.hire(ALICE, hireInput());
      const second = await service.hire(ALICE, hireInput());
      expect(first.mcpToken).not.toBe(second.mcpToken);
    });

    it('finds its active agent by hash, and nothing for a wrong token or a revoked agent', async () => {
      const { service } = setup();
      const { agent, mcpToken } = await service.hire(ALICE, hireInput());

      expect((await service.findByMcpToken(mcpToken))?.id).toBe(agent.id);
      expect(await service.findByMcpToken(`${mcpToken}x`)).toBeUndefined();
      expect(await service.findByMcpToken('')).toBeUndefined();

      await service.revoke(ALICE, agent.id);
      expect(await service.findByMcpToken(mcpToken)).toBeUndefined();
    });
  });

  describe('ownership', () => {
    it("answers another user's agent with 404-shaped agent_not_found, and touches nothing", async () => {
      const { service, wallets } = setup();
      const { agent } = await service.hire(ALICE, hireInput());

      for (const attempt of [
        service.get(BOB, agent.id),
        service.amendMandate(BOB, agent.id, mandateInput()),
        service.revoke(BOB, agent.id),
      ]) {
        const error = await refusal(attempt);
        expect(error.reason).toBe('agent_not_found');
      }
      // Indistinguishable from an id that does not exist.
      const missing = await refusal(service.get(BOB, '00000000-0000-4000-8000-000000000000'));
      expect(missing.reason).toBe('agent_not_found');

      expect(wallets.policyUpdates).toHaveLength(0);
      expect((await service.get(ALICE, agent.id)).status).toBe('active');
    });

    it('lists only the caller’s agents, oldest first', async () => {
      const { service } = setup();
      const first = await service.hire(ALICE, hireInput({ name: 'one' }));
      await service.hire(BOB, hireInput({ name: 'bob' }));
      const second = await service.hire(ALICE, hireInput({ name: 'two' }));

      expect((await service.list(ALICE)).map((a) => a.id)).toEqual([
        first.agent.id,
        second.agent.id,
      ]);
      expect((await service.list(BOB)).map((a) => a.name)).toEqual(['bob']);
    });
  });

  describe('amendMandate', () => {
    it('calls updatePolicy with the recompiled rules and records the new mandate', async () => {
      const { service, wallets } = setup();
      const { agent } = await service.hire(ALICE, hireInput());

      const next = mandateInput({
        venues: ['kuru'],
        kuru: { markets: [MARKET_A, MARKET_B], maxDepositAtoms: { [USDC]: '5000000' } },
      });
      const amended = await service.amendMandate(ALICE, agent.id, next);

      expect(wallets.policyUpdates).toEqual([
        { policyId: agent.policyId, rules: compileMandate(parseMandate(next)) },
      ]);
      expect(amended.mandate).toEqual(parseMandate(next));
      expect(amended.updatedAt.getTime()).toBeGreaterThanOrEqual(agent.updatedAt.getTime());
      expect(await service.get(ALICE, agent.id)).toEqual(amended);
    });

    it('refuses an invalid mandate without touching the policy', async () => {
      const { service, wallets } = setup();
      const { agent } = await service.hire(ALICE, hireInput());
      const error = await refusal(
        service.amendMandate(ALICE, agent.id, mandateInput({ chainId: 1 })),
      );
      expect(error.reason).toBe('mandate_invalid');
      expect(wallets.policyUpdates).toHaveLength(0);
    });

    it('keeps the old mandate when the provider fails', async () => {
      const { service, wallets } = setup();
      const { agent } = await service.hire(ALICE, hireInput());
      wallets.updatePolicyError = new Error('privy 502');

      const error = await refusal(
        service.amendMandate(ALICE, agent.id, mandateInput({ venues: [] })),
      );
      expect(error.reason).toBe('wallet_policy_update_failed');
      expect((await service.get(ALICE, agent.id)).mandate).toEqual(agent.mandate);
    });
  });

  describe('revoke', () => {
    it('sends [] and refuses every later amend', async () => {
      const { service, wallets } = setup();
      const { agent } = await service.hire(ALICE, hireInput());

      const revoked = await service.revoke(ALICE, agent.id);
      expect(wallets.policyUpdates).toEqual([{ policyId: agent.policyId, rules: [] }]);
      expect(wallets.policies.get(agent.policyId)).toEqual([]);
      expect(revoked).toMatchObject({ status: 'revoked', policyCleared: true });
      // Not toBeInstanceOf(Date): the store's structuredClone builds its Dates
      // in node's realm, which jest's VM-realm `Date` does not recognise.
      expect(revoked.revokedAt?.getTime()).toBeGreaterThanOrEqual(agent.createdAt.getTime());

      const error = await refusal(service.amendMandate(ALICE, agent.id, mandateInput()));
      expect(error.reason).toBe('agent_revoked');
      expect(wallets.policyUpdates).toHaveLength(1);
      expect(wallets.policies.get(agent.policyId)).toEqual([]);
    });

    it('is idempotent once the policy is cleared', async () => {
      const { service, wallets } = setup();
      const { agent } = await service.hire(ALICE, hireInput());
      const first = await service.revoke(ALICE, agent.id);
      const second = await service.revoke(ALICE, agent.id);
      expect(second).toEqual(first);
      expect(wallets.policyUpdates).toHaveLength(1);
    });

    it('stops the agent even when the enclave update fails, and a retry clears the policy', async () => {
      const { service, wallets } = setup();
      const { agent, mcpToken } = await service.hire(ALICE, hireInput());
      wallets.updatePolicyError = new Error('privy 503');

      const error = await refusal(service.revoke(ALICE, agent.id));
      expect(error.reason).toBe('wallet_policy_update_failed');
      expect(error.message).toMatch(/revoke it again/);
      const stuck = await service.get(ALICE, agent.id);
      expect(stuck).toMatchObject({ status: 'revoked', policyCleared: false });
      expect(await service.findByMcpToken(mcpToken)).toBeUndefined();
      expect((await refusal(service.amendMandate(ALICE, agent.id, mandateInput()))).reason).toBe(
        'agent_revoked',
      );

      wallets.updatePolicyError = undefined;
      const cleared = await service.revoke(ALICE, agent.id);
      expect(cleared).toMatchObject({ status: 'revoked', policyCleared: true });
      expect(cleared.revokedAt).toEqual(stuck.revokedAt);
      expect(wallets.policies.get(agent.policyId)).toEqual([]);
    });

    it('still ends with an empty policy when it races an amend already in flight', async () => {
      const { service, wallets } = setup();
      const { agent } = await service.hire(ALICE, hireInput());

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      wallets.beforeUpdatePolicy = () => held;

      const amend = service.amendMandate(ALICE, agent.id, mandateInput({ venues: ['kuru'] }));
      const revoke = service.revoke(ALICE, agent.id);
      release();
      await Promise.all([amend, revoke]);

      expect(wallets.policyUpdates.map((u) => u.rules.length)).toEqual([
        compileMandate(parseMandate(mandateInput({ venues: ['kuru'] }))).length,
        0,
      ]);
      expect(wallets.policies.get(agent.policyId)).toEqual([]);
      expect((await service.get(ALICE, agent.id)).status).toBe('revoked');
    });
  });
});
