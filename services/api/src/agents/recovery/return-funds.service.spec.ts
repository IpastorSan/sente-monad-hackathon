/**
 * `POST /agents/:id/return` (SEN-17), over the real AgentsService with a fake
 * Privy provider, the fake Kuru venue and a fake chain reader: the two legs, in
 * order, and every way the route refuses before signing anything.
 */
import { compileRevocationRules } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import { decodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from 'viem';

import type { Auth } from '../../auth/principal';
import { AgentsController } from '../agents.controller';
import { AgentRefusedError, EnclaveRefusedError } from '../agents.errors';
import { AgentsService, type HireAgentInput } from '../agents.service';
import { ServerMandateOwners } from '../mandate-owner';
import { InMemoryAgentStore, type AgentRecord } from '../store/agent-store';
import { FakeAgentWalletProvider } from '../testing/fake-agent-wallet.provider';
import { FakeKuruVenue } from '../tools/testing/fake-venues';
import type { AgentReceipt, AgentTransaction } from '../venues/agent-transactions';
import {
  returnableAssets,
  ReturnFundsService,
  type ReturnChainReader,
  type ReturnSender,
  type ReturnVenues,
} from './return-funds.service';

const ALICE = { userId: 'alice' };
const OWNER = getAddress(`0x${'c'.repeat(40)}`);
const USDC = KURU_TESTNET_TOKENS.USDC;
const AUSD = getAddress(PERPL_TESTNET_CONTRACTS.collateral);
/** Plenty: the gas gate is not what these tests are about unless they say so. */
const MON = 10n ** 18n;

function mandateInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    chainId: 10143,
    expiresAt: 2_000_000_000,
    venues: ['kuru'],
    kuru: {
      markets: [KURU_TESTNET_MARKETS[0]!.address],
      maxDepositAtoms: { [USDC.address]: '1000000000' },
    },
    perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
    maxOrderNotional: '250',
    ...over,
  };
}

function hireInput(over: Partial<HireAgentInput> = {}): HireAgentInput {
  return {
    name: 'Momentum',
    systemPrompt: '',
    strategy: 'Buy strength.',
    model: 'anthropic/claude-sonnet-5',
    mandate: mandateInput(),
    ...over,
  };
}

/** Every ERC-20 balance the agent's wallet holds, by token address. */
type Held = Partial<Record<Address, bigint>>;

class FakeChain implements ReturnChainReader {
  mon = MON;
  /** What the agent's WALLET holds. */
  held: Held = {};
  /** What its Kuru account holds, free. */
  free: Held = {};
  fee = 100n * 10n ** 9n;
  readonly reads: string[] = [];

  monBalance(): Promise<bigint> {
    return Promise.resolve(this.mon);
  }

  tokenBalance(token: Address): Promise<bigint> {
    this.reads.push(token);
    return Promise.resolve(this.held[getAddress(token)] ?? 0n);
  }

  collateral(token: Address): Promise<bigint> {
    return Promise.resolve(this.free[getAddress(token)] ?? 0n);
  }

  maxFeePerGas(): Promise<bigint> {
    return Promise.resolve(this.fee);
  }
}

/** Records every transaction and answers with a successful receipt. */
class FakeSender implements ReturnSender {
  readonly sent: AgentTransaction[] = [];
  success = true;
  /** Appended to by the venue too, so the ORDER of the two legs is observable. */
  readonly order: string[] = [];

  sendAll(_wallet: unknown, txs: readonly AgentTransaction[]): Promise<AgentReceipt[]> {
    this.sent.push(...txs);
    this.order.push('transfer');
    return Promise.resolve(
      txs.map((_tx, index) => ({
        transactionHash: `0x${String(index + 1).repeat(64)}`.slice(0, 66) as Hex,
        success: this.success,
        logs: [],
        blockNumber: 1n,
      })),
    );
  }
}

async function setup(options: { returnTo?: Address; hire?: Partial<HireAgentInput> } = {}) {
  const store = new InMemoryAgentStore();
  const wallets = new FakeAgentWalletProvider();
  const agents = new AgentsService(
    store,
    wallets,
    new ServerMandateOwners(),
    undefined,
    undefined,
    undefined,
    { addressFor: () => Promise.resolve(options.returnTo ?? OWNER) },
  );
  const kuru = new FakeKuruVenue();
  const chain = new FakeChain();
  const sender = new FakeSender();
  kuru.onWrite = (method) => {
    sender.order.push(method);
    return Promise.resolve();
  };
  const venues: ReturnVenues = { forAgent: () => Promise.resolve({ kuru }) };
  const service = new ReturnFundsService(agents, venues, sender, chain);
  const { agent } = await agents.hire(ALICE, hireInput(options.hire));
  return { service, agents, wallets, store, kuru, chain, sender, agent };
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

function transferOf(tx: AgentTransaction): { to: Address; amount: bigint } {
  const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
  return { to: getAddress(args![0] as Address), amount: args![1] as bigint };
}

describe('ReturnFundsService', () => {
  it('withdraws Kuru collateral first, then transfers the wallet balance to the owner', async () => {
    const { service, kuru, chain, sender, agent } = await setup();
    // 4 USDC free in Kuru; a fifth is reserved by a resting order, and
    // `AccountCore.getBalance` does not report that at all.
    chain.free = { [USDC.address]: 4_000_000n };
    // Before the withdraw the wallet holds 1.5; after it, the 4 have landed too.
    chain.held = { [USDC.address]: 1_500_000n };
    kuru.onWrite = (method) => {
      sender.order.push(method);
      chain.held = { [USDC.address]: 5_500_000n };
      return Promise.resolve();
    };

    const outcome = await service.returnFunds(ALICE, agent.id, { asset: 'USDC' });

    // The withdraw ran before the transfer, and only those two writes ran.
    expect(sender.order).toEqual(['withdraw', 'transfer']);
    expect(kuru.writes()).toEqual([{ method: 'withdraw', args: { asset: 'USDC', amount: '4' } }]);
    expect(outcome.returnTo).toBe(OWNER);
    expect(outcome.assets).toEqual([
      {
        asset: 'USDC',
        withdrawn: { amount: '4', transactionHash: expect.any(String), success: true },
        // 5.5: the 1.5 it held plus the 4 the withdraw delivered. The reserved
        // fifth stays on the venue until the order that holds it is cancelled.
        returned: { amount: '5.5', transactionHash: expect.any(String), success: true },
      },
    ]);
    expect(sender.sent).toHaveLength(1);
    expect(transferOf(sender.sent[0]!)).toEqual({ to: OWNER, amount: 5_500_000n });
    expect(sender.sent[0]!.to).toBe(USDC.address);
  });

  it('sends every asset home when none is named, and says why each was skipped', async () => {
    const { service, chain, sender, agent } = await setup();
    chain.held = { [USDC.address]: 2_000_000n, [AUSD]: 7_000_000n };

    const outcome = await service.returnFunds(ALICE, agent.id);

    expect(outcome.assets.map((a) => a.asset)).toEqual(returnableAssets().map((a) => a.symbol));
    const moved = outcome.assets.filter((a) => a.returned);
    expect(moved.map((a) => [a.asset, a.returned!.amount])).toEqual([
      ['USDC', '2'],
      ['AUSD', '7'],
    ]);
    for (const asset of outcome.assets.filter((a) => !a.returned)) {
      expect(asset.skipped).toMatch(/holds no/);
    }
    expect(sender.sent.map(transferOf)).toEqual([
      { to: OWNER, amount: 2_000_000n },
      { to: OWNER, amount: 7_000_000n },
    ]);
  });

  it('returns only the amount asked for', async () => {
    const { service, kuru, chain, sender, agent } = await setup();
    chain.free = { [USDC.address]: 10_000_000n };
    chain.held = { [USDC.address]: 3_000_000n };

    const outcome = await service.returnFunds(ALICE, agent.id, { asset: 'USDC', amount: '1.25' });

    // The wallet already holds more than was asked for, so nothing is withdrawn.
    expect(kuru.writes()).toEqual([]);
    expect(outcome.assets[0]!.withdrawn).toBeUndefined();
    expect(transferOf(sender.sent[0]!).amount).toBe(1_250_000n);
  });

  it('works on a REVOKED agent, which is the point', async () => {
    const { service, agents, wallets, chain, sender, agent } = await setup();
    chain.held = { [USDC.address]: 2_000_000n };

    const revoked = await agents.revoke(ALICE, agent.id);
    // The policy still holds the exit, so the transfer the route signs is one
    // the enclave will still accept.
    expect(wallets.policies.get(agent.policyId)).toEqual(compileRevocationRules(revoked.mandate));

    const outcome = await service.returnFunds(ALICE, agent.id);
    expect(outcome.assets.find((a) => a.asset === 'USDC')?.returned?.amount).toBe('2');
    expect(sender.sent).toHaveLength(1);
  });

  it('refuses an agent whose mandate names no exit, before any transaction', async () => {
    // No registered owner wallet at hire, so no `returnTo`: the state every
    // agent hired before SEN-17 is in, and the reason hire resolves it itself.
    const noExit = await setupWithoutOwner();
    const error = await refusal(noExit.service.returnFunds(ALICE, noExit.agent.id));
    expect(error.reason).toBe('return_address_missing');
    expect(error.message).toMatch(/amend its mandate/);
    expect(noExit.sender.sent).toEqual([]);
    expect(noExit.kuru.writes()).toEqual([]);
  });

  it('refuses an unknown asset, a bad amount, and an amount with no asset', async () => {
    const { service, sender, agent } = await setup();

    expect((await refusal(service.returnFunds(ALICE, agent.id, { asset: 'DOGE' }))).reason).toBe(
      'return_asset_not_supported',
    );
    expect(
      (await refusal(service.returnFunds(ALICE, agent.id, { asset: 'USDC', amount: 'lots' })))
        .reason,
    ).toBe('return_amount_invalid');
    // Too many decimals for the token: a rounded transfer is not what was asked.
    expect(
      (await refusal(service.returnFunds(ALICE, agent.id, { asset: 'USDC', amount: '0.0000001' })))
        .reason,
    ).toBe('return_amount_invalid');
    expect((await refusal(service.returnFunds(ALICE, agent.id, { amount: '1' }))).reason).toBe(
      'return_amount_invalid',
    );
    expect(sender.sent).toEqual([]);
  });

  it('refuses when the agent cannot pay for the legs, naming the shortfall', async () => {
    const { service, kuru, chain, sender, agent } = await setup();
    chain.free = { [USDC.address]: 4_000_000n };
    chain.held = { [USDC.address]: 1_000_000n };
    chain.mon = 1n;

    const error = await refusal(service.returnFunds(ALICE, agent.id, { asset: 'USDC' }));
    expect(error.reason).toBe('return_gas_insufficient');
    expect(error.message).toContain('agent:fund');
    expect(sender.sent).toEqual([]);
    expect(kuru.writes()).toEqual([]);
  });

  it('is another user’s 404, and moves nothing', async () => {
    const { service, sender, agent, chain } = await setup();
    chain.held = { [USDC.address]: 2_000_000n };
    const error = await refusal(service.returnFunds({ userId: 'bob' }, agent.id));
    expect(error.reason).toBe('agent_not_found');
    expect(sender.sent).toEqual([]);
  });

  it('reports a leg that failed instead of claiming the money moved', async () => {
    const { service, chain, sender, agent } = await setup();
    chain.held = { [USDC.address]: 2_000_000n };
    sender.success = false;

    const outcome = await service.returnFunds(ALICE, agent.id, { asset: 'USDC' });
    expect(outcome.assets[0]!.returned).toMatchObject({ success: false });
  });

  it('lets an enclave refusal through as itself: nothing was signed', async () => {
    // The honest outcome when a policy has no transfer rule after all — a 403
    // `policy_violation`, not a success with nothing in it.
    const { agents, kuru, chain, agent } = await setup();
    chain.held = { [USDC.address]: 2_000_000n };
    const refused = new EnclaveRefusedError({
      walletId: agent.walletId,
      method: 'eth_signTransaction',
    });
    const service = new ReturnFundsService(
      agents,
      { forAgent: () => Promise.resolve({ kuru }) },
      { sendAll: () => Promise.reject(refused) },
      chain,
    );
    await expect(service.returnFunds(ALICE, agent.id, { asset: 'USDC' })).rejects.toBe(refused);
  });

  it('maps a refusal to its HTTP status through the controller', async () => {
    const noExit = await setupWithoutOwner();
    const auth: Auth = { principal: () => ALICE };
    const controller = new AgentsController(
      noExit.agents,
      auth,
      {} as never,
      {} as never,
      {} as never,
      noExit.service,
    );
    const error: unknown = await controller.returnFunds({ id: noExit.agent.id }, {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as { getStatus(): number }).getStatus()).toBe(409);
    expect((error as { getResponse(): { reason: string } }).getResponse()).toMatchObject({
      reason: 'return_address_missing',
    });
  });

  it('answers the controller with what moved', async () => {
    const { service, agents, chain, agent } = await setup();
    chain.held = { [USDC.address]: 2_000_000n };
    const auth: Auth = { principal: () => ALICE };
    const controller = new AgentsController(
      agents,
      auth,
      {} as never,
      {} as never,
      {} as never,
      service,
    );

    const body = await controller.returnFunds({ id: agent.id }, { asset: 'USDC' });
    expect(body).toMatchObject({
      agentId: agent.id,
      returnTo: OWNER,
      assets: [{ asset: 'USDC', returned: { amount: '2', success: true } }],
    });
    expect(typeof body.monSpent).toBe('string');
  });
});

/** An agent hired with no registered owner wallet: no `returnTo`, so no exit. */
async function setupWithoutOwner() {
  const store = new InMemoryAgentStore();
  const wallets = new FakeAgentWalletProvider();
  const agents = new AgentsService(store, wallets, new ServerMandateOwners());
  const kuru = new FakeKuruVenue();
  const chain = new FakeChain();
  const sender = new FakeSender();
  const service = new ReturnFundsService(
    agents,
    { forAgent: () => Promise.resolve({ kuru }) },
    sender,
    chain,
  );
  const { agent }: { agent: AgentRecord } = await agents.hire(ALICE, hireInput());
  expect(agent.mandate.returnTo).toBeUndefined();
  return { service, agents, kuru, chain, sender, agent };
}
