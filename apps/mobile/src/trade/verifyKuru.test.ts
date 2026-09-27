/**
 * Kuru policy verifier tests (SEN-93, plan M-T10). Plain node, no device, no
 * network.
 *
 * Accepted fixtures are built with `@sente/venues/kuru` — the server's own
 * encoders — so a pass means the phone accepts what the server actually
 * sends. Then one tampered trade per rule: each is a way a buggy or
 * compromised server could have got a blind signature, and does not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cancelOrderCall,
  depositCalls,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  placeOrderCall,
  toClientOrderId,
  withdrawCall,
  type KuruMarketParams,
} from '@sente/venues/kuru';
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';

import type { AuthorizationPayload } from '../auth/deviceKey.ts';
import { encodeKernelExecute, type Erc7579Call } from '../wallet/batch.ts';
import { tradeIdempotencyKey } from './envelope.ts';
import { KURU_LEG_ABI } from './kuruLegs.ts';
import { depositCapAtoms, worstPriceUnits, type MarketFacts } from './kuruMarket.ts';
import type {
  KuruCancelIntent,
  KuruPlaceIntent,
  KuruWithdrawIntent,
  PreparedStep,
  StepKind,
} from './types.ts';
import { verifyKuruTrade, type KuruVerifyContext, type KuruVerifyResult } from './verifyKuru.ts';

const WALLET_ID = 'wallet00000000000000test';
const WALLET = getAddress('0x7777777777777777777777777777777777777777');
const TRADE_ID = '4b1c2f3e-8d6a-4c3b-9e2f-1a2b3c4d5e6f';
const ACCOUNT_CORE = KURU_TESTNET_CONTRACTS.accountCore;
const USDC = KURU_TESTNET_TOKENS.USDC;
const MON = KURU_TESTNET_TOKENS.MON;
const WETH = KURU_TESTNET_TOKENS.WETH;
const MON_USDC = KURU_TESTNET_MARKETS[0]!;
const WETH_USDC = KURU_TESTNET_MARKETS[1]!;
const STRANGER = getAddress('0x1111111111111111111111111111111111111111');
const CLIENT_ORDER_ID = toClientOrderId(TRADE_ID);

/**
 * The phone's own read of MON-USDC. Tick 10 (not the config's 1) so an
 * off-tick price is expressible.
 */
const PARAMS: KuruMarketParams = {
  pricePrecision: MON_USDC.pricePrecision,
  sizePrecision: MON_USDC.sizePrecision,
  tickSize: 10n,
  minQuoteNotional: 1_000_000n,
  maxQuoteNotional: 10n ** 15n,
  takerFeePps: 3_000n,
  makerFeePps: 1_000n,
};
const FACTS: MarketFacts = { params: PARAMS, bestBid: 3_490_000n, bestAsk: 3_500_000n };
const SLIPPAGE_BPS = 50;

const SIZE = 1_000_000_000n; // 10 MON
const LIMIT_PRICE = 3_400_000n; // 3.40 USDC
const BUY_CAP = depositCapAtoms(
  { side: 'buy', price: LIMIT_PRICE, quantity: SIZE, tif: 'gtc' },
  PARAMS,
  { quote: 6, base: 18 },
);
const SELL_WORST = worstPriceUnits(3_490_000n, SLIPPAGE_BPS, 10n, 'sell');
const SELL_CAP = depositCapAtoms(
  { side: 'sell', price: SELL_WORST, quantity: SIZE, tif: 'ioc' },
  PARAMS,
  { quote: 6, base: 18 },
);

const BUY_LIMIT: KuruPlaceIntent = {
  kind: 'kuru.place',
  clientTradeId: TRADE_ID,
  market: MON_USDC.address,
  side: 'buy',
  orderType: 'limit',
  sizeAtoms: SIZE.toString(),
  priceUnits: LIMIT_PRICE.toString(),
  maxDepositAtoms: BUY_CAP.toString(),
};
const SELL_MARKET: KuruPlaceIntent = {
  ...BUY_LIMIT,
  side: 'sell',
  orderType: 'market',
  priceUnits: SELL_WORST.toString(),
  maxDepositAtoms: SELL_CAP.toString(),
};
const CANCEL: KuruCancelIntent = {
  kind: 'kuru.cancel',
  clientTradeId: TRADE_ID,
  market: MON_USDC.address,
  orderId: '7:123456',
};
const WITHDRAW: KuruWithdrawIntent = {
  kind: 'kuru.withdraw',
  clientTradeId: TRADE_ID,
  token: USDC.address,
  amountAtoms: '25000000',
};

type OrderFields = {
  side: number;
  quantity: bigint;
  price: bigint;
  tif: number;
  executionInstruction: number;
  minSizeAfterBlock: bigint;
};
const BUY_ORDER: OrderFields = {
  side: 0,
  quantity: SIZE,
  price: LIMIT_PRICE,
  tif: 0,
  executionInstruction: 0,
  minSizeAfterBlock: 0n,
};
const SELL_ORDER: OrderFields = { ...BUY_ORDER, side: 1, price: SELL_WORST, tif: 1 };

const place = (
  order: Partial<OrderFields> = {},
  base = BUY_ORDER,
  market: Address = MON_USDC.address,
  clientOrderId: Hex | undefined = CLIENT_ORDER_ID,
): Erc7579Call => placeOrderCall(market, { ...base, ...order } as never, clientOrderId);

/** A cancel `batch` with any userId and slots, which no `@sente/venues` builder emits. */
function cancelBatch(userId: number, slots: readonly number[]): Erc7579Call {
  return {
    to: MON_USDC.address,
    value: 0n,
    data: encodeFunctionData({
      abi: [KURU_LEG_ABI[3]],
      functionName: 'batch',
      args: [userId, [], slots as number[]],
    }),
  };
}

/** `batch` with a userId other than 0, which no `@sente/venues` builder emits. */
function placeAsUser(userId: number): Erc7579Call {
  return {
    to: MON_USDC.address,
    value: 0n,
    data: encodeFunctionData({
      abi: [KURU_LEG_ABI[4]],
      functionName: 'batch',
      args: [userId, [{ ...BUY_ORDER, minSizeAfterBlock: 0 } as never], [], CLIENT_ORDER_ID],
    }),
  };
}

const usdcFunding = (amount = BUY_CAP): Erc7579Call[] => depositCalls(ACCOUNT_CORE, USDC, amount);
const monFunding = (amount = SELL_CAP): Erc7579Call[] => depositCalls(ACCOUNT_CORE, MON, amount);

/**
 * What the server signs for one step: `sponsoredSendBody(sponsoredCallTransaction(...))`
 * with this step's idempotency key. One call goes straight to its target;
 * several go through the wallet's own `execute` (atomic batch).
 */
function payload(index: number, calls: readonly Erc7579Call[]): AuthorizationPayload {
  const [first] = calls;
  assert.ok(first);
  const direct = calls.length === 1;
  const value = direct ? (first.value ?? 0n) : 0n;
  return {
    version: 1,
    method: 'POST',
    url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
    headers: {
      'privy-app-id': 'app-id-test',
      'privy-idempotency-key': tradeIdempotencyKey(TRADE_ID, index),
    },
    body: {
      method: 'eth_sendTransaction',
      caip2: 'eip155:10143',
      sponsor: true,
      params: {
        transaction: {
          to: getAddress(direct ? first.to : WALLET),
          data: direct ? (first.data ?? '0x') : encodeKernelExecute(calls),
          ...(value > 0n ? { value: `0x${value.toString(16)}` } : {}),
          chain_id: 10143,
        },
      },
    },
  };
}

/** One step per call: the default, non-atomic plan. */
function unbatched(calls: readonly Erc7579Call[], kinds: readonly StepKind[]): PreparedStep[] {
  return calls.map((call, index) => ({
    index,
    kind: kinds[index]!,
    title: kinds[index]!,
    payload: payload(index, [call]),
  }));
}

/** Every call in one self-call: `USER_TRADE_ATOMIC_BATCH=1`. */
const atomic = (calls: readonly Erc7579Call[]): PreparedStep[] => [
  { index: 0, kind: 'batch', title: 'Trade', payload: payload(0, calls) },
];

function ctx(intent: KuruVerifyContext['intent'], extra: Partial<KuruVerifyContext> = {}) {
  return {
    walletId: WALLET_ID,
    wallet: WALLET,
    intent,
    facts: FACTS,
    slippageBps: SLIPPAGE_BPS,
    ...extra,
  };
}

function accepted(result: KuruVerifyResult): void {
  assert.ok(result.ok, result.ok ? '' : `refused at step ${result.stepIndex}: ${result.problem}`);
}

function refused(result: KuruVerifyResult, pattern: RegExp): void {
  assert.equal(result.ok, false, 'expected a refusal');
  if (!result.ok) assert.match(result.problem, pattern);
}

const buyLimitSteps = (placeCall = place(), funding = usdcFunding()): PreparedStep[] =>
  unbatched([...funding, placeCall], ['approve', 'deposit', 'place']);

// ---------------------------------------------------------------------------
// Passing fixtures.

test('a buy limit order, one step per leg, is signable', () => {
  accepted(verifyKuruTrade(buyLimitSteps(), ctx(BUY_LIMIT)));
});

test('the same buy packed into one atomic batch is signable', () => {
  accepted(verifyKuruTrade(atomic([...usdcFunding(), place()]), ctx(BUY_LIMIT)));
});

test('a post-only limit order is signable with executionInstruction 1', () => {
  const steps = buyLimitSteps(place({ executionInstruction: 1 }));
  accepted(verifyKuruTrade(steps, ctx({ ...BUY_LIMIT, postOnly: true })));
});

test('a sell market order funded with native MON is signable', () => {
  const steps = unbatched([...monFunding(), place({}, SELL_ORDER)], ['deposit', 'place']);
  accepted(verifyKuruTrade(steps, ctx(SELL_MARKET)));
});

test('an order the free balance already covers needs only the place step', () => {
  accepted(verifyKuruTrade(unbatched([place()], ['place']), ctx(BUY_LIMIT)));
});

test('a deposit below the cap (a shortfall) is signable', () => {
  accepted(verifyKuruTrade(buyLimitSteps(place(), usdcFunding(1_000_000n)), ctx(BUY_LIMIT)));
});

test('a cancel of the confirmed slot is signable', () => {
  const steps = unbatched([cancelOrderCall(MON_USDC.address, 7)], ['cancel']);
  accepted(verifyKuruTrade(steps, ctx(CANCEL)));
});

test('a withdraw of the confirmed token and amount is signable', () => {
  const steps = unbatched([withdrawCall(ACCOUNT_CORE, USDC, 25_000_000n)], ['withdraw']);
  accepted(verifyKuruTrade(steps, ctx(WITHDRAW)));
});

// ---------------------------------------------------------------------------
// Place: one tampered trade per rule.

test('market: an order to another market is refused', () => {
  const steps = buyLimitSteps(place({}, BUY_ORDER, WETH_USDC.address));
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /another market/);
});

test('market: an intent for a market outside the allow-list is refused', () => {
  refused(
    verifyKuruTrade(buyLimitSteps(), ctx({ ...BUY_LIMIT, market: STRANGER })),
    /not a Kuru market/,
  );
});

test('market: facts read for another market are refused', () => {
  const facts = { ...FACTS, params: { ...PARAMS, pricePrecision: 100n } };
  refused(verifyKuruTrade(buyLimitSteps(), ctx(BUY_LIMIT, { facts })), /not for this market/);
});

test('userId: an order for another Kuru account is refused', () => {
  refused(verifyKuruTrade(buyLimitSteps(placeAsUser(1)), ctx(BUY_LIMIT)), /Kuru account 1/);
});

test('side: an order on the other side is refused', () => {
  refused(verifyKuruTrade(buyLimitSteps(place({ side: 1 })), ctx(BUY_LIMIT)), /wrong side/);
});

test('size: a different quantity is refused', () => {
  const steps = buyLimitSteps(place({ quantity: SIZE + 1n }));
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /size/);
});

test('price: a limit price other than the confirmed one is refused', () => {
  const steps = buyLimitSteps(place({ price: LIMIT_PRICE + 10n }));
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /price/);
});

test('price: a limit price off the phone-read tick is refused', () => {
  const intent = { ...BUY_LIMIT, priceUnits: (LIMIT_PRICE + 5n).toString() };
  const steps = buyLimitSteps(place({ price: LIMIT_PRICE + 5n }));
  refused(verifyKuruTrade(steps, ctx(intent)), /tick/);
});

test('price: a market order wider than the phone-computed worst price is refused', () => {
  const steps = unbatched(
    [...monFunding(), place({ price: SELL_WORST - 10n }, SELL_ORDER)],
    ['deposit', 'place'],
  );
  refused(verifyKuruTrade(steps, ctx(SELL_MARKET)), /price/);
});

test('price: a market order whose confirmed price the fresh read disagrees with is refused', () => {
  const facts = { ...FACTS, bestBid: 3_000_000n };
  const steps = unbatched([...monFunding(), place({}, SELL_ORDER)], ['deposit', 'place']);
  refused(verifyKuruTrade(steps, ctx(SELL_MARKET, { facts })), /price moved/);
});

test('price: a market order against an empty book side is refused', () => {
  const facts = { ...FACTS, bestBid: null };
  const steps = unbatched([...monFunding(), place({}, SELL_ORDER)], ['deposit', 'place']);
  refused(verifyKuruTrade(steps, ctx(SELL_MARKET, { facts })), /no one to sell/);
});

test('price: a market order without a slippage setting is refused', () => {
  const steps = unbatched([...monFunding(), place({}, SELL_ORDER)], ['deposit', 'place']);
  const context = { ...ctx(SELL_MARKET), slippageBps: undefined };
  refused(verifyKuruTrade(steps, context), /slippage/);
});

test('tif: a market order that could rest (GTC) is refused', () => {
  const steps = unbatched([...monFunding(), place({ tif: 0 }, SELL_ORDER)], ['deposit', 'place']);
  refused(verifyKuruTrade(steps, ctx(SELL_MARKET)), /could rest/);
});

test('tif: a limit order sent as IOC is refused', () => {
  refused(verifyKuruTrade(buyLimitSteps(place({ tif: 1 })), ctx(BUY_LIMIT)), /would not rest/);
});

test('tif: a FOK order is refused', () => {
  refused(verifyKuruTrade(buyLimitSteps(place({ tif: 2 })), ctx(BUY_LIMIT)), /rest/);
});

test('post-only: a confirmed post-only order sent without it is refused', () => {
  refused(verifyKuruTrade(buyLimitSteps(), ctx({ ...BUY_LIMIT, postOnly: true })), /not post-only/);
});

test('post-only: a post-only order the user did not ask for is refused', () => {
  const steps = buyLimitSteps(place({ executionInstruction: 1 }));
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /did not ask/);
});

test('post-only: a post-only market intent is refused', () => {
  const steps = unbatched([...monFunding(), place({}, SELL_ORDER)], ['deposit', 'place']);
  refused(verifyKuruTrade(steps, ctx({ ...SELL_MARKET, postOnly: true })), /post-only/);
});

test('minSizeAfterBlock: a non-zero minimum is refused', () => {
  const steps = buyLimitSteps(place({ minSizeAfterBlock: 5n }));
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /minimum size/);
});

test('clientOrderId: an order tagged for another trade is refused', () => {
  const other = toClientOrderId('9b1c2f3e-8d6a-4c3b-9e2f-1a2b3c4d5e6f');
  const steps = buyLimitSteps(place({}, BUY_ORDER, MON_USDC.address, other));
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /another trade/);
});

test('clientOrderId: an order with no client order id is refused', () => {
  // The 3-argument `batch` overload: no client order id at all.
  const steps = buyLimitSteps(placeOrderCall(MON_USDC.address, BUY_ORDER as never));
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /no client order id/);
});

test('approve != deposit: a larger approval is refused', () => {
  const [approve] = usdcFunding(BUY_CAP + 1n);
  const [, deposit] = usdcFunding();
  const steps = buyLimitSteps(place(), [approve!, deposit!]);
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /not exactly the deposit/);
});

test('approve without a deposit is refused', () => {
  const [approve] = usdcFunding();
  const steps = unbatched([approve!, place()], ['approve', 'place']);
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /not followed by a deposit/);
});

test('an ERC-20 deposit without its approval is refused', () => {
  const [, deposit] = usdcFunding();
  const steps = unbatched([deposit!, place()], ['deposit', 'place']);
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /no approval/);
});

test('a deposit of the wrong token is refused', () => {
  const steps = unbatched([...monFunding(BUY_CAP), place()], ['deposit', 'place']);
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /not USDC/);
});

test('deposit > cap: one atom over the phone-computed reserve is refused', () => {
  const intent = { ...BUY_LIMIT, maxDepositAtoms: (BUY_CAP * 2n).toString() };
  const steps = buyLimitSteps(place(), usdcFunding(BUY_CAP + 1n));
  refused(verifyKuruTrade(steps, ctx(intent)), /more than the order needs/);
});

test('deposit > cap: over the intent’s tighter cap is refused', () => {
  const intent = { ...BUY_LIMIT, maxDepositAtoms: '1000000' };
  refused(verifyKuruTrade(buyLimitSteps(), ctx(intent)), /more than the order needs/);
});

test('extra leg: a withdrawal after the order is refused', () => {
  const steps = unbatched(
    [...usdcFunding(), place(), withdrawCall(ACCOUNT_CORE, USDC, 1n)],
    ['approve', 'deposit', 'place', 'withdraw'],
  );
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /withdraw leg after the order/);
});

test('extra leg: a second order in the atomic batch is refused', () => {
  refused(
    verifyKuruTrade(atomic([...usdcFunding(), place(), place()]), ctx(BUY_LIMIT)),
    /place leg after the order/,
  );
});

test('extra leg: a cancel in a place trade is refused', () => {
  const steps = unbatched([cancelOrderCall(MON_USDC.address, 7), place()], ['cancel', 'place']);
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /cancel leg is where the order should be/);
});

test('wrong order: deposit before approve is refused', () => {
  const [approve, deposit] = usdcFunding();
  const steps = unbatched([deposit!, approve!, place()], ['deposit', 'approve', 'place']);
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /approve leg is where the order should be/);
});

test('wrong order: funding after the order is refused', () => {
  const steps = unbatched([place(), ...usdcFunding()], ['place', 'approve', 'deposit']);
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /after the order/);
});

test('non-zero value: MON sent with the order is refused', () => {
  const steps = buyLimitSteps({ ...place(), value: 1n });
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /carries value/);
});

test('non-zero value: MON sent with an ERC-20 deposit is refused', () => {
  const [approve, deposit] = usdcFunding();
  const steps = buyLimitSteps(place(), [approve!, { ...deposit!, value: 1n }]);
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /also sends MON/);
});

test('the trade never placing an order is refused', () => {
  refused(
    verifyKuruTrade(unbatched(usdcFunding(), ['approve', 'deposit']), ctx(BUY_LIMIT)),
    /never places/,
  );
});

test('a place without the phone’s market facts is refused', () => {
  refused(
    verifyKuruTrade(buyLimitSteps(), { ...ctx(BUY_LIMIT), facts: undefined }),
    /not read this market/,
  );
});

// SEN-132: the funding rules below survived mutation testing (test audit
// 2026-09-27, §2A). Each test pins the reason, so a different rule refusing
// the same trade by accident does not count as coverage.

test('approve on another token: a WETH approval funding a USDC deposit is refused', () => {
  // Money-bearing: it would leave a standing WETH allowance to AccountCore.
  const [approve] = depositCalls(ACCOUNT_CORE, WETH, BUY_CAP);
  const [, deposit] = usdcFunding();
  const steps = buyLimitSteps(place(), [approve!, deposit!]);
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /approval is for 0x[0-9a-fA-F]{40}, not USDC/);
});

test('native deposit: a MON deposit accompanied by an approval is refused', () => {
  const [approve] = usdcFunding(SELL_CAP);
  const steps = unbatched(
    [approve!, ...monFunding(), place({}, SELL_ORDER)],
    ['approve', 'deposit', 'place'],
  );
  refused(verifyKuruTrade(steps, ctx(SELL_MARKET)), /MON deposit needs no approval/);
});

test('deposit cap: a malformed maxDepositAtoms is refused', () => {
  refused(
    verifyKuruTrade(buyLimitSteps(), ctx({ ...BUY_LIMIT, maxDepositAtoms: '01' })),
    /deposit cap is not an amount/,
  );
});

test('deposit cap: a malformed maxDepositAtoms is refused even with no deposit', () => {
  // Fail closed on the intent itself, not only when a deposit happens to read it.
  const steps = unbatched([place()], ['place']);
  refused(
    verifyKuruTrade(steps, ctx({ ...BUY_LIMIT, maxDepositAtoms: '01' })),
    /deposit cap is not an amount/,
  );
});

test('side: an intent with an unknown side is refused', () => {
  // Without the check, 'x' falls through to the sell branch and signs a sell.
  const steps = unbatched([...monFunding(), place({}, SELL_ORDER)], ['deposit', 'place']);
  refused(
    verifyKuruTrade(steps, ctx({ ...SELL_MARKET, side: 'x' as never })),
    /the order has no side/,
  );
});

// ---------------------------------------------------------------------------
// Steps and envelopes.

test('a step whose index is not its position is refused', () => {
  const steps = buyLimitSteps();
  steps[1] = { ...steps[1]!, index: 2 };
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /claims to be step 2/);
});

test('steps swapped with their idempotency keys still fail the sequence', () => {
  const steps = buyLimitSteps();
  // Keys follow the position, so the server cannot reorder by relabelling.
  const swapped = [steps[1]!, steps[0]!, steps[2]!].map((s, index) => ({ ...s, index }));
  refused(verifyKuruTrade(swapped, ctx(BUY_LIMIT)), /idempotency key/);
});

test('a step mislabelled for the progress UI is refused', () => {
  const steps = buyLimitSteps();
  steps[2] = { ...steps[2]!, kind: 'approve' };
  refused(verifyKuruTrade(steps, ctx(BUY_LIMIT)), /labelled approve but it is place/);
});

test('an envelope for another wallet is refused', () => {
  refused(
    verifyKuruTrade(buyLimitSteps(), { ...ctx(BUY_LIMIT), walletId: 'someone-else' }),
    /not from your wallet/,
  );
});

test('a trade id that is not a UUID is refused', () => {
  refused(verifyKuruTrade(buyLimitSteps(), ctx({ ...BUY_LIMIT, clientTradeId: 'x:1' })), /UUID/);
});

test('an empty trade is refused', () => {
  refused(verifyKuruTrade([], ctx(BUY_LIMIT)), /no steps/);
});

test('a malformed size in the intent is refused', () => {
  refused(verifyKuruTrade(buyLimitSteps(), ctx({ ...BUY_LIMIT, sizeAtoms: '01' })), /size/);
});

// ---------------------------------------------------------------------------
// Cancel.

test('cancel: another slot is refused', () => {
  const steps = unbatched([cancelOrderCall(MON_USDC.address, 8)], ['cancel']);
  refused(verifyKuruTrade(steps, ctx(CANCEL)), /slot 8, not 7/);
});

test('cancel: another market is refused', () => {
  const steps = unbatched([cancelOrderCall(WETH_USDC.address, 7)], ['cancel']);
  refused(verifyKuruTrade(steps, ctx(CANCEL)), /another market/);
});

test('cancel: a second cancel step is refused', () => {
  const steps = unbatched(
    [cancelOrderCall(MON_USDC.address, 7), cancelOrderCall(MON_USDC.address, 8)],
    ['cancel', 'cancel'],
  );
  refused(verifyKuruTrade(steps, ctx(CANCEL)), /extra cancel leg/);
});

test('cancel: a malformed order id is refused', () => {
  const steps = unbatched([cancelOrderCall(MON_USDC.address, 7)], ['cancel']);
  refused(verifyKuruTrade(steps, ctx({ ...CANCEL, orderId: '7' })), /not a Kuru order id/);
});

test('cancel: an order placed instead is refused', () => {
  refused(verifyKuruTrade(unbatched([place()], ['place']), ctx(CANCEL)), /does not cancel/);
});

test('cancel: a batch cancelling the confirmed slot and another is refused', () => {
  // SEN-132, money-bearing: slot 8 is a second resting order the user never chose.
  const steps = unbatched([cancelBatch(0, [7, 8])], ['cancel']);
  refused(verifyKuruTrade(steps, ctx(CANCEL)), /slot 7, 8, not 7/);
});

test('cancel: a cancel for another Kuru account is refused', () => {
  const steps = unbatched([cancelBatch(1, [7])], ['cancel']);
  refused(verifyKuruTrade(steps, ctx(CANCEL)), /cancel acts for Kuru account 1, not yours/);
});

// ---------------------------------------------------------------------------
// Withdraw.

test('withdraw: another token is refused', () => {
  const steps = unbatched([withdrawCall(ACCOUNT_CORE, MON, 25_000_000n)], ['withdraw']);
  refused(verifyKuruTrade(steps, ctx(WITHDRAW)), /not the token you chose/);
});

test('withdraw: another amount is refused', () => {
  const steps = unbatched([withdrawCall(ACCOUNT_CORE, USDC, 25_000_001n)], ['withdraw']);
  refused(verifyKuruTrade(steps, ctx(WITHDRAW)), /not the amount you chose/);
});

test('withdraw: an extra leg is refused', () => {
  const steps = atomic([
    withdrawCall(ACCOUNT_CORE, USDC, 25_000_000n),
    withdrawCall(ACCOUNT_CORE, MON, 1n),
  ]);
  refused(verifyKuruTrade(steps, ctx(WITHDRAW)), /extra withdraw leg/);
});

test('withdraw: a zero amount in the intent is refused', () => {
  const steps = unbatched([withdrawCall(ACCOUNT_CORE, USDC, 25_000_000n)], ['withdraw']);
  refused(
    verifyKuruTrade(steps, ctx({ ...WITHDRAW, amountAtoms: '0' })),
    /withdrawal amount is not an amount/,
  );
});
