import { compileMandate, parseMandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { getAddress, type Address, type Hash } from 'viem';

import { loadGasDripConfig } from '../gas/gas.config';
import { GasDripService, type AgentDripCommand, type AgentDripOutcome } from '../gas/gas.service';
import { InMemoryDripLedger } from '../gas/ledger/in-memory-drip-ledger';
import type { IpRateLimiter } from '../gas/rate-limit/ip-rate-limiter';
import type { SenderPool } from '../gas/sender/sender-pool';
import { InMemoryUserWalletRegistry } from '../wallet/store/user-wallet-registry';
import { UnconfiguredAgentWalletProvider } from './agent-wallet.provider';
import { AgentRefusedError, AgentWalletsUnconfiguredError } from './agents.errors';
import {
  AgentsService,
  forkName,
  type AgentGasFunder,
  type HireAgentInput,
} from './agents.service';
import { toAgentResponse } from './dto/agent.dto';
import { DeviceMandateOwners, ServerMandateOwners } from './mandate-owner';
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
  const service = new AgentsService(store, wallets, new ServerMandateOwners());
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
        // ServerMandateOwners: the pre-SEN-43 shape, owned by this server.
        ownerKind: 'server',
      });
      expect(wallets.provisioned[0]!.ownerQuorumId).toBeUndefined();
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
      const service = new AgentsService(
        store,
        new UnconfiguredAgentWalletProvider(),
        new ServerMandateOwners(),
      );
      await expect(service.hire(ALICE, hireInput())).rejects.toBeInstanceOf(
        AgentWalletsUnconfiguredError,
      );
    });
  });

  /**
   * The Phase 3 half: whose key owns the mandate. `device` mode is driven
   * through the real `DeviceMandateOwners` over the real registry, so the spec
   * exercises the same lookup the module wires.
   */
  describe('device-owned mandates (SEN-43)', () => {
    const DEVICE_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-fake-device-key';

    async function deviceSetup(registered: string[] = ['alice']) {
      const registry = new InMemoryUserWalletRegistry();
      for (const userId of registered) {
        await registry.bind({
          userId,
          walletId: `user-wallet-${userId}`,
          address: getAddress(`0x${'b'.repeat(40)}`),
          ownerQuorumId: `kq-device-${userId}`,
          devicePublicKey: DEVICE_KEY,
        });
      }
      const store = new InMemoryAgentStore();
      const wallets = new FakeAgentWalletProvider();
      const service = new AgentsService(store, wallets, new DeviceMandateOwners(registry));
      return { store, wallets, service, registry };
    }

    it("hires under the caller's device quorum and records ownerKind: device", async () => {
      const { service, wallets } = await deviceSetup();
      const { agent } = await service.hire(ALICE, hireInput());

      expect(wallets.provisioned[0]!.ownerQuorumId).toBe('kq-device-alice');
      expect(agent.ownerKind).toBe('device');
    });

    it('forks under the FORKER’s quorum, not the source agent’s owner', async () => {
      const { service, wallets } = await deviceSetup(['alice', 'bob']);
      const { agent: source } = await service.hire(ALICE, hireInput());

      const { agent: fork } = await service.fork(BOB, source.id, { mandate: mandateInput() });

      expect(fork.userId).toBe('bob');
      expect(fork.ownerKind).toBe('device');
      expect(wallets.provisioned.map((p) => p.ownerQuorumId)).toEqual([
        'kq-device-alice',
        'kq-device-bob',
      ]);
    });

    it('refuses a caller with no registered wallet, before any Privy call', async () => {
      const { service, wallets, store } = await deviceSetup([]);
      const error = await refusal(service.hire(ALICE, hireInput()));

      expect(error.reason).toBe('wallet_not_registered');
      expect(error.message).toMatch(/wallet\/register/);
      // Nothing provisioned: a refused hire must not leave a Privy policy behind.
      expect(wallets.provisioned).toHaveLength(0);
      expect(await store.listByUser('alice')).toEqual([]);
    });

    it('refuses a fork by an unregistered caller too', async () => {
      const { service, wallets } = await deviceSetup(['alice']);
      const { agent: source } = await service.hire(ALICE, hireInput());

      const error = await refusal(service.fork(BOB, source.id, { mandate: mandateInput() }));
      expect(error.reason).toBe('wallet_not_registered');
      expect(wallets.provisioned).toHaveLength(1);
    });
  });

  describe('the gas drip at hire', () => {
    const TX = `0x${'a9'.repeat(32)}` as Hash;
    const AMOUNT = 150_000_000_000_000_000n;

    /** Records every drip and answers with `outcome`, or throws it. */
    class FakeGasFunder implements AgentGasFunder {
      readonly calls: AgentDripCommand[] = [];
      outcome: AgentDripOutcome | Error = {
        funded: true,
        receipt: {
          address: '0x0000000000000000000000000000000000000001',
          amountWei: AMOUNT,
          txHash: TX,
          sender: '0x0000000000000000000000000000000000000002',
          nonce: 0,
          revertedTxHashes: [],
          dailyTotalWei: AMOUNT,
          dryRun: false,
        },
      };

      dripToAgent(command: AgentDripCommand): Promise<AgentDripOutcome> {
        this.calls.push(command);
        return this.outcome instanceof Error
          ? Promise.reject(this.outcome)
          : Promise.resolve(this.outcome);
      }
    }

    function withGas(gas: AgentGasFunder = new FakeGasFunder()) {
      const store = new InMemoryAgentStore();
      return {
        store,
        service: new AgentsService(
          store,
          new FakeAgentWalletProvider(),
          new ServerMandateOwners(),
          gas,
        ),
      };
    }

    it('drips MON to the new agent’s own address, once, and records it', async () => {
      const gas = new FakeGasFunder();
      const { service, store } = withGas(gas);

      const { agent } = await service.hire(ALICE, hireInput());

      expect(gas.calls).toEqual([{ userId: 'alice', agentId: agent.id, address: agent.address }]);
      expect(agent.gasFunding).toEqual({ funded: true, txHash: TX, amountWei: AMOUNT });
      expect(await store.get(agent.id)).toEqual(agent);
      const wire = toAgentResponse(agent);
      expect(wire).toMatchObject({ gasFunded: true, gasFundingTxHash: TX });
      expect(wire).not.toHaveProperty('gasFundingReason');
    });

    it('leaves the hire successful when the drip is refused, with gasFunded false and the reason', async () => {
      const gas = new FakeGasFunder();
      gas.outcome = { funded: false, reason: 'daily_cap_reached', message: 'out of budget' };
      const { service } = withGas(gas);

      const { agent, mcpToken } = await service.hire(ALICE, hireInput());

      expect(mcpToken).toMatch(/^sente_mcp_/);
      expect(agent.status).toBe('active');
      expect(await service.get(ALICE, agent.id)).toEqual(agent);
      expect(toAgentResponse(agent)).toMatchObject({
        gasFunded: false,
        gasFundingReason: 'daily_cap_reached',
      });
    });

    it('keeps the tx hash of a drip that was sent but not confirmed', async () => {
      const gas = new FakeGasFunder();
      gas.outcome = { funded: false, reason: 'drip_unconfirmed', message: 'slow', txHash: TX };
      const { service } = withGas(gas);

      const { agent } = await service.hire(ALICE, hireInput());

      expect(toAgentResponse(agent)).toMatchObject({
        gasFunded: false,
        gasFundingReason: 'drip_unconfirmed',
        gasFundingTxHash: TX,
      });
    });

    it('still hires when the drip throws', async () => {
      const gas = new FakeGasFunder();
      gas.outcome = new Error('bug in the drip');
      const { service } = withGas(gas);

      const { agent } = await service.hire(ALICE, hireInput());

      expect(agent.gasFunding).toEqual({ funded: false, reason: 'drip_failed' });
    });

    it('hires unfunded, and says so, without the gas module', async () => {
      const { service } = setup();
      const { agent } = await service.hire(ALICE, hireInput());
      expect(toAgentResponse(agent)).toMatchObject({
        gasFunded: false,
        gasFundingReason: 'gas_drip_unavailable',
      });
    });

    it('does not drip for a refused hire', async () => {
      const gas = new FakeGasFunder();
      const { service } = withGas(gas);
      await refusal(service.hire(ALICE, hireInput({ model: 'openai/gpt-9' })));
      expect(gas.calls).toHaveLength(0);
    });

    it('drips gas to a fork’s own address too — a fork is a hire', async () => {
      const gas = new FakeGasFunder();
      const { service } = withGas(gas);
      const source = await service.hire(ALICE, hireInput());
      gas.calls.length = 0;

      const { agent } = await service.fork(BOB, source.agent.id, { mandate: mandateInput() });

      expect(gas.calls).toEqual([{ userId: 'bob', agentId: agent.id, address: agent.address }]);
      expect(agent.address).not.toBe(source.agent.address);
      expect(agent.gasFunding?.funded).toBe(true);
    });

    it('with the real drip: funds each agent a user hires up to the per-user cap, and hires past it', async () => {
      const sent: Address[] = [];
      const gas = new GasDripService(
        loadGasDripConfig({ GAS_DRIP_AGENT_MAX_PER_USER_PER_DAY: '2' }),
        new InMemoryDripLedger(),
        { size: 1 } as unknown as SenderPool,
        { getBalance: () => Promise.resolve(0n) },
        { hit: () => true } as unknown as IpRateLimiter,
        { getCode: () => Promise.resolve(undefined) },
        {
          send: (to) => {
            sent.push(to);
            return Promise.resolve({
              hash: TX,
              nonce: sent.length,
              sender: '0x0000000000000000000000000000000000000002',
              reverted: [],
            });
          },
        },
      );
      const { service } = withGas(gas);

      const hired = [];
      for (const name of ['one', 'two', 'three']) {
        hired.push((await service.hire(ALICE, hireInput({ name }))).agent);
      }
      const bobs = (await service.hire(BOB, hireInput())).agent;

      expect(hired.map((a) => toAgentResponse(a).gasFunded)).toEqual([true, true, false]);
      expect(hired[2]!.gasFunding?.reason).toBe('agent_daily_limit_reached');
      expect(hired.every((a) => a.status === 'active')).toBe(true);
      expect(bobs.gasFunding?.funded).toBe(true);
      expect(sent).toEqual([hired[0]!.address, hired[1]!.address, bobs.address]);
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

  describe('fork (SEN-28)', () => {
    it('copies the strategy and the model, and leaves a private prompt behind', async () => {
      const { service, store } = setup();
      const source = await service.hire(ALICE, hireInput());
      expect(source.agent.public).toBe(false);

      const { agent: fork, mcpToken } = await service.fork(BOB, source.agent.id, {
        mandate: mandateInput(),
      });

      expect(fork).toMatchObject({
        userId: 'bob',
        name: 'Momentum (fork)',
        model: source.agent.model,
        strategy: source.agent.strategy,
        // Private source: an EMPTY prompt, not a paraphrase of someone else's.
        systemPrompt: '',
        status: 'active',
        policyCleared: false,
        // The fork inherits the strategy, never the source's sharing choice.
        public: false,
        forkedFrom: source.agent.id,
      });
      expect(fork.id).not.toBe(source.agent.id);
      expect(mcpToken).toMatch(/^sente_mcp_/);
      expect(mcpToken).not.toBe(source.mcpToken);
      expect(fork.mcpTokenHash).toBe(hashMcpToken(mcpToken));
      // The source is untouched: still its own prompt, still its own wallet.
      expect(await store.get(source.agent.id)).toEqual(source.agent);
    });

    it('copies the prompt when the source’s owner published it', async () => {
      const { service } = setup();
      const source = await service.hire(ALICE, hireInput({ public: true }));

      const { agent: fork } = await service.fork(BOB, source.agent.id, { mandate: mandateInput() });

      expect(fork.systemPrompt).toBe(source.agent.systemPrompt);
      // Publishing the prompt does not make the COPY public: that is the
      // forker's own decision to make.
      expect(fork.public).toBe(false);
    });

    it('compiles the new policy from the forker’s mandate, on a new wallet', async () => {
      const { service, wallets } = setup();
      const source = await service.hire(ALICE, hireInput());
      // The forker's mandate is narrower than the source's, and allows a
      // different venue set entirely.
      const mine = mandateInput({
        venues: ['kuru'],
        kuru: { markets: [MARKET_B], maxDepositAtoms: { [USDC]: '1000000' } },
        perpl: { maxCollateralAtoms: '1000000', maxLeverage: 1, markets: [] },
        maxOrderNotional: '25',
      });

      const { agent: fork } = await service.fork(BOB, source.agent.id, { mandate: mine });

      expect(wallets.provisioned).toHaveLength(2);
      expect(wallets.provisioned[1]!.rules).toEqual(compileMandate(parseMandate(mine)));
      expect(wallets.provisioned[1]!.rules).not.toEqual(wallets.provisioned[0]!.rules);
      expect(wallets.provisioned[1]!.displayName).toBe(`sente-agent-${fork.id}`);
      expect(fork.mandate).toEqual(parseMandate(mine));
      expect(fork.mandate).not.toEqual(source.agent.mandate);
      expect(fork.policyId).not.toBe(source.agent.policyId);
      expect(fork.address).not.toBe(source.agent.address);
      // The enclave was never asked to re-write the SOURCE's policy; it still
      // holds the rules its own owner wrote.
      expect(wallets.policyUpdates).toEqual([]);
      expect(wallets.policies.get(source.agent.policyId)).toEqual(wallets.provisioned[0]!.rules);
    });

    it('names the fork after the source, or after the caller', async () => {
      const { service } = setup();
      const source = await service.hire(ALICE, hireInput({ name: 'Night desk' }));

      const auto = await service.fork(BOB, source.agent.id, { mandate: mandateInput() });
      expect(auto.agent.name).toBe('Night desk (fork)');

      const named = await service.fork(BOB, source.agent.id, {
        mandate: mandateInput(),
        name: '  My own desk  ',
      });
      expect(named.agent.name).toBe('My own desk');
    });

    it('keeps a defaulted name inside the API’s own limit', async () => {
      const { service } = setup();
      const source = await service.hire(ALICE, hireInput({ name: 'x'.repeat(64) }));

      const { agent } = await service.fork(BOB, source.agent.id, { mandate: mandateInput() });

      expect(agent.name).toBe(forkName('x'.repeat(64)));
      expect(agent.name).toHaveLength(64);
      expect(agent.name.endsWith(' (fork)')).toBe(true);
    });

    it('refuses a revoked source, and forks nothing', async () => {
      const { service, wallets, store } = setup();
      const source = await service.hire(ALICE, hireInput());
      await service.revoke(ALICE, source.agent.id);

      const error = await refusal(service.fork(BOB, source.agent.id, { mandate: mandateInput() }));
      expect(error.reason).toBe('agent_revoked');
      expect(error.message).toMatch(/cannot be forked/);
      expect(wallets.provisioned).toHaveLength(1);
      expect(await store.listByUser('bob')).toEqual([]);
    });

    it('answers an unknown source with agent_not_found, and provisions nothing', async () => {
      const { service, wallets } = setup();
      const error = await refusal(
        service.fork(BOB, '00000000-0000-4000-8000-000000000000', { mandate: mandateInput() }),
      );
      expect(error.reason).toBe('agent_not_found');
      expect(wallets.provisioned).toHaveLength(0);
    });

    it('refuses the forker’s own bad mandate before any Privy call', async () => {
      const { service, wallets } = setup();
      const source = await service.hire(ALICE, hireInput());

      const error = await refusal(
        service.fork(BOB, source.agent.id, { mandate: mandateInput({ chainId: 1 }) }),
      );
      expect(error.reason).toBe('mandate_invalid');
      expect(wallets.provisioned).toHaveLength(1);
    });

    it('shows the lineage and the sharing flag on the wire, and nothing secret', async () => {
      const { service } = setup();
      const source = await service.hire(ALICE, hireInput({ public: true }));
      const { agent: fork } = await service.fork(BOB, source.agent.id, { mandate: mandateInput() });

      const wire = toAgentResponse(fork);
      expect(wire).toMatchObject({ public: false, forkedFrom: source.agent.id });
      expect(wire).not.toHaveProperty('mcpTokenHash');
      expect(wire).not.toHaveProperty('userId');

      const sourceWire = toAgentResponse(source.agent);
      expect(sourceWire.public).toBe(true);
      expect(sourceWire).not.toHaveProperty('forkedFrom');
    });

    it('is the forker’s agent alone: it is listed for them, not for the source’s owner', async () => {
      const { service } = setup();
      const source = await service.hire(ALICE, hireInput());
      const { agent: fork } = await service.fork(BOB, source.agent.id, { mandate: mandateInput() });

      expect((await service.list(BOB)).map((a) => a.id)).toEqual([fork.id]);
      expect((await service.list(ALICE)).map((a) => a.id)).toEqual([source.agent.id]);
      expect((await service.get(BOB, fork.id)).id).toBe(fork.id);
      // And the source is still not readable to the forker.
      expect((await refusal(service.get(BOB, source.agent.id))).reason).toBe('agent_not_found');
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
