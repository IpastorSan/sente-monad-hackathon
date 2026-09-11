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
  buildApproveErc20Request,
  buildBatchRequest,
  buildDepositRequest,
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
import { KURU_FAUCET, NATIVE_TOKEN, type KuruToken } from './constants.ts';
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

/** The `batch` overloads this module encodes: without and with a `clientOrderId`. */
const BATCH_SIGNATURES = new Set(['uint40,tuple[],uint8[]', 'uint40,tuple[],uint8[],bytes32']);

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
  kuruAbi.spotOrderBookAbi as Abi,
  (fn) => fn.name === 'batch' && BATCH_SIGNATURES.has(fn.inputs.map((i) => i.type).join(',')),
);

/** `AccountCore.deposit(token, amount)`, cut from the SDK's ABI for the same reason. */
export const KURU_ACCOUNT_CORE_DEPOSIT_ABI: Abi = abiFunctions(
  kuruAbi.accountCoreAbi as Abi,
  (fn) => fn.name === 'deposit',
);

/** `batch(0, [order], [])`: one order for the calling account. */
export function placeOrderCall(
  market: Address,
  order: NativeOrderInput,
  clientOrderId?: Hex,
): KuruCall {
  return toCall(
    buildBatchRequest({ market, userId: 0n, orders: [order], cancelSlotIdxs: [], clientOrderId }),
  );
}

/** `batch(0, [], [slotIdx])`: cancel one resting order of the calling account. */
export function cancelOrderCall(market: Address, slotIdx: number): KuruCall {
  return toCall(buildBatchRequest({ market, userId: 0n, orders: [], cancelSlotIdxs: [slotIdx] }));
}

/**
 * Fund the calling account's AccountCore balance: `approve` + `deposit` for an
 * ERC-20, one payable `deposit` for native MON. The approval is for the exact
 * amount, never unlimited — an agent-held account must not leave a standing
 * allowance behind.
 */
export function depositCalls(accountCore: Address, token: KuruToken, amount: bigint): KuruCall[] {
  if (amount <= 0n) {
    throw new KuruOrderError('deposit amount must be positive');
  }
  if (isAddressEqual(token.address, NATIVE_TOKEN)) {
    return [toCall(buildDepositRequest({ token: NATIVE_TOKEN, amount, accountCore }))];
  }
  return [
    toCall(buildApproveErc20Request({ token: token.address, spender: accountCore, amount })),
    toCall(buildDepositRequest({ token: token.address, amount, accountCore })),
  ];
}

/** The testnet faucet's `claim()`. Pays whoever calls it. */
export function faucetClaimCall(): KuruCall {
  return { to: KURU_FAUCET.address, value: 0n, data: KURU_FAUCET.claimSelector };
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
        abi: kuruAbi.spotOrderBookAbi,
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
