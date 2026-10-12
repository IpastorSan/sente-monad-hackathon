/**
 * The Kuru planner with Set C active (SEN-189): address-keyed deposit and
 * withdraw, and an order on a Set C book. Runs in `test:set-c`
 * (`KURU_DEPLOYMENT=set-c`); with Set D active every case is skipped, and
 * `kuru-planner.spec.ts` covers Set D.
 */
import {
  KURU_ACCOUNT_CORE_DEPOSIT_ABIS,
  KURU_ACCOUNT_CORE_WITHDRAW_ABIS,
  KURU_DEPLOYMENT,
  KURU_DEPLOYMENTS,
  KURU_ORDERBOOK_BATCH_ABI,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
} from '@sente/venues/kuru';
import {
  decodeFunctionData,
  isAddressEqual,
  parseEther,
  type Address,
  type PublicClient,
} from 'viem';

import { planKuru, type KuruPlaceIntent, type KuruPlannerDeps } from './kuru-planner';

const setC = KURU_DEPLOYMENT.id === 'set-c' ? describe : describe.skip;

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const ACCOUNT_CORE = KURU_TESTNET_CONTRACTS.accountCore;
const USDC = KURU_TESTNET_TOKENS.USDC;

function deps(free: bigint, reads: string[] = []): KuruPlannerDeps {
  const readContract = ({
    address,
    functionName,
    args,
  }: {
    address: Address;
    functionName: string;
    args?: readonly unknown[];
  }) => {
    reads.push(functionName);
    if (functionName === 'getMarketParams') {
      const market = KURU_TESTNET_MARKETS.find((m) => isAddressEqual(m.address, address))!;
      return Promise.resolve([
        market.pricePrecision,
        market.sizePrecision,
        1n,
        10_000_000n,
        5_000_000_000_000n,
        7000n,
        4000n,
      ]);
    }
    if (functionName === 'userRegistry') {
      expect(isAddressEqual(args![0] as Address, WALLET)).toBe(true);
      return Promise.resolve(62);
    }
    if (functionName === 'getBalanceById') {
      expect(isAddressEqual(address, ACCOUNT_CORE)).toBe(true);
      expect(args![0]).toBe(62);
      return Promise.resolve(free);
    }
    return Promise.reject(new Error(`fake client: no ${functionName}`));
  };
  const client = {
    readContract,
    getBalance: () => Promise.resolve(parseEther('100')),
  } as unknown as PublicClient;
  return { client, wallet: WALLET, atomicBatch: false };
}

setC('planKuru on Set C (SEN-189)', () => {
  // From the table, not the active exports: a skipped describe still runs its body.
  const cbBtc = KURU_DEPLOYMENTS['set-c'].markets.find((m) => m.symbol === 'cbBTC-USDC')!;

  /** Buy 0.0002 cbBTC at 110,000 USDC: 22 USDC notional. */
  const buy: KuruPlaceIntent = {
    kind: 'kuru.place',
    clientTradeId: '5b0c8f1e-9a3d-4c2b-8e7f-1a2b3c4d5e6f',
    market: cbBtc.address,
    side: 'buy',
    orderType: 'limit',
    sizeAtoms: '20000', // 0.0002 at size precision 10^8
    priceUnits: '11000000', // 110,000 at price precision 10^2
    maxDepositAtoms: '30000000',
  };

  it('trades the Set C book, funding it with deposit(token, amount) on the Set C AccountCore', async () => {
    const reads: string[] = [];
    const plan = await planKuru(buy, deps(0n, reads));
    expect(plan.steps.map((s) => s.kind)).toEqual(['approve', 'deposit', 'place']);
    const [, deposit, place] = plan.steps;
    expect(ACCOUNT_CORE).toBe('0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22');
    expect(deposit!.transaction.to).toBe(ACCOUNT_CORE);
    const deposited = decodeFunctionData({
      abi: KURU_ACCOUNT_CORE_DEPOSIT_ABIS['address-keyed'],
      data: deposit!.transaction.data,
    });
    // No account in the call: Set C credits the caller, the wallet itself.
    expect(deposited.args).toEqual([USDC.address, 22_008_800n]);
    expect(place!.transaction.to).toBe(cbBtc.address);
    expect(
      decodeFunctionData({ abi: KURU_ORDERBOOK_BATCH_ABI, data: place!.transaction.data })
        .functionName,
    ).toBe('batch');
    expect(reads).toContain('userRegistry');
    expect(reads).not.toContain('rootAccountIdOf');
  });

  it('withdraws with withdraw(token, amount), which pays the wallet', async () => {
    const plan = await planKuru(
      { kind: 'kuru.withdraw', clientTradeId: 'w-1', token: USDC.address, amountAtoms: '5000000' },
      deps(5_000_000n),
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(['withdraw']);
    const { args } = decodeFunctionData({
      abi: KURU_ACCOUNT_CORE_WITHDRAW_ABIS['address-keyed'],
      data: plan.steps[0]!.transaction.data,
    });
    expect(args).toEqual([USDC.address, 5_000_000n]);
  });
});
