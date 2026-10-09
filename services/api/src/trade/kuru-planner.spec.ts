import {
  KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI,
  KURU_ACCOUNT_CORE_DEPOSIT_ABI,
  KURU_ORDERBOOK_BATCH_ABI,
  KURU_ORDERBOOK_BUILDER_BATCH_ABI,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  NATIVE_TOKEN,
} from '@sente/venues/kuru';
import {
  decodeAbiParameters,
  decodeFunctionData,
  erc20Abi,
  isAddressEqual,
  keccak256,
  parseEther,
  sliceHex,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import {
  baseReserveAtoms,
  kernelExecute,
  KuruPlanRefusedError,
  planKuru,
  type KuruPlaceIntent,
  type KuruPlannerDeps,
} from './kuru-planner';

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const MON_USDC = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'MON-USDC')!;
const USDC = KURU_TESTNET_TOKENS.USDC;
const ACCOUNT_CORE = KURU_TESTNET_CONTRACTS.accountCore;
const CLIENT_TRADE_ID = '5b0c8f1e-9a3d-4c2b-8e7f-1a2b3c4d5e6f';

const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'execMode', type: 'bytes32' },
      { name: 'executionCalldata', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

type World = {
  tickSize?: bigint;
  minQuote?: bigint;
  maxQuote?: bigint;
  /** Free Kuru balance per token address (lowercase). */
  kuruFree?: Record<string, bigint>;
  walletMon?: bigint;
  accountId?: bigint;
  liveOrderId?: bigint;
  /** `getBuilderApproval(WALLET, builder)`; none by default. */
  builderApproval?: { maxFeePps: number; expiry: bigint; active: boolean };
};

/** The chain reads the planner makes: market params, free balances, account id, slots. */
function fakeClient(world: World = {}): PublicClient {
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
      const market = KURU_TESTNET_MARKETS.find((m) => isAddressEqual(m.address, address))!;
      return Promise.resolve([
        market.pricePrecision,
        market.sizePrecision,
        world.tickSize ?? 1n,
        world.minQuote ?? 1_000_000n,
        world.maxQuote ?? 10n ** 30n,
        700n, // taker 0.07%
        4_000n, // maker 0.04%: 10 USDC -> 10.004 locked, as in docs/kuru.md
      ]);
    }
    if (functionName === 'getBalance') {
      expect(isAddressEqual(address, ACCOUNT_CORE)).toBe(true);
      expect(isAddressEqual(args![0] as Address, WALLET)).toBe(true);
      const token = (args![1] as Address).toLowerCase();
      return Promise.resolve(world.kuruFree?.[token] ?? 0n);
    }
    if (functionName === 'userRegistry') return Promise.resolve(world.accountId ?? 0n);
    if (functionName === 'getOrderId') return Promise.resolve(world.liveOrderId ?? 0n);
    if (functionName === 'getBuilderApproval') {
      expect(isAddressEqual(address, ACCOUNT_CORE)).toBe(true);
      expect(isAddressEqual(args![0] as Address, WALLET)).toBe(true);
      return Promise.resolve(world.builderApproval ?? { maxFeePps: 0, expiry: 0n, active: false });
    }
    return Promise.reject(new Error(`fake client: no ${functionName}`));
  };
  const getBalance = () => Promise.resolve(world.walletMon ?? parseEther('100'));
  return { readContract, getBalance } as unknown as PublicClient;
}

function deps(world: World = {}, atomicBatch = false): KuruPlannerDeps {
  return { client: fakeClient(world), wallet: WALLET, atomicBatch };
}

/** Buy 500 MON at 0.02 USDC: 10 USDC notional, 10.004 USDC reserved at the maker rate. */
function buy(over: Partial<KuruPlaceIntent> = {}): KuruPlaceIntent {
  return {
    kind: 'kuru.place',
    clientTradeId: CLIENT_TRADE_ID,
    market: MON_USDC.address,
    side: 'buy',
    orderType: 'limit',
    sizeAtoms: (500n * 10n ** 8n).toString(),
    priceUnits: '20000',
    maxDepositAtoms: '20000000',
    ...over,
  };
}

function decodePlace(data: Hex) {
  const { args } = decodeFunctionData({ abi: KURU_ORDERBOOK_BATCH_ABI, data });
  const [userId, orders, cancels, clientOrderId] = args as unknown as [
    bigint,
    {
      side: number;
      quantity: bigint;
      price: number | bigint;
      tif: number;
      executionInstruction: number;
    }[],
    number[],
    Hex,
  ];
  return { userId, orders, cancels, clientOrderId };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(KuruPlanRefusedError);
    return (error as KuruPlanRefusedError).reason;
  }
  throw new Error('expected a refusal');
}

const usdcKey = USDC.address.toLowerCase();

describe('planKuru — place', () => {
  it('is one direct place step when the Kuru account already covers the reserve', async () => {
    const plan = await planKuru(buy(), deps({ kuruFree: { [usdcKey]: 10_004_000n } }));

    expect(plan.steps.map((s) => s.kind)).toEqual(['place']);
    const [step] = plan.steps;
    expect(step!.transaction.to).toBe(MON_USDC.address);
    expect(step!.transaction.value).toBeUndefined();
    const placed = decodePlace(step!.transaction.data);
    expect(BigInt(placed.userId)).toBe(0n);
    expect(placed.cancels).toEqual([]);
    expect(placed.orders).toHaveLength(1);
    expect(placed.orders[0]!.quantity).toBe(500n * 10n ** 8n);
    expect(BigInt(placed.orders[0]!.price)).toBe(20_000n);
    expect(placed.orders[0]!.tif).toBe(0); // GTC
    expect(placed.orders[0]!.executionInstruction).toBe(0);
    expect(placed.clientOrderId).toBe(keccak256(toBytes(CLIENT_TRADE_ID)));
    expect(plan.summary).toMatchObject({ reserve: '10.004', deposit: '0', fundingToken: 'USDC' });
  });

  it('deposits only the shortfall, approving exactly that amount, in [approve, deposit, place]', async () => {
    const plan = await planKuru(buy(), deps({ kuruFree: { [usdcKey]: 4_000_000n } }));

    expect(plan.steps.map((s) => s.kind)).toEqual(['approve', 'deposit', 'place']);
    const [approve, deposit] = plan.steps;
    expect(approve!.transaction.to).toBe(USDC.address);
    const approved = decodeFunctionData({ abi: erc20Abi, data: approve!.transaction.data });
    expect(approved.functionName).toBe('approve');
    expect(approved.args).toEqual([ACCOUNT_CORE, 6_004_000n]);

    expect(deposit!.transaction.to).toBe(ACCOUNT_CORE);
    expect(deposit!.transaction.value).toBeUndefined();
    const deposited = decodeFunctionData({
      abi: KURU_ACCOUNT_CORE_DEPOSIT_ABI,
      data: deposit!.transaction.data,
    });
    expect(deposited.args).toEqual([USDC.address, 6_004_000n]);
    expect(approve!.title).toBe('Approve 6.004 USDC for Kuru');
    // What the receipt is decoded against later (SEN-97).
    expect(plan.place).toMatchObject({
      market: MON_USDC.address,
      timeInForce: 'GTC',
      quantity: 500n * 10n ** 8n,
      quoteDecimals: 6,
      funding: { symbol: 'USDC', decimals: 6, deposit: 6_004_000n },
    });
  });

  it('packs every leg into one self-call batch when atomicBatch is on', async () => {
    const plan = await planKuru(buy(), deps({ kuruFree: { [usdcKey]: 4_000_000n } }, true));

    expect(plan.steps).toHaveLength(1);
    const [step] = plan.steps;
    expect(step!.kind).toBe('batch');
    expect(step!.calls).toHaveLength(3);
    expect(step!.transaction.to).toBe(WALLET);
    expect(step!.transaction.value).toBeUndefined();

    const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: step!.transaction.data });
    const [mode, executionCalldata] = args;
    expect(mode).toBe(`0x01${'00'.repeat(31)}`); // batch, revert on failure
    const [executions] = decodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'callData', type: 'bytes' },
          ],
        },
      ],
      executionCalldata,
    );
    expect(executions.map((e) => e.target)).toEqual([USDC.address, ACCOUNT_CORE, MON_USDC.address]);
    expect(executions.map((e) => e.callData)).toEqual(step!.calls.map((c) => c.data));
  });

  it('does not wrap a lone place leg even when atomicBatch is on', async () => {
    const plan = await planKuru(buy(), deps({ kuruFree: { [usdcKey]: 20_000_000n } }, true));
    expect(plan.steps.map((s) => s.kind)).toEqual(['place']);
    expect(plan.steps[0]!.transaction.to).toBe(MON_USDC.address);
  });

  it('prices a market order as IOC at the given bound with the taker rate', async () => {
    const plan = await planKuru(buy({ orderType: 'market' }), deps());
    const place = plan.steps.find((s) => s.kind === 'place')!;
    const placed = decodePlace(place.transaction.data);
    expect(placed.orders[0]!.tif).toBe(1); // IOC
    // 10 USDC * (1 + 700 / 1e7) = 10.0007
    expect(plan.summary).toMatchObject({ reserve: '10.0007', deposit: '10.0007', feePps: '700' });
  });

  it('marks a post-only limit with the post-only instruction', async () => {
    const plan = await planKuru(
      buy({ postOnly: true }),
      deps({ kuruFree: { [usdcKey]: 10n ** 9n } }),
    );
    expect(decodePlace(plan.steps[0]!.transaction.data).orders[0]!.executionInstruction).toBe(1);
  });

  it('funds a sell with the base token, sending value only on the native deposit', async () => {
    const plan = await planKuru(
      buy({ side: 'sell', maxDepositAtoms: parseEther('500').toString() }),
      deps({ walletMon: parseEther('600') }),
    );

    expect(plan.steps.map((s) => s.kind)).toEqual(['deposit', 'place']);
    const [deposit] = plan.steps;
    expect(deposit!.transaction.value).toBe(parseEther('500'));
    const deposited = decodeFunctionData({
      abi: KURU_ACCOUNT_CORE_DEPOSIT_ABI,
      data: deposit!.transaction.data,
    });
    expect(deposited.args).toEqual([NATIVE_TOKEN, parseEther('500')]);
  });

  it('needs no deposit to sell MON already free on Kuru', async () => {
    const plan = await planKuru(
      buy({ side: 'sell', maxDepositAtoms: parseEther('500').toString() }),
      deps({ kuruFree: { [NATIVE_TOKEN]: parseEther('500') }, walletMon: 0n }),
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(['place']);
  });

  it('refuses a native deposit that would leave the wallet under the 10 MON reserve', async () => {
    const intent = buy({
      side: 'sell',
      sizeAtoms: (1000n * 10n ** 8n).toString(),
      maxDepositAtoms: parseEther('1000').toString(),
    });
    expect(await refusal(planKuru(intent, deps({ walletMon: parseEther('1009.9') })))).toBe(
      'reserve_balance',
    );
    await expect(planKuru(intent, deps({ walletMon: parseEther('1010') }))).resolves.toBeDefined();
  });

  it('refuses a shortfall above the confirmed deposit cap', async () => {
    expect(await refusal(planKuru(buy({ maxDepositAtoms: '10003999' }), deps()))).toBe(
      'deposit_cap_exceeded',
    );
    await expect(planKuru(buy({ maxDepositAtoms: '10004000' }), deps())).resolves.toBeDefined();
  });

  it('refuses an off-tick price', async () => {
    expect(await refusal(planKuru(buy({ priceUnits: '20005' }), deps({ tickSize: 10n })))).toBe(
      'invalid_intent',
    );
  });

  it('refuses an order below the market minimum notional', async () => {
    expect(await refusal(planKuru(buy(), deps({ minQuote: 10_000_001n })))).toBe(
      'below_min_notional',
    );
  });

  // SEN-135: the minimum is inclusive — an order of exactly the minimum
  // notional is a valid order on Kuru. Kills `<` -> `<=` at the min check.
  it('accepts an order of exactly the market minimum notional', async () => {
    await expect(planKuru(buy(), deps({ minQuote: 10_000_000n }))).resolves.toBeDefined();
  });

  // SEN-135: nothing else stood between an oversize order and the chain's own
  // revert. Kills deleting the max check, and `>` -> `>=` (the exact maximum
  // must still plan).
  it('refuses an order above the market maximum notional, accepting exactly the maximum', async () => {
    expect(await refusal(planKuru(buy(), deps({ maxQuote: 9_999_999n })))).toBe('invalid_intent');
    await expect(planKuru(buy(), deps({ maxQuote: 10_000_000n }))).resolves.toBeDefined();
  });

  it('refuses a market that is not allowlisted', async () => {
    const intent = buy({ market: '0x2222222222222222222222222222222222222222' });
    expect(await refusal(planKuru(intent, deps()))).toBe('market_not_allowed');
  });

  it('refuses malformed amounts and a post-only market order', async () => {
    expect(await refusal(planKuru(buy({ sizeAtoms: '0' }), deps()))).toBe('invalid_intent');
    expect(await refusal(planKuru(buy({ priceUnits: '1.5' }), deps()))).toBe('invalid_intent');
    expect(await refusal(planKuru(buy({ maxDepositAtoms: '-1' }), deps()))).toBe('invalid_intent');
    expect(await refusal(planKuru(buy({ orderType: 'market', postOnly: true }), deps()))).toBe(
      'invalid_intent',
    );
  });
});

describe('planKuru — cancel and withdraw', () => {
  const cancel = {
    kind: 'kuru.cancel' as const,
    clientTradeId: CLIENT_TRADE_ID,
    market: MON_USDC.address,
    orderId: '3:3683',
  };

  it('cancels a slot that still holds the order', async () => {
    const plan = await planKuru(cancel, deps({ accountId: 63n, liveOrderId: 3683n }));
    expect(plan.steps.map((s) => s.kind)).toEqual(['cancel']);
    const placed = decodePlace(plan.steps[0]!.transaction.data);
    expect(placed.orders).toEqual([]);
    expect(placed.cancels).toEqual([3]);
  });

  it('refuses an order that is no longer resting', async () => {
    expect(await refusal(planKuru(cancel, deps({ accountId: 63n, liveOrderId: 9n })))).toBe(
      'already_terminal',
    );
    expect(await refusal(planKuru(cancel, deps({ accountId: 0n })))).toBe('already_terminal');
  });

  const withdraw = {
    kind: 'kuru.withdraw' as const,
    clientTradeId: CLIENT_TRADE_ID,
    token: USDC.address,
    amountAtoms: '5000000',
  };

  it('withdraws free balance with one call', async () => {
    const plan = await planKuru(withdraw, deps({ kuruFree: { [usdcKey]: 5_000_000n } }, true));
    expect(plan.steps.map((s) => s.kind)).toEqual(['withdraw']);
    expect(plan.steps[0]!.transaction.to).toBe(ACCOUNT_CORE);
    expect(plan.steps[0]!.title).toBe('Withdraw 5 USDC from Kuru');
  });

  it('refuses more than is free, and a token Kuru does not list', async () => {
    expect(await refusal(planKuru(withdraw, deps({ kuruFree: { [usdcKey]: 4_999_999n } })))).toBe(
      'insufficient_balance',
    );
    const other = { ...withdraw, token: '0x2222222222222222222222222222222222222222' as Address };
    expect(await refusal(planKuru(other, deps()))).toBe('market_not_allowed');
  });
});

describe('kernelExecute', () => {
  it('uses single mode with a packed to‖value‖data for one call', () => {
    const call = { to: ACCOUNT_CORE, value: 5n, data: '0xdeadbeef' as Hex };
    const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: kernelExecute([call]) });
    expect(args[0]).toBe(`0x${'00'.repeat(32)}`);
    expect(sliceHex(args[1], 0, 20).toLowerCase()).toBe(ACCOUNT_CORE.toLowerCase());
    expect(BigInt(sliceHex(args[1], 20, 52))).toBe(5n);
    expect(sliceHex(args[1], 52)).toBe('0xdeadbeef');
  });
});

describe('baseReserveAtoms', () => {
  it('scales book size units to token atoms, rounding up', () => {
    const params = { sizePrecision: 100_000_000n } as Parameters<typeof baseReserveAtoms>[1];
    expect(baseReserveAtoms(1n, params, 18)).toBe(10n ** 10n);
    expect(baseReserveAtoms(3n, params, 6)).toBe(1n); // 0.00000003 of a 6-decimal token
  });
});

describe('planKuru with the Sente builder fee (SEN-184)', () => {
  const BUILDER: Address = '0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8';
  const NOW_MS = 1_800_000_000_000;
  const withBuilder = (world: World = {}, atomicBatch = false): KuruPlannerDeps => ({
    ...deps(world, atomicBatch),
    builder: { address: BUILDER, feePps: 10_000 },
    now: () => NOW_MS,
  });
  const funded = { kuruFree: { [USDC.address.toLowerCase()]: 100_000_000n } };

  it('off: the order keeps the plain overload and no approval leg appears', async () => {
    const plan = await planKuru(buy(), deps(funded));
    expect(plan.steps.map((s) => s.kind)).toEqual(['place']);
    expect(sliceHex(plan.steps[0]!.transaction.data, 0, 4)).toBe('0x6947f147');
    expect(plan.summary['senteFee']).toBeUndefined();
  });

  it('on, never approved: approveBuilder for one year, then the builder overload', async () => {
    const plan = await planKuru(buy(), withBuilder(funded));
    expect(plan.steps.map((s) => s.kind)).toEqual(['approveBuilder', 'place']);
    const approve = plan.steps[0]!.transaction;
    expect(approve.to).toBe(ACCOUNT_CORE);
    expect(approve.value).toBeUndefined();
    const { args } = decodeFunctionData({
      abi: KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI,
      data: approve.data,
    });
    expect(args).toEqual([BUILDER, 10_000, BigInt(NOW_MS / 1000 + 365 * 86_400)]);

    const place = plan.steps[1]!.transaction.data;
    expect(sliceHex(place, 0, 4)).toBe('0x2975ed7e');
    const decoded = decodeFunctionData({ abi: KURU_ORDERBOOK_BUILDER_BATCH_ABI, data: place });
    expect((decoded.args as readonly unknown[])[4]).toEqual({ builder: BUILDER, feePps: 10_000 });
  });

  it('on, already approved for long enough: no approval leg', async () => {
    const plan = await planKuru(
      buy(),
      withBuilder({
        ...funded,
        builderApproval: {
          maxFeePps: 10_000,
          expiry: BigInt(NOW_MS / 1000 + 90 * 86_400),
          active: true,
        },
      }),
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(['place']);
  });

  it('on, approved below the rate or about to lapse: approves again', async () => {
    for (const builderApproval of [
      { maxFeePps: 5_000, expiry: BigInt(NOW_MS / 1000 + 90 * 86_400), active: true },
      { maxFeePps: 10_000, expiry: BigInt(NOW_MS / 1000 + 3600), active: true },
    ]) {
      const plan = await planKuru(buy(), withBuilder({ ...funded, builderApproval }));
      expect(plan.steps.map((s) => s.kind)).toEqual(['approveBuilder', 'place']);
    }
  });

  it('the approval sits after the deposit, and a buy reserves the Sente fee too', async () => {
    const plan = await planKuru(buy(), withBuilder());
    expect(plan.steps.map((s) => s.kind)).toEqual([
      'approve',
      'deposit',
      'approveBuilder',
      'place',
    ]);
    // 10 USDC notional * (1 + 0.0004 maker + 0.001 Sente) = 10.014 USDC.
    expect(plan.summary['deposit']).toBe('10.014');
  });

  it('atomic batch: one execute carrying all four legs', async () => {
    const plan = await planKuru(buy(), withBuilder({}, true));
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.calls).toHaveLength(4);
  });

  it('the summary carries the fee for the ticket: 0.10% of 10 USDC is 0.01 USDC', async () => {
    const plan = await planKuru(buy(), withBuilder(funded));
    expect(plan.summary).toMatchObject({
      senteFeeBps: '10',
      senteFeePps: '10000',
      senteFee: '0.01',
      senteFeeAsset: 'USDC',
    });
  });

  it('cancels and withdrawals carry no builder anything', async () => {
    const cancel = await planKuru(
      {
        kind: 'kuru.cancel',
        clientTradeId: CLIENT_TRADE_ID,
        market: MON_USDC.address,
        orderId: '3:9',
      },
      withBuilder({ accountId: 7n, liveOrderId: 9n }),
    );
    expect(cancel.steps.map((s) => s.kind)).toEqual(['cancel']);
    expect(cancel.summary['senteFee']).toBeUndefined();
  });
});
