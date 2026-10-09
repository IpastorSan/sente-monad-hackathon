/**
 * Turns a confirmed Kuru intent into the steps the phone will sign (SEN-95,
 * plan M-T12, "Architecture §2").
 *
 * The planner only composes; it neither signs nor sends. Every call comes from
 * the same `@sente/venues/kuru` builders an agent's order goes through
 * (`KuruVenue.limitOrderCalls` / `marketOrderCalls`, `depositCalls`,
 * `cancelOrderCall`, `withdrawCall`), read through a read-only `KuruVenue`
 * whose account is the user's Privy wallet — for a user, the wallet itself is
 * the AccountCore root (plan §2; CLAUDE.md gotcha 9 predates SEN-40).
 *
 * The output is shaped for the phone's decoder (SEN-85, plan "Phone checks"),
 * which refuses anything else, so these are rules, not style:
 *
 * - legs run exactly `[approve?, deposit?, approveBuilder?, place]`;
 * - with a Sente builder configured (SEN-184), the place leg is the builder
 *   `batch` overload at exactly that builder and rate, and `approveBuilder`
 *   appears only when the wallet's approval does not cover it, for that
 *   builder, at that rate, expiring in `BUILDER_APPROVAL_SECONDS` (a year);
 * - `approve` is for the deposit amount exactly — never unlimited;
 * - a transaction carries `value` only for a native-MON deposit;
 * - `clientOrderId == keccak256(utf8(clientTradeId))`;
 * - with `atomicBatch`, the legs are one self-call `execute(mode, calls)` on
 *   the wallet, encoded by `permissionless`'s ERC-7579 encoder: batch mode for
 *   two or more legs, single mode for one, revert-on-failure always (gotcha 8).
 *
 * Only the SHORTFALL is deposited — reserve minus what is already free in the
 * Kuru account — so selling MON bought on Kuru needs no deposit at all.
 *
 * Erasable syntax and `.ts` specifiers (gotcha 10), like the trade store, so a
 * live probe can load it under node's type stripping.
 */

import {
  BUILDER_APPROVAL_SECONDS,
  builderFeeAtoms,
  depositCalls,
  encodeNativeOrder,
  fromUnits,
  readKuruFreeAtoms,
  readKuruFreeById,
  readKuruRootId,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KuruVenue,
  NATIVE_TOKEN,
  cancelOrderCall,
  parseOrderId,
  precisionDecimals,
  quoteAtoms,
  quoteReserveAtoms,
  withdrawCall,
  type KuruCall,
  type KuruMarketConfig,
  type KuruMarketParams,
  type KuruOrderRef,
  type KuruContractReader,
  type KuruToken,
} from '@sente/venues/kuru';
import { abi as kuruAbi } from '@toxicflow-labs/ts-sdk';
import { encode7579Calls } from 'permissionless/utils';
import {
  isAddressEqual,
  keccak256,
  parseEther,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { feePpsToBps, type KuruBuilderConfig } from '../fees/kuru-builder.config.ts';
import type { KuruPlaceContext, StepKind } from './trade-store.ts';

/** Plan "Shared wire types". Amounts are decimal strings of integer atoms/units. */
export type KuruPlaceIntent = {
  kind: 'kuru.place';
  /** UUID v4, phone-generated. */
  clientTradeId: string;
  /** OrderBook address. */
  market: Address;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  /** Book size units. */
  sizeAtoms: string;
  /** Limit price, or the phone-computed worst price; must be on tick. */
  priceUnits: string;
  /** Limit only. */
  postOnly?: boolean;
  /** Phone-computed cap for the funding leg, in the funding token's atoms. */
  maxDepositAtoms: string;
};

export type KuruCancelIntent = {
  kind: 'kuru.cancel';
  clientTradeId: string;
  market: Address;
  /** `"<slot>:<orderId>"`. */
  orderId: string;
};

export type KuruWithdrawIntent = {
  kind: 'kuru.withdraw';
  clientTradeId: string;
  token: Address;
  amountAtoms: string;
};

export type KuruIntent = KuruPlaceIntent | KuruCancelIntent | KuruWithdrawIntent;

/**
 * The `params.transaction` a step's sponsored send carries (before M-T5's
 * checksumming): `value` is present only for a native deposit sent directly.
 */
export type PlannedTransaction = {
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
};

export type PlannedStep = {
  readonly kind: StepKind;
  readonly title: string;
  /** The legs, in order. One unless the step is a packed `batch`. */
  readonly calls: readonly KuruCall[];
  /** What the wallet sends for this step. */
  readonly transaction: PlannedTransaction;
};

export type KuruPlan = {
  readonly steps: readonly PlannedStep[];
  /** Render only. Strings, so it is JSON as-is. */
  readonly summary: Record<string, string>;
  /** A place's order and funding, for decoding its receipt later (SEN-97). */
  readonly place?: KuruPlaceContext;
};

export type KuruPlannerDeps = {
  readonly client: PublicClient;
  /** The user's Privy wallet: the transaction sender and the Kuru account. */
  readonly wallet: Address;
  /** `TradeConfig.atomicBatch` — pack every leg into one self-call. */
  readonly atomicBatch: boolean;
  /** Sente's Kuru builder fee (SEN-184); absent or `null`, orders carry none. */
  readonly builder?: KuruBuilderConfig | null;
  /** The clock a builder approval's expiry is set from, ms. Defaults to `Date.now`. */
  readonly now?: () => number;
};

/**
 * Why a plan was refused. The first four are the plan's API refusal reasons;
 * `invalid_intent` (malformed numbers, off-tick price, post-only market order,
 * above the market maximum), `deposit_cap_exceeded` (the shortfall is more
 * than the phone agreed to fund) and `insufficient_balance` (a withdraw of
 * more than is free) are the planner's own, for M-T14 to map.
 */
export type KuruPlanRefusalReason =
  | 'market_not_allowed'
  | 'below_min_notional'
  | 'reserve_balance'
  | 'already_terminal'
  | 'invalid_intent'
  | 'deposit_cap_exceeded'
  | 'insufficient_balance';

export class KuruPlanRefusedError extends Error {
  readonly reason: KuruPlanRefusalReason;

  // Assigned in the body, not a parameter property: erasable syntax only.
  constructor(reason: KuruPlanRefusalReason, message: string) {
    super(message);
    this.name = 'KuruPlanRefusedError';
    this.reason = reason;
  }
}

/**
 * Monad's reserve balance (gotcha 12). A delegated wallet — and every user
 * wallet is, after its first sponsored send — can never drop below it, so a
 * native deposit that would take it there reverts on chain, gas charged.
 */
export const MONAD_RESERVE_WEI = parseEther('10');

const UINT32_MAX = 2n ** 32n - 1n;
const UINT96_MAX = 2n ** 96n - 1n;

export async function planKuru(intent: KuruIntent, deps: KuruPlannerDeps): Promise<KuruPlan> {
  switch (intent.kind) {
    case 'kuru.place':
      return planPlace(intent, deps);
    case 'kuru.cancel':
      return planCancel(intent, deps);
    case 'kuru.withdraw':
      return planWithdraw(intent, deps);
  }
}

/** The `clientOrderId` the phone requires: keccak256 of the id's UTF-8 bytes. */
export function kuruClientOrderId(clientTradeId: string): Hex {
  // Not `toClientOrderId`: that passes a 32-byte hex id through unhashed, and
  // the phone checks the hash unconditionally.
  return keccak256(toBytes(clientTradeId));
}

async function planPlace(intent: KuruPlaceIntent, deps: KuruPlannerDeps): Promise<KuruPlan> {
  const market = allowedMarket(intent.market);
  const quantity = positiveAtoms(intent.sizeAtoms, 'sizeAtoms');
  const price = positiveAtoms(intent.priceUnits, 'priceUnits');
  if (intent.side !== 'buy' && intent.side !== 'sell') {
    throw new KuruPlanRefusedError('invalid_intent', `side "${String(intent.side)}" is unknown`);
  }
  if (intent.orderType !== 'market' && intent.orderType !== 'limit') {
    throw new KuruPlanRefusedError('invalid_intent', 'orderType must be market or limit');
  }
  if (intent.postOnly && intent.orderType === 'market') {
    throw new KuruPlanRefusedError('invalid_intent', 'a market order cannot be post-only');
  }
  const maxDeposit = atoms(intent.maxDepositAtoms, 'maxDepositAtoms');

  const builder = deps.builder ?? undefined;
  const venue = new KuruVenue({
    publicClient: deps.client,
    account: deps.wallet,
    ...(deps.now ? { now: deps.now } : {}),
    ...(builder
      ? {
          builder: { ...builder, approvalExpiry: { ttlSeconds: BUILDER_APPROVAL_SECONDS } },
        }
      : {}),
  });
  // Independent reads, in parallel: the approval needs only the wallet.
  const [params, approvalCalls] = await Promise.all([
    venue.marketParams(market.symbol),
    venue.builderApprovalCalls(),
  ]);

  // Checked here rather than left to `encodeNativeOrder` so each refusal has
  // its own reason; the adapter then re-checks the same things when encoding.
  if (price > UINT32_MAX || price % params.tickSize !== 0n) {
    throw new KuruPlanRefusedError('invalid_intent', `price ${price} is not on a tick`);
  }
  if (quantity > UINT96_MAX) {
    throw new KuruPlanRefusedError('invalid_intent', 'size is outside the market range');
  }
  const notional = quoteAtoms(price, quantity, params, market.quote.decimals);
  if (notional < params.minQuoteNotional) {
    throw new KuruPlanRefusedError(
      'below_min_notional',
      `notional ${fromUnits(notional, market.quote.decimals)} ${market.quote.symbol} is below ` +
        `the market minimum of ${fromUnits(params.minQuoteNotional, market.quote.decimals)}`,
    );
  }
  if (notional > params.maxQuoteNotional) {
    throw new KuruPlanRefusedError('invalid_intent', 'notional is above the market maximum');
  }

  const priceDecimal = fromUnits(price, precisionDecimals(params.pricePrecision));
  const sizeDecimal = fromUnits(quantity, precisionDecimals(params.sizePrecision));
  const clientOrderId = kuruClientOrderId(intent.clientTradeId);
  const timeInForce = intent.orderType === 'market' ? 'IOC' : intent.postOnly ? 'POST_ONLY' : 'GTC';
  const request = { symbol: market.symbol, side: intent.side, size: sizeDecimal, clientOrderId };
  const [place] =
    intent.orderType === 'market'
      ? await venue.marketOrderCalls({ ...request, slippageLimitPrice: priceDecimal })
      : await venue.limitOrderCalls({ ...request, price: priceDecimal, timeInForce });
  if (!place) throw new Error('KuruVenue returned no place call');

  const order = encodeNativeOrder(
    { side: intent.side, price: priceDecimal, size: sizeDecimal, timeInForce },
    params,
    market.quote.decimals,
  );
  const token = intent.side === 'buy' ? market.quote : market.base;
  // Maker rate for a resting GTC (Kuru locks maker-fee headroom: the
  // 10 -> 10.004 USDC observation in docs/kuru.md), taker for an IOC. The
  // phone's deposit cap (M-T8) is sized the same way, so both agree.
  // The Sente fee is headroom on top (SEN-184): a buy sets it aside too, and
  // the phone's cap adds the same pinned rate, so the two still agree.
  const venueFeePps = intent.orderType === 'market' ? params.takerFeePps : params.makerFeePps;
  const feePps = venueFeePps + BigInt(builder?.feePps ?? 0);
  const reserve =
    intent.side === 'buy'
      ? quoteReserveAtoms(order, params, market.quote.decimals, feePps)
      : baseReserveAtoms(quantity, params, market.base.decimals);

  const free = await kuruFree(deps, token);
  const shortfall = reserve > free ? reserve - free : 0n;
  if (shortfall > maxDeposit) {
    throw new KuruPlanRefusedError(
      'deposit_cap_exceeded',
      `the order needs ${fromUnits(shortfall, token.decimals)} ${token.symbol} deposited, ` +
        `more than the confirmed ${fromUnits(maxDeposit, token.decimals)}`,
    );
  }
  if (shortfall > 0n && isAddressEqual(token.address, NATIVE_TOKEN)) {
    const balance = await deps.client.getBalance({ address: deps.wallet });
    if (balance - shortfall < MONAD_RESERVE_WEI) {
      throw new KuruPlanRefusedError(
        'reserve_balance',
        `depositing ${fromUnits(shortfall, 18)} MON would leave the wallet under Monad's ` +
          '10 MON reserve',
      );
    }
  }

  const verb = intent.side === 'buy' ? 'Buy' : 'Sell';
  const placeTitle = `${verb} ${sizeDecimal} ${market.base.symbol} at ${priceDecimal} ${market.quote.symbol}`;
  const legs: { kind: StepKind; title: string; call: KuruCall }[] = [];
  if (shortfall > 0n) {
    const amount = `${fromUnits(shortfall, token.decimals)} ${token.symbol}`;
    // `depositCalls` is `[approve, deposit]` for an ERC-20 (approve for the
    // exact amount) and `[deposit]` with `value` for native MON.
    // `deposit(rootOwner, …)` credits the root it names: the wallet itself.
    const funding = depositCalls(KURU_TESTNET_CONTRACTS.accountCore, token, shortfall, deps.wallet);
    const deposit = funding[funding.length - 1]!;
    if (funding.length === 2) {
      legs.push({ kind: 'approve', title: `Approve ${amount} for Kuru`, call: funding[0]! });
    }
    legs.push({ kind: 'deposit', title: `Deposit ${amount} to Kuru`, call: deposit });
  }
  // After the deposit, which registers a first-time account in AccountCore.
  const [approveBuilder] = approvalCalls;
  if (builder && approveBuilder) {
    legs.push({
      kind: 'approveBuilder',
      title: `Allow Sente’s ${feePpsToBps(builder.feePps)} bps fee on Kuru`,
      call: approveBuilder,
    });
  }
  legs.push({ kind: 'place', title: placeTitle, call: place });

  return {
    steps: packSteps(legs, deps, `${shortfall > 0n ? 'Fund and ' : ''}${placeTitle}`),
    summary: {
      market: market.symbol,
      side: intent.side,
      orderType: intent.orderType,
      timeInForce,
      size: sizeDecimal,
      price: priceDecimal,
      notional: fromUnits(notional, market.quote.decimals),
      fundingToken: token.symbol,
      reserve: fromUnits(reserve, token.decimals),
      kuruFree: fromUnits(free, token.decimals),
      deposit: fromUnits(shortfall, token.decimals),
      feePps: venueFeePps.toString(),
      ...(builder ? senteFeeSummary(builder, notional, market.quote) : {}),
    },
    place: {
      market: market.address,
      symbol: market.symbol,
      side: intent.side,
      orderType: intent.orderType,
      timeInForce,
      quantity,
      price: priceDecimal,
      params,
      quoteDecimals: market.quote.decimals,
      funding: { symbol: token.symbol, decimals: token.decimals, deposit: shortfall },
      ...(builder ? { builder: { address: builder.address, feePps: builder.feePps } } : {}),
    },
  };
}

/**
 * The Sente fee as the ticket shows it (SEN-184): "Sente fee 0.10% (≈ 0.02
 * USDC)". An estimate on the whole notional, rounded up: a resting order that
 * never takes may pay less, never more.
 */
export function senteFeeSummary(
  builder: KuruBuilderConfig,
  notionalAtoms: bigint,
  quote: Pick<KuruToken, 'symbol' | 'decimals'>,
): Record<string, string> {
  return {
    senteFeeBps: feePpsToBps(builder.feePps),
    senteFeePps: String(builder.feePps),
    senteFee: fromUnits(builderFeeAtoms(notionalAtoms, builder.feePps), quote.decimals),
    senteFeeAsset: quote.symbol,
  };
}

async function planCancel(intent: KuruCancelIntent, deps: KuruPlannerDeps): Promise<KuruPlan> {
  const market = allowedMarket(intent.market);
  let ref: KuruOrderRef;
  try {
    ref = parseOrderId(intent.orderId);
  } catch (error) {
    throw new KuruPlanRefusedError('invalid_intent', (error as Error).message);
  }

  // The adapter's `cancel` pre-check, minus the submit: slots are reused, so
  // only a slot that still holds THIS order id may be cancelled. Anything else
  // already filled or was cancelled, and a cancel would hit a newer order.
  const venue = new KuruVenue({ publicClient: deps.client, account: deps.wallet });
  const accountId = await venue.accountId();
  if (accountId === 0n) {
    throw new KuruPlanRefusedError('already_terminal', 'this wallet has never traded on Kuru');
  }
  const live = await deps.client.readContract({
    address: market.address,
    abi: kuruAbi.orderBookAbi,
    functionName: 'getOrderId',
    args: [Number(accountId), ref.slotIdx],
  });
  if (BigInt(live) !== ref.orderId) {
    throw new KuruPlanRefusedError(
      'already_terminal',
      `order ${intent.orderId} is no longer resting`,
    );
  }

  const title = `Cancel ${market.symbol} order ${intent.orderId}`;
  return {
    steps: packSteps(
      [{ kind: 'cancel', title, call: cancelOrderCall(market.address, ref.slotIdx) }],
      deps,
      title,
    ),
    summary: { market: market.symbol, orderId: intent.orderId },
  };
}

async function planWithdraw(intent: KuruWithdrawIntent, deps: KuruPlannerDeps): Promise<KuruPlan> {
  const token = kuruTokens().find((t) => isAddressEqual(t.address, intent.token));
  if (!token) {
    throw new KuruPlanRefusedError('market_not_allowed', `${intent.token} is not a Kuru token`);
  }
  const amount = positiveAtoms(intent.amountAtoms, 'amountAtoms');
  // Only free balance can leave; asking for more reverts on chain, where
  // Monad still charges the whole gas limit (gotcha 4). The root id is read
  // once: the free balance is keyed by it, and the withdraw names it (SEN-185).
  const client = deps.client as KuruContractReader;
  const core = KURU_TESTNET_CONTRACTS.accountCore;
  const rootId = await readKuruRootId(client, core, deps.wallet);
  const free = await readKuruFreeById(client, core, rootId, token.address);
  if (amount > free) {
    throw new KuruPlanRefusedError(
      'insufficient_balance',
      `only ${fromUnits(free, token.decimals)} ${token.symbol} is free on Kuru`,
    );
  }
  const shown = `${fromUnits(amount, token.decimals)} ${token.symbol}`;
  const title = `Withdraw ${shown} from Kuru`;
  // Free balance above zero means the wallet has a root; withdraw names it and
  // pays the wallet itself (SEN-185: the recipient is explicit).
  return {
    steps: packSteps(
      [
        {
          kind: 'withdraw',
          title,
          call: withdrawCall(
            KURU_TESTNET_CONTRACTS.accountCore,
            token,
            amount,
            rootId,
            deps.wallet,
          ),
        },
      ],
      deps,
      title,
    ),
    summary: { token: token.symbol, amount: fromUnits(amount, token.decimals) },
  };
}

/**
 * One step per leg, or — with `atomicBatch` and more than one leg — a single
 * `batch` step whose transaction is the wallet calling its own ERC-7579
 * `execute`. A lone leg is never wrapped: a direct call is what the phone
 * reads most simply, and there is nothing to make atomic.
 *
 * Exported for the phone's cross-side contract test (SEN-125), which repacks
 * tampered legs through this same function so that each refusal it expects is
 * caused by the tamper alone, never by a hand-rolled packing that drifted.
 */
export function packSteps(
  legs: readonly { kind: StepKind; title: string; call: KuruCall }[],
  deps: KuruPlannerDeps,
  batchTitle: string,
): PlannedStep[] {
  if (deps.atomicBatch && legs.length > 1) {
    const calls = legs.map((leg) => leg.call);
    return [
      {
        kind: 'batch',
        title: batchTitle,
        calls,
        // Outer value stays zero: a native deposit leg spends the wallet's own
        // balance from inside `execute`, and the phone accepts `value` only on
        // a direct native deposit.
        transaction: { to: deps.wallet, data: kernelExecute(calls) },
      },
    ];
  }
  return legs.map((leg) => ({
    kind: leg.kind,
    title: leg.title,
    calls: [leg.call],
    transaction: directTransaction(leg.call),
  }));
}

function directTransaction(call: KuruCall): PlannedTransaction {
  const value = call.value ?? 0n;
  return value > 0n
    ? { to: call.to, data: call.data ?? '0x', value }
    : { to: call.to, data: call.data ?? '0x' };
}

/**
 * `execute(bytes32 mode, bytes calls)`: batch mode for several legs, single
 * mode (packed `to‖value‖data`) for one, exactly as the phone's
 * `encodeKernelExecute` re-encodes it. `revertOnError: false` is
 * permissionless's name for exec type `0x00`, which DOES revert the whole
 * batch on a failed leg (see `apps/mobile/src/wallet/batch.ts` on the flag's
 * inverted polarity) — never try mode.
 */
export function kernelExecute(calls: readonly KuruCall[]): Hex {
  return encode7579Calls({
    mode: {
      type: calls.length > 1 ? 'batchcall' : 'call',
      revertOnError: false,
      selector: '0x',
      context: '0x',
    },
    callData: calls.map((call) => ({ to: call.to, value: call.value ?? 0n, data: call.data })),
  });
}

/**
 * Base-token atoms a SELL of `quantity` locks: the size itself, scaled from
 * book size units to the token's decimals and rounded up. No fee term — Kuru
 * charges fees in the quote token (`KuruPlaceResult.feeAsset`), taken from
 * the proceeds. `quoteReserveAtoms` (SEN-84) covers buys only.
 */
export function baseReserveAtoms(
  quantity: bigint,
  params: KuruMarketParams,
  baseDecimals: number,
): bigint {
  const numerator = quantity * 10n ** BigInt(baseDecimals);
  return (numerator + params.sizePrecision - 1n) / params.sizePrecision;
}

function kuruFree(deps: KuruPlannerDeps, token: KuruToken): Promise<bigint> {
  return readKuruFreeAtoms(
    deps.client as KuruContractReader,
    KURU_TESTNET_CONTRACTS.accountCore,
    deps.wallet,
    token.address,
  );
}

function allowedMarket(address: Address): KuruMarketConfig {
  const market = KURU_TESTNET_MARKETS.find((m) => isAddressEqual(m.address, address));
  if (!market) {
    throw new KuruPlanRefusedError('market_not_allowed', `${address} is not an allowed market`);
  }
  return market;
}

function kuruTokens(): KuruToken[] {
  return KURU_TESTNET_MARKETS.flatMap((m) => [m.base, m.quote]);
}

function atoms(raw: string, field: string): bigint {
  if (typeof raw !== 'string' || !/^\d{1,78}$/.test(raw)) {
    throw new KuruPlanRefusedError('invalid_intent', `${field} is not a whole number of atoms`);
  }
  return BigInt(raw);
}

function positiveAtoms(raw: string, field: string): bigint {
  const value = atoms(raw, field);
  if (value === 0n) throw new KuruPlanRefusedError('invalid_intent', `${field} must be positive`);
  return value;
}
