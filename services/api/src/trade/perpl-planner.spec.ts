import { ERC20_APPROVE_ABI, PERPL_EXCHANGE_ABI, type PerplContext } from '@sente/venues/perpl';
import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  getAddress,
  type Hex,
  type PublicClient,
} from 'viem';

import { kernelExecute } from './kuru-planner';
import { cachedPerplContext } from './perpl-context';
import {
  PerplPlanRefusedError,
  planPerplOnboard,
  type PerplOnboardIntent,
  type PerplPlannerDeps,
} from './perpl-planner';

const EXCHANGE = '0x1964C32f0bE608E7D29302AFF5E61268E72080cc';
const AUSD = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC';
const WALLET = getAddress(`0x${'a1'.repeat(20)}`);
const MIN = 100_000_000n;

/** The slice of the live testnet `/pub/context` onboarding reads. */
const CONTEXT: PerplContext = {
  chain: { chain_id: 10143 },
  instances: [
    {
      id: 12,
      address: EXCHANGE.toLowerCase(),
      collateral_token_id: 1,
      min_account_open_amount: MIN.toString(),
      min_deposit_amount: '10000000',
      min_withdraw_amount: '10000',
    },
  ],
  tokens: [
    { id: 1, address: AUSD, symbol: 'AUSD', name: 'AUSD', decimals: 6, display_precision: 2 },
  ],
  markets: [],
} as unknown as PerplContext;

const INTENT: PerplOnboardIntent = {
  kind: 'perpl.onboard',
  clientTradeId: '0b7a5c4e-2f1d-4c3b-9a8e-7d6c5b4a3f21',
  amountAtoms: '150000000',
};

type World = { accountId?: bigint; ausd?: bigint };

function fakeClient(world: World): PublicClient {
  const readContract = ({ functionName }: { functionName: string }) => {
    if (functionName === 'getAccountByAddr') {
      if (world.accountId === undefined) {
        return Promise.reject(new ContractFunctionRevertedError({ abi: [], functionName }));
      }
      return Promise.resolve({ accountId: world.accountId, balanceCNS: 0n, lockedBalanceCNS: 0n });
    }
    if (functionName === 'balanceOf') return Promise.resolve(world.ausd ?? 10n ** 12n);
    return Promise.reject(new Error(`unexpected read ${functionName}`));
  };
  return { readContract } as unknown as PublicClient;
}

function deps(world: World = {}, extra: Partial<PerplPlannerDeps> = {}): PerplPlannerDeps {
  return {
    client: fakeClient(world),
    wallet: WALLET,
    context: CONTEXT,
    atomicBatch: false,
    forwarding: null,
    ...extra,
  };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((e: unknown) => e);
  if (error instanceof PerplPlanRefusedError) return error.reason;
  throw new Error(`expected a refusal, got ${String(error)}`);
}

function decode(data: Hex) {
  return decodeFunctionData({ abi: [...ERC20_APPROVE_ABI, ...PERPL_EXCHANGE_ABI], data });
}

describe('planPerplOnboard', () => {
  it('fresh wallet: approve exactly, createAccount, allowOrderForwarding — three direct steps', async () => {
    const plan = await planPerplOnboard(INTENT, deps());

    expect(plan.steps.map((s) => s.kind)).toEqual([
      'perpl.approve',
      'perpl.createAccount',
      'perpl.allowForwarding',
    ]);
    const [approve, create, forward] = plan.steps;
    expect(approve!.transaction.to).toBe(AUSD);
    expect(decode(approve!.transaction.data)).toMatchObject({
      functionName: 'approve',
      args: [EXCHANGE, 150_000_000n],
    });
    expect(create!.transaction.to).toBe(EXCHANGE);
    expect(decode(create!.transaction.data)).toMatchObject({
      functionName: 'createAccount',
      args: [150_000_000n],
    });
    expect(decode(forward!.transaction.data)).toMatchObject({
      functionName: 'allowOrderForwarding',
      args: [true],
    });
    // The phone accepts `value` only on a native Kuru deposit.
    for (const step of plan.steps) {
      expect(step.transaction).not.toHaveProperty('value');
      expect(step.calls).toHaveLength(1);
    }
    expect(plan.summary).toMatchObject({ deposit: '150', collateral: 'AUSD', resumed: 'false' });
  });

  it('refuses below the live minimum', async () => {
    const intent = { ...INTENT, amountAtoms: (MIN - 1n).toString() };
    expect(await refusal(planPerplOnboard(intent, deps()))).toBe('below_min_account_open');
  });

  it('refuses when the wallet holds less AUSD than it would deposit', async () => {
    expect(await refusal(planPerplOnboard(INTENT, deps({ ausd: 149_999_999n })))).toBe(
      'insufficient_balance',
    );
  });

  it('refuses a malformed amount', async () => {
    const intent = { ...INTENT, amountAtoms: '1.5' };
    expect(await refusal(planPerplOnboard(intent, deps()))).toBe('invalid_intent');
  });

  it('existing account: only the forwarding step, whatever the amount', async () => {
    const intent = { ...INTENT, amountAtoms: '1' };
    const plan = await planPerplOnboard(intent, deps({ accountId: 493n }));
    expect(plan.steps.map((s) => s.kind)).toEqual(['perpl.allowForwarding']);
    expect(plan.summary).toMatchObject({ accountId: '493', resumed: 'true' });
  });

  it('existing account with forwarding known on: nothing to sign', async () => {
    const promise = planPerplOnboard(INTENT, deps({ accountId: 493n }, { forwarding: true }));
    expect(await refusal(promise)).toBe('perpl_already_onboarded');
  });

  it('atomic batch packs the three legs into one self-call in batch mode', async () => {
    const plan = await planPerplOnboard(INTENT, deps({}, { atomicBatch: true }));
    expect(plan.steps).toHaveLength(1);
    const [batch] = plan.steps;
    expect(batch!.kind).toBe('batch');
    expect(batch!.transaction.to).toBe(WALLET);
    expect(batch!.transaction).not.toHaveProperty('value');
    expect(batch!.transaction.data).toBe(kernelExecute(batch!.calls));
    expect(batch!.calls.map((c) => decode(c.data!).functionName)).toEqual([
      'approve',
      'createAccount',
      'allowOrderForwarding',
    ]);
  });

  it('atomic batch leaves a lone forwarding leg unwrapped', async () => {
    const plan = await planPerplOnboard(INTENT, deps({ accountId: 7n }, { atomicBatch: true }));
    expect(plan.steps.map((s) => [s.kind, s.transaction.to])).toEqual([
      ['perpl.allowForwarding', EXCHANGE],
    ]);
  });

  it('refuses to plan against a context naming another Exchange', async () => {
    const moved = {
      ...CONTEXT,
      instances: [{ ...CONTEXT.instances[0]!, address: `0x${'ee'.repeat(20)}` }],
    };
    await expect(planPerplOnboard(INTENT, deps({}, { context: moved }))).rejects.toThrow(
      /different Exchange/,
    );
  });
});

describe('cachedPerplContext', () => {
  it('reuses a context within the TTL and forgets a failed read', async () => {
    let clock = 0;
    const fetchContext = jest
      .fn<Promise<PerplContext>, []>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(CONTEXT);
    const source = cachedPerplContext(fetchContext, 1000, () => clock);

    await expect(source()).rejects.toThrow('down');
    expect(await source()).toBe(CONTEXT);
    clock = 999;
    await source();
    expect(fetchContext).toHaveBeenCalledTimes(2);
    clock = 1000;
    await source();
    expect(fetchContext).toHaveBeenCalledTimes(3);
  });
});
