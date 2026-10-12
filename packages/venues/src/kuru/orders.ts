/**
 * What gets signed, and what came back: Kuru order encoding and receipt
 * decoding, with no I/O so `orders.test.ts` can pin both.
 *
 * ---------------------------------------------------------------------------
 * PLACEMENT PATH: THE ACCOUNT CALLS THE ORDERBOOK ITSELF
 *
 * Spot V2 accepts an order two ways:
 *
 *   1. Direct — `OrderBook.batch(userId, orders, cancelSlotIdxs, …)` from any
 *      address holding live TRADE permission on `userId`. `userId = 0` resolves
 *      to the caller's own account, so the account that deposited is the
 *      account that trades and no id has to be known in advance.
 *   2. Relay — a secondary EOA, EIP-7702-delegated to KuruTradingWallet, signs
 *      an EIP-712 intent and `relay.testnet.kuru.io` pays the gas to land it.
 *
 * The Exchange Gateway has no order-entry route; it is read-only.
 *
 * Sente uses (1). The user's on-chain identity is a Kernel smart account and it
 * can be its own AccountCore root: nothing in AccountCore or the OrderBook
 * requires an EOA caller, which was checked by running faucet `claim` ->
 * `approve` -> `deposit` -> `batch` as one Kernel `execute` from the EntryPoint
 * against a deployed Kernel v0.3.1 account. So every Kuru action is just
 * another leg of a Kernel batch, gas-sponsored like everything else. Path (2)
 * puts a 7702 delegation on an EOA, and on Monad a delegated EOA loses the
 * reserve-balance exception and can never drop below 10 MON — see
 * docs/kuru.md for the full trade-off.
 * ---------------------------------------------------------------------------
 */
import {
  abi as kuruAbi,
  buildApproveBuilderRequest,
  buildApproveErc20Request,
  buildBatchRequest,
  decodeBookUpdatesPacked,
  decodeTradesPacked,
  type NativeOrderInput,
} from '@toxicflow-labs/ts-sdk';
import {
  decodeEventLog,
  encodeFunctionData,
  isAddressEqual,
  isHex,
  keccak256,
  size,
  toBytes,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';

import type { Decimal, Side, TimeInForce } from '../types.ts';
import {
  KURU_DEPLOYMENT,
  KURU_FAUCET,
  NATIVE_TOKEN,
  type KuruCustody,
  type KuruToken,
} from './constants.ts';
import { fromUnits, precisionDecimals, toUnits } from './units.ts';

/**
 * One contract call. Structurally identical to `Erc7579Call` in
 * `apps/mobile/src/wallet/batch.ts`, so a `KuruCall[]` is already a Kernel
 * batch — hand it to `encodeKernelExecute` as-is.
 */
export type KuruCall = {
  readonly to: Address;
  readonly value?: bigint;
  readonly data?: Hex;
};

/** `OrderBook.getMarketParams()`, read from the market before anything is signed. */
export type KuruMarketParams = {
  readonly pricePrecision: bigint;
  readonly sizePrecision: bigint;
  readonly tickSize: bigint;
  /** Quote-token atoms. */
  readonly minQuoteNotional: bigint;
  /** Quote-token atoms. */
  readonly maxQuoteNotional: bigint;
  readonly takerFeePps: bigint;
  readonly makerFeePps: bigint;
};

/** Fee rates are parts per ten million: `fee = amount * pps / 10_000_000`. */
export const PPS_DENOMINATOR = 10_000_000n;

const UINT32_MAX = 2n ** 32n - 1n;
const UINT96_MAX = 2n ** 96n - 1n;

export class KuruOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KuruOrderError';
  }
}

/** Decimal price -> book price units. Refuses off-tick prices rather than rounding them. */
export function encodePrice(price: Decimal, params: KuruMarketParams): bigint {
  const raw = toUnits(price, precisionDecimals(params.pricePrecision), 'price');
  if (raw === 0n || raw > UINT32_MAX) {
    throw new KuruOrderError(`price ${price} is outside this market's range`);
  }
  if (raw % params.tickSize !== 0n) {
    throw new KuruOrderError(`price ${price} is not on a tick`);
  }
  return raw;
}

/** Decimal base size -> book size units. */
export function encodeSize(baseSize: Decimal, params: KuruMarketParams): bigint {
  const quantity = toUnits(baseSize, precisionDecimals(params.sizePrecision), 'size');
  if (quantity === 0n || quantity > UINT96_MAX) {
    throw new KuruOrderError(`size ${baseSize} is outside this market's range`);
  }
  return quantity;
}

/** Quote-token atoms for `quantity` at `price`, floored as the contract floors. */
export function quoteAtoms(
  price: bigint,
  quantity: bigint,
  params: KuruMarketParams,
  quoteDecimals: number,
): bigint {
  return (
    (price * quantity * 10n ** BigInt(quoteDecimals)) /
    (params.pricePrecision * params.sizePrecision)
  );
}

/**
 * Quote-token atoms a BUY of `order` needs free in AccountCore: notional plus
 * the fee at `feePps`, rounded up. The planner (SEN-84 → M-T12) deposits the
 * shortfall against this, and short by one atom the whole batch reverts, so
 * the rounding goes the account's way rather than the contract's.
 *
 * `feePps` is the market's maker rate for a resting order — Kuru locks
 * maker-fee headroom, as the 10 → 10.004 USDC observation in docs/kuru.md
 * shows — and the taker rate for an IOC that only takes.
 */
export function quoteReserveAtoms(
  order: NativeOrderInput,
  params: KuruMarketParams,
  quoteDecimals: number,
  feePps: bigint,
): bigint {
  const numerator =
    order.price * order.quantity * 10n ** BigInt(quoteDecimals) * (PPS_DENOMINATOR + feePps);
  const denominator = params.pricePrecision * params.sizePrecision * PPS_DENOMINATOR;
  return (numerator + denominator - 1n) / denominator;
}

/** Kuru has no POST_ONLY time-in-force; it is GTC plus an execution instruction. */
const NATIVE_TIF = { GTC: 'gtc', IOC: 'ioc', FOK: 'fok', POST_ONLY: 'gtc' } as const;

export type OrderInput = {
  readonly side: Side;
  readonly price: Decimal;
  readonly size: Decimal;
  readonly timeInForce?: TimeInForce;
};

/**
 * A Sente order as Kuru's `NativeOrder`.
 *
 * Tick, range and notional are checked here first. The contract remains the
 * authority, but a reverted transaction on Monad still costs its whole gas
 * limit, so an order that cannot pass is cheaper refused locally.
 */
export function encodeNativeOrder(
  input: OrderInput,
  params: KuruMarketParams,
  quoteDecimals: number,
): NativeOrderInput {
  const price = encodePrice(input.price, params);
  const quantity = encodeSize(input.size, params);
  const notional = quoteAtoms(price, quantity, params, quoteDecimals);
  if (notional < params.minQuoteNotional) {
    throw new KuruOrderError(
      `order notional ${fromUnits(notional, quoteDecimals)} is below the market minimum of ` +
        fromUnits(params.minQuoteNotional, quoteDecimals),
    );
  }
  if (notional > params.maxQuoteNotional) {
    throw new KuruOrderError(
      `order notional ${fromUnits(notional, quoteDecimals)} is above the market maximum`,
    );
  }
  const timeInForce = input.timeInForce ?? 'GTC';
  return {
    side: input.side,
    quantity,
    price,
    tif: NATIVE_TIF[timeInForce],
    executionInstruction: timeInForce === 'POST_ONLY' ? 'postOnly' : 'none',
    minSizeAfterBlock: 0n,
  };
}

/**
 * Sente's free-form client order id as Kuru's `bytes32`, which the OrderBook
 * copies into its events. A 32-byte hex id passes through untouched; anything
 * else is hashed, so the echo can still be matched deterministically.
 */
export function toClientOrderId(id: string): Hex {
  return isHex(id, { strict: true }) && size(id) === 32 ? id : keccak256(toBytes(id));
}

type ContractRequest = {
  readonly address: Address;
  readonly abi: Abi | readonly unknown[];
  readonly functionName: string;
  readonly args?: readonly unknown[];
  readonly value?: bigint;
};

function toCall(request: ContractRequest): KuruCall {
  return {
    to: request.address,
    value: request.value ?? 0n,
    data: encodeFunctionData({
      abi: request.abi as Abi,
      functionName: request.functionName,
      args: request.args,
    }),
  };
}

/** The plain `batch` overloads this module encodes: without and with a `clientOrderId`. */
const BATCH_SIGNATURES = new Set(['uint40,tuple[],uint8[]', 'uint40,tuple[],uint8[],bytes32']);

/**
 * The builder-fee `batch` overloads (SEN-184): the same two, plus a trailing
 * `builderConfig(address builder, uint32 feePps)`. Kept apart from
 * {@link BATCH_SIGNATURES} so the ABI every live agent policy already pins
 * stays byte-identical.
 */
const BUILDER_BATCH_SIGNATURES = new Set([
  'uint40,tuple[],uint8[],tuple',
  'uint40,tuple[],uint8[],bytes32,tuple',
]);

function abiFunctions(abi: Abi, keep: (fn: AbiFunction) => boolean): Abi {
  return abi.filter((item): item is AbiFunction => item.type === 'function' && keep(item));
}

/**
 * `OrderBook.batch`, exactly the two overloads `placeOrderCall` and
 * `cancelOrderCall` emit. Exported for `@sente/mandate`, which hands Privy an
 * ABI to decode calldata with; cut from the SDK's own ABI rather than retyped,
 * so the selectors cannot drift from what this module signs.
 */
export const KURU_ORDERBOOK_BATCH_ABI: Abi = abiFunctions(
  kuruAbi.orderBookAbi as Abi,
  (fn) => fn.name === 'batch' && BATCH_SIGNATURES.has(fn.inputs.map((i) => i.type).join(',')),
);

/**
 * `OrderBook.batch`, the two builder-fee overloads only (SEN-184). A policy rule
 * that allows these allows an order that pays SOME builder; AccountCore then
 * refuses any builder the account has not approved (`BuilderApprovalNotFound`)
 * or any rate above the approved maximum (`BuilderFeeTooHigh`), so the
 * `approveBuilder` rule is what pins who is paid and how much.
 */
export const KURU_ORDERBOOK_BUILDER_BATCH_ABI: Abi = abiFunctions(
  kuruAbi.orderBookAbi as Abi,
  (fn) =>
    fn.name === 'batch' && BUILDER_BATCH_SIGNATURES.has(fn.inputs.map((i) => i.type).join(',')),
);

/** `AccountCore.approveBuilder(builder, maxFeePps, expiry)`, cut from the SDK's ABI. */
export const KURU_ACCOUNT_CORE_APPROVE_BUILDER_ABI: Abi = abiFunctions(
  kuruAbi.accountCoreAbi as Abi,
  (fn) => fn.name === 'approveBuilder',
);

/** `AccountCore.getBuilderApproval(rootAccount, builder)`: what a root has approved a builder for. */
export const KURU_ACCOUNT_CORE_BUILDER_APPROVAL_ABI: Abi = abiFunctions(
  kuruAbi.accountCoreAbi as Abi,
  (fn) => fn.name === 'getBuilderApproval',
);

/**
 * Set C's address-keyed custody functions, from `@toxicflow-labs/ts-sdk`
 * 0.0.4's `accountCoreAbi` (SEN-189). The pinned SDK is 0.3.x, whose ABI has
 * only Set D's account-id shapes, so these are kept here verbatim; the
 * OrderBook and builder ABIs are byte-identical across the two versions.
 */
const ADDRESS_KEYED_ACCOUNT_CORE_ABI = [
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      { name: 'token', type: 'address', internalType: 'address' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'withdraw',
    inputs: [
      { name: 'token', type: 'address', internalType: 'address' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'userRegistry',
    inputs: [{ name: '', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint40', internalType: 'uint40' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getBalanceById',
    inputs: [
      { name: 'userId', type: 'uint40', internalType: 'uint40' },
      { name: 'token', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getSpotReservedBalance',
    inputs: [
      { name: 'user', type: 'address', internalType: 'address' },
      { name: 'token', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
] as const satisfies Abi;

/** One custody read: the ABI it lives in and the function's name there. */
type CustodyRead = { readonly abi: Abi; readonly functionName: string };

const CUSTODY: Readonly<
  Record<
    KuruCustody,
    {
      readonly abi: Abi;
      readonly deposit: Abi;
      readonly withdraw: Abi;
      readonly rootId: CustodyRead;
      readonly freeById: CustodyRead;
    }
  >
> = {
  'account-id': {
    abi: kuruAbi.accountCoreAbi as Abi,
    // The owner-address overload only: a policy decodes calldata with ONE
    // function per name, and `deposit.rootOwner` is the field it pins.
    deposit: abiFunctions(
      kuruAbi.accountCoreAbi as Abi,
      (fn) => fn.name === 'deposit' && fn.inputs[0]?.type === 'address',
    ),
    withdraw: abiFunctions(kuruAbi.accountCoreAbi as Abi, (fn) => fn.name === 'withdraw'),
    rootId: {
      abi: abiFunctions(kuruAbi.accountCoreAbi as Abi, (fn) => fn.name === 'rootAccountIdOf'),
      functionName: 'rootAccountIdOf',
    },
    freeById: {
      abi: abiFunctions(kuruAbi.accountCoreAbi as Abi, (fn) => fn.name === 'getBalance'),
      functionName: 'getBalance',
    },
  },
  'address-keyed': {
    abi: ADDRESS_KEYED_ACCOUNT_CORE_ABI,
    deposit: abiFunctions(ADDRESS_KEYED_ACCOUNT_CORE_ABI, (fn) => fn.name === 'deposit'),
    withdraw: abiFunctions(ADDRESS_KEYED_ACCOUNT_CORE_ABI, (fn) => fn.name === 'withdraw'),
    rootId: {
      abi: abiFunctions(ADDRESS_KEYED_ACCOUNT_CORE_ABI, (fn) => fn.name === 'userRegistry'),
      functionName: 'userRegistry',
    },
    freeById: {
      abi: abiFunctions(ADDRESS_KEYED_ACCOUNT_CORE_ABI, (fn) => fn.name === 'getBalanceById'),
      functionName: 'getBalanceById',
    },
  },
};

/**
 * `AccountCore.deposit`, one ABI per custody model:
 *
 * - `account-id` (Set D): `deposit(rootOwner, token, amount)` ONLY — not the
 *   `deposit(rootAccountId, …)` overload. It credits whatever root it names,
 *   not the caller's: anyone may fund anyone (SEN-185), so a signer that does
 *   not pin `rootOwner` to its own address can be made to pay a stranger.
 * - `address-keyed` (Set C): `deposit(token, amount)`, which always credits
 *   the caller and registers it on first use. Nothing to pin.
 */
export const KURU_ACCOUNT_CORE_DEPOSIT_ABIS: Readonly<Record<KuruCustody, Abi>> = {
  'account-id': CUSTODY['account-id'].deposit,
  'address-keyed': CUSTODY['address-keyed'].deposit,
};

/** The active deployment's `deposit` ABI. */
export const KURU_ACCOUNT_CORE_DEPOSIT_ABI: Abi =
  KURU_ACCOUNT_CORE_DEPOSIT_ABIS[KURU_DEPLOYMENT.custody];

/**
 * `AccountCore.withdraw`, one ABI per custody model, and nothing else — not
 * `transferBetweenAccounts`, not `fulfillApprovedWithdrawal`:
 *
 * - `account-id` (Set D): `withdraw(rootAccountId, token, amount, recipient)`
 *   pays the `recipient` it names (SEN-185), so a policy that allows it must
 *   pin `withdraw.recipient`. The WithdrawalLimiter can refuse it when
 *   protocol-wide capacity is spent.
 * - `address-keyed` (Set C): `withdraw(token, amount)` pays `msg.sender`.
 *
 * Only the root's owner (or a WITHDRAW/ADMIN signer of it) may call either.
 */
export const KURU_ACCOUNT_CORE_WITHDRAW_ABIS: Readonly<Record<KuruCustody, Abi>> = {
  'account-id': CUSTODY['account-id'].withdraw,
  'address-keyed': CUSTODY['address-keyed'].withdraw,
};

/** The active deployment's `withdraw` ABI. */
export const KURU_ACCOUNT_CORE_WITHDRAW_ABI: Abi =
  KURU_ACCOUNT_CORE_WITHDRAW_ABIS[KURU_DEPLOYMENT.custody];

/**
 * The owner → root-id read: `rootAccountIdOf(owner)` on Set D,
 * `userRegistry(owner)` on Set C. Both answer `0` before the first deposit.
 */
export const KURU_ACCOUNT_CORE_ROOT_ID_ABI: Abi = CUSTODY[KURU_DEPLOYMENT.custody].rootId.abi;

/**
 * A root's FREE balance of one token — exactly what `KuruVenue.getBalances`
 * reports as `available` (the reserved part is `getSpotReservedBalance`):
 * `getBalance(accountId, token)` on Set D, `getBalanceById(userId, token)` on
 * Set C.
 *
 * Cut out on its own because `getBalances` reads two functions for every token
 * Kuru lists, in parallel: about ten calls, where a caller that knows which
 * token it is asking about needs one. `POST /agents/:id/return` (SEN-17) plans
 * from this, and Monad's public RPC refuses more than 15 requests a second.
 */
export const KURU_ACCOUNT_CORE_BALANCE_ABI: Abi = CUSTODY[KURU_DEPLOYMENT.custody].freeById.abi;

/**
 * The `getSpotReservedBalance` read for `custody` — what a holder's resting
 * orders lock up: by account id on Set D, by the owner's address on Set C.
 */
export function kuruReservedBalanceRead(
  custody: KuruCustody,
  accountCore: Address,
  owner: Address,
  accountId: bigint,
  token: Address,
): { address: Address; abi: Abi; functionName: string; args: readonly unknown[] } {
  return {
    address: accountCore,
    abi: CUSTODY[custody].abi,
    functionName: 'getSpotReservedBalance',
    args: custody === 'account-id' ? [Number(accountId), token] : [owner, token],
  };
}

/**
 * The free-balance read for `custody` and a known root id — the second half of
 * {@link readKuruFreeById}, for a caller that batches its own reads.
 */
export function kuruFreeBalanceRead(
  custody: KuruCustody,
  accountCore: Address,
  accountId: bigint,
  token: Address,
): { address: Address; abi: Abi; functionName: string; args: readonly unknown[] } {
  const { abi, functionName } = CUSTODY[custody].freeById;
  return { address: accountCore, abi, functionName, args: [Number(accountId), token] };
}

/** The one read a caller of {@link readKuruFreeAtoms} needs to make. */
export type KuruContractReader = {
  readContract(request: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
};

/**
 * `owner`'s AccountCore root id, `0n` before its first deposit registers it.
 * An assigned id never changes, so a caller may keep a nonzero one.
 */
export async function readKuruRootId(
  client: KuruContractReader,
  accountCore: Address,
  owner: Address,
  custody: KuruCustody = KURU_DEPLOYMENT.custody,
): Promise<bigint> {
  const { abi, functionName } = CUSTODY[custody].rootId;
  return BigInt(
    (await client.readContract({ address: accountCore, abi, functionName, args: [owner] })) as
      number | bigint,
  );
}

/** Root `rootId`'s FREE balance of `token`, in atoms; `0n` for no root. */
export async function readKuruFreeById(
  client: KuruContractReader,
  accountCore: Address,
  rootId: bigint,
  token: Address,
  custody: KuruCustody = KURU_DEPLOYMENT.custody,
): Promise<bigint> {
  if (rootId === 0n) return 0n;
  const { abi, functionName } = CUSTODY[custody].freeById;
  return BigInt(
    (await client.readContract({
      address: accountCore,
      abi,
      functionName,
      args: [Number(rootId), token],
    })) as bigint,
  );
}

/**
 * `owner`'s FREE AccountCore balance of `token`, in atoms: its root id, then
 * `getBalance(rootId, token)`. Custody is keyed by account id since SEN-185, so
 * an owner that has never deposited has no id and holds `0`. A caller reading
 * several tokens, or also needing the id, reads it once with
 * {@link readKuruRootId} and uses {@link readKuruFreeById}.
 */
export async function readKuruFreeAtoms(
  client: KuruContractReader,
  accountCore: Address,
  owner: Address,
  token: Address,
  custody: KuruCustody = KURU_DEPLOYMENT.custody,
): Promise<bigint> {
  const id = await readKuruRootId(client, accountCore, owner, custody);
  return readKuruFreeById(client, accountCore, id, token, custody);
}

/**
 * ERC-20 `transfer(to, amount)`. `@sente/mandate` pins `transfer.to` to the
 * owner's return address, so the policy field names are these parameter names.
 */
export const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

/**
 * A builder fee on an order (SEN-184): who is paid and at what rate, in parts
 * per ten million of the notional. Kuru caps it at {@link KURU_MAX_BUILDER_FEE_PPS}.
 */
export type KuruBuilderFee = {
  readonly address: Address;
  readonly feePps: number;
};

/** AccountCore's `MAX_FEE_PPS()`, 1%, read on testnet 2026-10-09. */
export const KURU_MAX_BUILDER_FEE_PPS = 100_000;

/**
 * Sente's own ceiling on its builder fee, 10 bps (SEN-184): the API refuses to
 * boot above it and the phone refuses to pin above it. One constant so the two
 * cannot disagree.
 */
export const SENTE_MAX_BUILDER_FEE_PPS = 10_000;

/** How long a user's `approveBuilder` lasts: a year. */
export const BUILDER_APPROVAL_SECONDS = 365 * 86_400;

/** The furthest out the phone lets an approval expire: a year plus a day for clock skew. */
export const BUILDER_APPROVAL_MAX_SECONDS = BUILDER_APPROVAL_SECONDS + 86_400;

/**
 * `batch(0, [order], [])`: one order for the calling account. With `builder`,
 * the builder-fee overload, which also pays `builder.feePps` of the notional
 * to `builder` — only if the account approved that builder at that rate.
 */
export function placeOrderCall(
  market: Address,
  order: NativeOrderInput,
  clientOrderId?: Hex,
  builder?: KuruBuilderFee,
): KuruCall {
  return toCall(
    buildBatchRequest({
      market,
      userId: 0n,
      orders: [order],
      cancelSlotIdxs: [],
      clientOrderId,
      ...(builder ? { builderConfig: { builder: builder.address, feePps: builder.feePps } } : {}),
    }),
  );
}

/**
 * `AccountCore.approveBuilder(builder, maxFeePps, expiry)`: lets `builder` charge
 * up to `maxFeePps` on this account's orders until `expiry` (Unix seconds).
 * Called by the account itself — the root — so it needs no account id.
 */
export function approveBuilderCall(
  accountCore: Address,
  builder: Address,
  maxFeePps: number,
  expiry: bigint,
): KuruCall {
  if (!Number.isInteger(maxFeePps) || maxFeePps <= 0 || maxFeePps > KURU_MAX_BUILDER_FEE_PPS) {
    throw new KuruOrderError(`builder fee ${maxFeePps} pps is outside Kuru's range`);
  }
  if (expiry <= 0n) throw new KuruOrderError('builder approval expiry must be positive');
  return toCall(buildApproveBuilderRequest({ accountCore, builder, maxFeePps, expiry }));
}

/** `getBuilderApproval(root, builder)` as read. `active` is false when none was ever granted. */
export type KuruBuilderApproval = {
  readonly maxFeePps: number;
  /** Unix seconds. */
  readonly expiry: bigint;
  readonly active: boolean;
};

/**
 * Whether an existing approval lets `feePps` be charged for at least
 * `renewWithinSeconds` more. Anything less is re-approved rather than left to
 * revert an order on chain, where Monad still charges the whole gas limit.
 */
export function builderApprovalCovers(
  approval: KuruBuilderApproval,
  feePps: number,
  nowSeconds: number,
  renewWithinSeconds: number,
): boolean {
  return (
    approval.active &&
    approval.maxFeePps >= feePps &&
    approval.expiry > BigInt(Math.floor(nowSeconds) + renewWithinSeconds)
  );
}

/**
 * The builder fee on `amountAtoms` of the token Kuru takes it in — the base
 * received on a buy, the quote proceeds on a sell (SEN-195) — rounded UP so an
 * estimate never understates it. AccountCore charged 13 cbBTC atoms on a
 * 12,505-atom buy at 10,000 pps (tx 0xca084e71…), which is this rounding.
 * Nothing extra is deposited for it either way: it comes out of what the
 * taker receives.
 */
export function builderFeeAtoms(amountAtoms: bigint, feePps: number | bigint): bigint {
  return (amountAtoms * BigInt(feePps) + PPS_DENOMINATOR - 1n) / PPS_DENOMINATOR;
}

/** `batch(0, [], [slotIdx])`: cancel one resting order of the calling account. */
export function cancelOrderCall(market: Address, slotIdx: number): KuruCall {
  return toCall(buildBatchRequest({ market, userId: 0n, orders: [], cancelSlotIdxs: [slotIdx] }));
}

/**
 * Fund `rootOwner`'s AccountCore root: `approve` + `deposit` for an ERC-20, one
 * payable `deposit` for native MON. `rootOwner` is the calling account itself
 * in every caller Sente has — the deposit registers its root if it has none.
 * On Set C (`address-keyed`) the call cannot name it: `deposit(token, amount)`
 * always credits the caller, which is the same account.
 * The approval is for the exact amount, never unlimited — an agent-held
 * account must not leave a standing allowance behind.
 */
export function depositCalls(
  accountCore: Address,
  token: KuruToken,
  amount: bigint,
  rootOwner: Address,
  custody: KuruCustody = KURU_DEPLOYMENT.custody,
): KuruCall[] {
  if (amount <= 0n) {
    throw new KuruOrderError('deposit amount must be positive');
  }
  const deposit = toCall({
    address: accountCore,
    abi: KURU_ACCOUNT_CORE_DEPOSIT_ABIS[custody],
    functionName: 'deposit',
    args: custody === 'account-id' ? [rootOwner, token.address, amount] : [token.address, amount],
    value: isAddressEqual(token.address, NATIVE_TOKEN) ? amount : 0n,
  });
  if (isAddressEqual(token.address, NATIVE_TOKEN)) return [deposit];
  return [
    toCall(buildApproveErc20Request({ token: token.address, spender: accountCore, amount })),
    deposit,
  ];
}

/**
 * Take `amount` of `token` out of root `rootAccountId`'s free AccountCore
 * balance and pay it to `recipient`. Only free balance can leave; what resting
 * orders reserve stays until they are cancelled. On Set D the recipient is
 * explicit — that AccountCore does not pay the caller by default — and is the
 * account's own address or its owner's in every caller Sente has. On Set C
 * (`address-keyed`) `withdraw(token, amount)` always pays the caller, so
 * `recipient` is not encoded; a caller that wants the funds elsewhere follows
 * with an ERC-20 `transfer`.
 */
export function withdrawCall(
  accountCore: Address,
  token: KuruToken,
  amount: bigint,
  rootAccountId: bigint,
  recipient: Address,
  custody: KuruCustody = KURU_DEPLOYMENT.custody,
): KuruCall {
  if (amount <= 0n) {
    throw new KuruOrderError('withdraw amount must be positive');
  }
  if (rootAccountId <= 0n) {
    throw new KuruOrderError('this account has no Kuru account to withdraw from');
  }
  return toCall({
    address: accountCore,
    abi: KURU_ACCOUNT_CORE_WITHDRAW_ABIS[custody],
    functionName: 'withdraw',
    args:
      custody === 'account-id'
        ? [rootAccountId, token.address, amount, recipient]
        : [token.address, amount],
  });
}

/** ERC-20 `transfer(to, amount)` from the calling address: how an agent returns funds to its owner. */
export function erc20TransferCall(token: Address, to: Address, amount: bigint): KuruCall {
  if (amount <= 0n) {
    throw new KuruOrderError('transfer amount must be positive');
  }
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [to, amount],
    }),
  };
}

/** The testnet faucet's `claim()`. Pays whoever calls it. */
export function faucetClaimCall(): KuruCall {
  return { to: KURU_FAUCET.address, value: 0n, data: KURU_FAUCET.claimSelector };
}

const BUILDER_FEE_ACCRUED = kuruAbi.accountCoreAbi.filter(
  (item) => item.type === 'event' && item.name === 'BuilderFeeAccrued',
);

/** One `BuilderFeeAccrued`: what one execution paid one builder, in `asset` atoms. */
export type KuruBuilderFeePaid = {
  readonly asset: Address;
  readonly amount: bigint;
};

/**
 * The builder fees `takerAccountId` paid `builder` in this execution, from
 * AccountCore's `BuilderFeeAccrued` events, one entry per event (SEN-184).
 *
 * The event names the TAKER account only, so a resting order's later maker
 * fills cannot be attributed here; until a live fill shows whether makers
 * pay a builder fee at all, a maker fill reports none.
 */
export function decodeBuilderFees(
  logs: readonly KuruLog[],
  accountCore: Address,
  builder: Address,
  takerAccountId: bigint,
): KuruBuilderFeePaid[] {
  const paid: KuruBuilderFeePaid[] = [];
  for (const log of logs) {
    if (!isAddressEqual(log.address, accountCore) || log.topics.length === 0) continue;
    let event;
    try {
      event = decodeEventLog({
        abi: BUILDER_FEE_ACCRUED,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    const args = event.args as {
      builder: Address;
      asset: Address;
      takerAccountId: number | bigint;
      amount: bigint;
    };
    if (!isAddressEqual(args.builder, builder)) continue;
    if (BigInt(args.takerAccountId) !== takerAccountId) continue;
    paid.push({ asset: args.asset, amount: args.amount });
  }
  return paid;
}

/**
 * {@link decodeBuilderFees} totalled per asset, in the order each asset first
 * appears (SEN-195). Kuru takes a taker's builder fee in the asset the taker
 * RECEIVES — the base on a buy, the quote on a sell — so a caller reads the
 * asset off the event rather than assume the quote: a buy pays nothing in
 * USDC (tx 0xca084e71…, docs/kuru.md "Which asset the fee is taken in").
 */
export function builderFeesByAsset(
  logs: readonly KuruLog[],
  accountCore: Address,
  builder: Address,
  takerAccountId: bigint,
): KuruBuilderFeePaid[] {
  const totals: KuruBuilderFeePaid[] = [];
  for (const fee of decodeBuilderFees(logs, accountCore, builder, takerAccountId)) {
    const index = totals.findIndex((t) => isAddressEqual(t.asset, fee.asset));
    if (index < 0) totals.push(fee);
    else totals[index] = { asset: fee.asset, amount: totals[index]!.amount + fee.amount };
  }
  return totals;
}

/**
 * The token Kuru charges a taker's builder fee in: the one the taker
 * receives, base on a buy and quote on a sell (SEN-195).
 */
export function builderFeeToken<T>(side: Side, pair: { readonly base: T; readonly quote: T }): T {
  return side === 'buy' ? pair.base : pair.quote;
}

/**
 * The quote atoms `baseAtoms` are worth at `price` (a decimal, quote per
 * whole base), rounded up: the "≈ $" shown beside a fee taken in the base.
 */
export function baseValueInQuoteAtoms(
  baseAtoms: bigint,
  baseDecimals: number,
  price: Decimal,
  quoteDecimals: number,
): bigint {
  const priceDecimals = price.split('.')[1]?.length ?? 0;
  const priceUnits = toUnits(price, priceDecimals, 'price');
  const numerator = baseAtoms * priceUnits * 10n ** BigInt(quoteDecimals);
  const denominator = 10n ** BigInt(baseDecimals + priceDecimals);
  return (numerator + denominator - 1n) / denominator;
}

/** One order's builder fee as an `Order` and a fill event report it (SEN-195). */
export type KuruBuilderFeeReport = {
  /** The fee, in `asset`. */
  readonly fee: Decimal;
  /** The symbol of the token Kuru took it in. */
  readonly asset: string;
  /**
   * ≈ the fee in the quote: `fee` itself when it was taken in the quote, its
   * value at the average fill price (rounded up) when taken in the base.
   * Absent when a base fee has no fill price to value it at.
   */
  readonly quoteEstimate?: Decimal;
};

/**
 * One order's builder fee from {@link builderFeesByAsset}: the amount in
 * whichever of the pair's tokens AccountCore named (the received one should
 * both ever appear), or `"0"` of the received token when the order took
 * nothing.
 */
export function builderFeeReport(
  paid: readonly KuruBuilderFeePaid[],
  side: Side,
  pair: { readonly base: KuruToken; readonly quote: KuruToken },
  averagePrice?: Decimal,
): KuruBuilderFeeReport {
  const amountIn = (token: KuruToken) =>
    paid.find((p) => isAddressEqual(p.asset, token.address))?.amount;
  const received = builderFeeToken(side, pair);
  const other = received === pair.base ? pair.quote : pair.base;
  const otherAmount = amountIn(other);
  const [token, amount] =
    amountIn(received) === undefined && otherAmount !== undefined
      ? [other, otherAmount]
      : [received, amountIn(received) ?? 0n];
  let quoteEstimate: Decimal | undefined;
  if (token === pair.quote || amount === 0n) {
    quoteEstimate = fromUnits(amount, pair.quote.decimals);
  } else if (averagePrice !== undefined) {
    quoteEstimate = fromUnits(
      baseValueInQuoteAtoms(amount, token.decimals, averagePrice, pair.quote.decimals),
      pair.quote.decimals,
    );
  }
  return {
    fee: fromUnits(amount, token.decimals),
    asset: token.symbol,
    ...(quoteEstimate !== undefined ? { quoteEstimate } : {}),
  };
}

/** Where a resting order lives. */
export type KuruOrderRef = {
  readonly slotIdx: number;
  readonly orderId: bigint;
};

/**
 * Sente's `OrderId` for a resting Kuru order: `"<slotIdx>:<orderId>"`.
 *
 * Both halves are needed. A cancel addresses a SLOT, and slots are reused; the
 * order id is what proves the slot still holds the order the caller means.
 */
export function formatOrderId(ref: KuruOrderRef): string {
  return `${ref.slotIdx}:${ref.orderId}`;
}

export function parseOrderId(id: string): KuruOrderRef {
  const match = /^(\d{1,3}):(\d{1,20})$/.exec(id);
  if (!match || Number(match[1]) > 255) {
    throw new KuruOrderError(`"${id}" is not a Kuru resting-order id`);
  }
  return { slotIdx: Number(match[1]), orderId: BigInt(match[2]!) };
}

/** The part of a log the decoder needs. A viem `Log` satisfies it. */
export type KuruLog = {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
};

/** One fill where this account was the TAKER. Book units. */
export type KuruFill = {
  readonly price: bigint;
  readonly size: bigint;
  readonly makerId: bigint;
  readonly makerOrderId: bigint;
  readonly tradeId: bigint;
};

/** One of this account's orders as the book reported it. Book units. */
export type KuruBookRecord = KuruOrderRef & {
  readonly price: bigint;
  readonly size: bigint;
  readonly isBuy: boolean;
};

export type KuruOrderOutcome = {
  readonly fills: readonly KuruFill[];
  /** This account's orders now resting, at their resting size. */
  readonly rested: readonly KuruBookRecord[];
  /** This account's orders taken off the book other than by a fill — cancels, dust. */
  readonly removed: readonly KuruBookRecord[];
  /** Taker fee actually applied, when anything was taken. */
  readonly takerFeePps: bigint | undefined;
};

/**
 * What one execution did to one account on one market, read from the
 * OrderBook's own packed events — `batch` returns nothing, so the receipt is
 * the only answer.
 *
 * `logs` must be the logs of THIS execution. For a UserOperation that means
 * its own receipt's logs; a bundle transaction can carry other accounts'
 * operations against the same market.
 */
export function decodeOrderOutcome(
  logs: readonly KuruLog[],
  market: Address,
  accountId: bigint,
): KuruOrderOutcome {
  const fills: KuruFill[] = [];
  const rested: KuruBookRecord[] = [];
  const removed: KuruBookRecord[] = [];
  let takerFeePps: bigint | undefined;

  for (const log of logs) {
    if (!isAddressEqual(log.address, market) || log.topics.length === 0) continue;
    let event;
    try {
      event = decodeEventLog({
        abi: kuruAbi.orderBookAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue; // not an OrderBook event this decoder knows
    }

    if (event.eventName === 'TradesPacked' && BigInt(event.args.accountId) === accountId) {
      takerFeePps = BigInt(event.args.effectiveTakerFeePps);
      for (const trade of decodeTradesPacked(event.args.packedTrades)) {
        fills.push({
          price: trade.price,
          size: trade.fillSize,
          makerId: trade.makerId,
          makerOrderId: trade.orderId,
          tradeId: trade.tradeId,
        });
      }
    } else if (
      event.eventName === 'BookUpdatesPacked' &&
      BigInt(event.args.accountId) === accountId
    ) {
      for (const update of decodeBookUpdatesPacked(event.args.packedUpdates)) {
        if (update.makerId !== accountId) continue;
        const record: KuruBookRecord = {
          slotIdx: update.slotIdx,
          orderId: update.orderId,
          price: update.price,
          size: update.size,
          isBuy: update.makerIsBuy,
        };
        (update.isLive ? rested : removed).push(record);
      }
    }
  }

  return { fills, rested, removed, takerFeePps };
}

/**
 * A log as `eth_getLogs` returns it: a {@link KuruLog} plus where it sits on
 * chain. A viem `Log` satisfies it. The `null`s are a pending block's, which a
 * range read below the head never returns.
 */
export type KuruChainLog = KuruLog & {
  readonly transactionHash: Hex | null;
  readonly logIndex: number | null;
  readonly blockNumber: bigint | null;
};

/**
 * One fill of a RESTING order, read off the taker's `TradesPacked` (SEN-149).
 * Book units, like {@link KuruFill}.
 */
export type KuruMakerFill = KuruOrderRef & {
  readonly makerId: bigint;
  readonly isBuy: boolean;
  readonly price: bigint;
  readonly size: bigint;
  /** The maker order's size left on the book after this match. */
  readonly remaining: bigint;
  /** What the maker was charged, parts per ten million of the notional. */
  readonly makerFeePps: bigint;
  readonly tradeId: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  /** Which record of that log: one taker sweep fills several makers in one log. */
  readonly recordIndex: number;
  readonly blockNumber: bigint;
};

/**
 * Every maker fill on `market` in `logs`, whoever the maker is (SEN-149).
 *
 * A resting order's later fills are only ever reported in SOMEONE ELSE's
 * transaction: the taker's `TradesPacked` carries one record per maker order
 * it hit, with that maker's account id, slot and order id inside the packed
 * bytes — not in a topic, so an RPC filter cannot select them. The caller
 * reads a market's `TradesPacked` logs once and matches every order it
 * watches against the result. Zero-size bookkeeping records are skipped.
 */
export function decodeMakerFills(logs: readonly KuruChainLog[], market: Address): KuruMakerFill[] {
  const fills: KuruMakerFill[] = [];
  for (const log of logs) {
    if (!isAddressEqual(log.address, market) || log.topics.length === 0) continue;
    const { transactionHash, logIndex, blockNumber } = log;
    if (transactionHash === null || logIndex === null || blockNumber === null) continue;
    let event;
    try {
      event = decodeEventLog({
        abi: kuruAbi.orderBookAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue; // not an OrderBook event this decoder knows
    }
    if (event.eventName !== 'TradesPacked') continue;
    for (const [recordIndex, trade] of decodeTradesPacked(event.args.packedTrades).entries()) {
      if (trade.fillSize === 0n) continue;
      fills.push({
        makerId: trade.makerId,
        slotIdx: trade.slotIdx,
        orderId: trade.orderId,
        isBuy: trade.makerIsBuy,
        price: trade.price,
        size: trade.fillSize,
        remaining: trade.updatedSize,
        makerFeePps: BigInt(trade.makerFeePps),
        tradeId: trade.tradeId,
        transactionHash,
        logIndex,
        recordIndex,
        blockNumber,
      });
    }
  }
  return fills;
}
