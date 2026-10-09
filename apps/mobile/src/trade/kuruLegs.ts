/**
 * Phone Kuru call classifier (SEN-92, plan M-T9).
 *
 * Takes one call out of `decodeTransactionCalls` (`calls.ts`) and says which
 * Kuru leg it is — approve, deposit, approveBuilder, withdraw, place or cancel
 * — with every argument decoded, or refuses it. The policy verifier (M-T10) then compares
 * the legs with what the user confirmed. The device key signs blindly, so
 * this is part of the security boundary: see docs/design/trading/plan-trading.md,
 * Architecture §1 "Allowed functions" and "Kuru values".
 *
 * Why hand-written fragments rather than the SDK's ABI: decoding against the
 * SDK's whole `spotOrderBookAbi`/`accountCoreAbi` would make every function in
 * them decodable, including `withdrawFromAccount`, which names a recipient.
 *
 * The two `batch` overloads that take a `builderConfig(address builder, uint32
 * feePps)` and `AccountCore.approveBuilder` ARE decoded since SEN-184 — Sente's
 * own fee rides on them — and the builder, the rate and the expiry are
 * reported for the verifier to hold to this build's pin (`kuruBuilder.ts`): a
 * server must not be able to route a builder fee anywhere else, or at any
 * other rate. Here they only get the context-free checks. A function missing from `KURU_LEG_ABI` fails to decode and is
 * refused, so the allow-list is exactly this file. `kuruLegs.test.ts` pins each
 * fragment's selector to the SDK's ABI so a hand-typing error cannot drift.
 *
 * Every decode is followed by a re-encode of the decoded arguments and a byte
 * comparison: trailing bytes, dirty padding and non-canonical offsets all
 * decode "fine" but are not what the server's encoder emits, and the signature
 * covers the bytes, not the decoded values.
 *
 * Context-free hazards are refused here, not left to the verifier: value on
 * anything but a native deposit, an unlimited approval, an approval to anyone
 * but AccountCore, an AccountCore call to another address (the leg does not
 * carry its target), an order to a market outside `KURU_TESTNET_MARKETS`, and
 * out-of-range enum values. Everything that depends on the intent (which
 * token, which market, sizes, prices, `userId == 0`, the slot) is reported for
 * M-T10 to compare.
 */
import {
  KURU_MAX_BUILDER_FEE_PPS,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  NATIVE_TOKEN,
} from '@sente/venues/kuru';
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  maxUint256,
  size,
  sliceHex,
  toFunctionSelector,
  zeroAddress,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';

import { isSameCallData, type Erc7579Call } from '../wallet/batch.ts';

/** SDK enum `NativeSide`. */
export const KURU_SIDE = { buy: 0, sell: 1 } as const;
/** SDK enum `NativeTif`. */
export const KURU_TIF = { gtc: 0, ioc: 1, fok: 2 } as const;
/** SDK enum `NativeExecInstruction`. */
export const KURU_EXEC = { none: 0, postOnly: 1 } as const;

/** One `NativeOrder` as it will reach the OrderBook. */
export type KuruOrder = {
  readonly side: (typeof KURU_SIDE)[keyof typeof KURU_SIDE];
  readonly quantity: bigint;
  readonly price: number;
  readonly tif: (typeof KURU_TIF)[keyof typeof KURU_TIF];
  readonly executionInstruction: (typeof KURU_EXEC)[keyof typeof KURU_EXEC];
  readonly minSizeAfterBlock: number;
};

/**
 * One classified Kuru call. `ok: true` on every variant so a result is
 * narrowed by `ok` first, then by `kind`.
 *
 * - `approve`: ERC-20 `approve` on `token` (the call's target).
 * - `approveBuilder`: `AccountCore.approveBuilder(builder, maxFeePps, expiry)`.
 * - `deposit` / `withdraw`: AccountCore calls; `value` is the MON the call sends.
 * - `place`: `batch(userId, [order], [])`, `market` being the call's target;
 *   `builder` when it is a builder-config overload.
 * - `cancel`: `batch(userId, [], slots)`.
 */
export type KuruLeg =
  | {
      readonly ok: true;
      readonly kind: 'approve';
      readonly token: Address;
      readonly spender: Address;
      readonly amount: bigint;
    }
  | {
      readonly ok: true;
      readonly kind: 'deposit';
      readonly token: Address;
      readonly amount: bigint;
      readonly value: bigint;
    }
  | {
      readonly ok: true;
      readonly kind: 'withdraw';
      readonly token: Address;
      readonly amount: bigint;
    }
  | {
      readonly ok: true;
      readonly kind: 'approveBuilder';
      readonly builder: Address;
      readonly maxFeePps: number;
      /** Unix seconds. */
      readonly expiry: bigint;
    }
  | {
      readonly ok: true;
      readonly kind: 'place';
      readonly market: Address;
      readonly userId: bigint;
      readonly order: KuruOrder;
      readonly clientOrderId?: Hex;
      readonly builder?: KuruBuilderConfig;
    }
  | {
      readonly ok: true;
      readonly kind: 'cancel';
      readonly market: Address;
      readonly userId: bigint;
      readonly slots: readonly number[];
    };

export type KuruRefusal = { readonly ok: false; readonly problem: string };

/** A builder-config overload's trailing tuple: who is paid, in pps of the notional. */
export type KuruBuilderConfig = { readonly builder: Address; readonly feePps: number };

const NATIVE_ORDER = {
  name: 'orders',
  type: 'tuple[]',
  components: [
    { name: 'side', type: 'uint8' },
    { name: 'quantity', type: 'uint96' },
    { name: 'price', type: 'uint32' },
    { name: 'tif', type: 'uint8' },
    { name: 'executionInstruction', type: 'uint8' },
    { name: 'minSizeAfterBlock', type: 'uint32' },
  ],
} as const;

const APPROVE = {
  type: 'function',
  name: 'approve',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'spender', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
} as const satisfies AbiFunction;

const DEPOSIT = {
  type: 'function',
  name: 'deposit',
  stateMutability: 'payable',
  inputs: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [],
} as const satisfies AbiFunction;

const WITHDRAW = {
  type: 'function',
  name: 'withdraw',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [],
} as const satisfies AbiFunction;

const BATCH = {
  type: 'function',
  name: 'batch',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'userId', type: 'uint40' },
    NATIVE_ORDER,
    { name: 'cancelSlotIdxs', type: 'uint8[]' },
  ],
  outputs: [],
} as const satisfies AbiFunction;

const BATCH_WITH_CLIENT_ID = {
  type: 'function',
  name: 'batch',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'userId', type: 'uint40' },
    NATIVE_ORDER,
    { name: 'cancelSlotIdxs', type: 'uint8[]' },
    { name: 'clientOrderId', type: 'bytes32' },
  ],
  outputs: [],
} as const satisfies AbiFunction;

const BUILDER_CONFIG = {
  name: 'builderConfig',
  type: 'tuple',
  components: [
    { name: 'builder', type: 'address' },
    { name: 'feePps', type: 'uint32' },
  ],
} as const;

const BATCH_WITH_BUILDER = {
  type: 'function',
  name: 'batch',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'userId', type: 'uint40' },
    NATIVE_ORDER,
    { name: 'cancelSlotIdxs', type: 'uint8[]' },
    BUILDER_CONFIG,
  ],
  outputs: [],
} as const satisfies AbiFunction;

const BATCH_WITH_CLIENT_ID_AND_BUILDER = {
  type: 'function',
  name: 'batch',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'userId', type: 'uint40' },
    NATIVE_ORDER,
    { name: 'cancelSlotIdxs', type: 'uint8[]' },
    { name: 'clientOrderId', type: 'bytes32' },
    BUILDER_CONFIG,
  ],
  outputs: [],
} as const satisfies AbiFunction;

const APPROVE_BUILDER = {
  type: 'function',
  name: 'approveBuilder',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'builder', type: 'address' },
    { name: 'maxFeePps', type: 'uint32' },
    { name: 'expiry', type: 'uint64' },
  ],
  outputs: [],
} as const satisfies AbiFunction;

/**
 * The whole allow-list. Exported only so the test can pin each selector to the
 * SDK's ABI; nothing else should decode with it.
 */
export const KURU_LEG_ABI = [
  APPROVE,
  DEPOSIT,
  WITHDRAW,
  BATCH,
  BATCH_WITH_CLIENT_ID,
  APPROVE_BUILDER,
  BATCH_WITH_BUILDER,
  BATCH_WITH_CLIENT_ID_AND_BUILDER,
] as const;

const refuse = (problem: string): KuruRefusal => ({ ok: false, problem });

const ACCOUNT_CORE = KURU_TESTNET_CONTRACTS.accountCore;

/**
 * Decodes `data` against exactly one fragment and re-encodes it. Selecting the
 * fragment by selector first (rather than handing viem the whole list) keeps
 * the two same-named `batch` overloads from ever being confused.
 */
function decodeCanonical(fragment: AbiFunction, data: Hex): readonly unknown[] | KuruRefusal {
  let args: readonly unknown[];
  try {
    const decoded = decodeFunctionData({ abi: [fragment] as readonly AbiFunction[], data });
    args = decoded.args ?? [];
  } catch {
    return refuse(`the ${fragment.name} call does not decode`);
  }
  let reencoded: Hex;
  try {
    reencoded = encodeFunctionData({
      abi: [fragment] as readonly AbiFunction[],
      functionName: fragment.name,
      args,
    });
  } catch {
    return refuse(`the ${fragment.name} call does not re-encode`);
  }
  if (!isSameCallData(reencoded, data)) {
    return refuse(`the ${fragment.name} call is not canonically encoded`);
  }
  return args;
}

const isRefusal = (value: unknown): value is KuruRefusal =>
  typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;

const FRAGMENT_BY_SELECTOR: ReadonlyMap<Hex, AbiFunction> = new Map(
  KURU_LEG_ABI.map((fragment) => [toFunctionSelector(fragment), fragment]),
);

/**
 * Classifies one call of a Kuru trade step, or says why it is refused.
 * Anything not in `KURU_LEG_ABI` — `transfer`, `transferFrom`, `permit`,
 * `withdrawFromAccount`, `revokeBuilder`, `claimBuilderFees` — lands on the
 * unknown-selector refusal.
 */
export function classifyKuruCall(call: Erc7579Call): KuruLeg | KuruRefusal {
  const data = call.data ?? '0x';
  const value = call.value ?? 0n;
  if (size(data) < 4) return refuse('the call has no function selector');
  const fragment = FRAGMENT_BY_SELECTOR.get(sliceHex(data, 0, 4).toLowerCase() as Hex);
  if (fragment === undefined) {
    return refuse(`function ${sliceHex(data, 0, 4)} is not a Kuru call the app signs`);
  }
  const args = decodeCanonical(fragment, data);
  if (isRefusal(args)) return args;

  // Only a native deposit moves MON with the call; everything else sending
  // value would be MON leaving the wallet for no reason.
  if (fragment !== DEPOSIT && value !== 0n)
    return refuse(`the ${fragment.name} call carries value`);

  if (fragment === APPROVE) return classifyApprove(call.to, args as [Address, bigint]);
  if (fragment === DEPOSIT) return classifyDeposit(call.to, value, args as [Address, bigint]);
  if (fragment === WITHDRAW) return classifyWithdraw(call.to, args as [Address, bigint]);
  if (fragment === APPROVE_BUILDER) {
    return classifyApproveBuilder(call.to, args as [Address, number, bigint]);
  }
  // The four `batch` overloads differ only in their optional tail.
  const [userId, orders, slots, ...tail] = args as BatchArgs;
  const clientOrderId =
    fragment === BATCH_WITH_CLIENT_ID || fragment === BATCH_WITH_CLIENT_ID_AND_BUILDER
      ? (tail[0] as Hex)
      : undefined;
  const builder =
    fragment === BATCH_WITH_BUILDER || fragment === BATCH_WITH_CLIENT_ID_AND_BUILDER
      ? (tail.at(-1) as KuruBuilderConfig)
      : undefined;
  return classifyBatch(call.to, { userId, orders, slots, clientOrderId, builder });
}

function classifyApproveBuilder(
  target: Address,
  [builder, maxFeePps, expiry]: [Address, number, bigint],
): KuruLeg | KuruRefusal {
  if (!isAddressEqual(target, ACCOUNT_CORE)) {
    return refuse(`the builder approval goes to ${target}, not AccountCore`);
  }
  if (isAddressEqual(builder, zeroAddress)) return refuse('the builder approval names no builder');
  if (maxFeePps === 0 || maxFeePps > KURU_MAX_BUILDER_FEE_PPS) {
    return refuse(`the builder approval allows ${maxFeePps} pps, outside Kuru's range`);
  }
  if (expiry === 0n) return refuse('the builder approval never takes effect');
  return { ok: true, kind: 'approveBuilder', builder: getAddress(builder), maxFeePps, expiry };
}

function classifyApprove(
  token: Address,
  [spender, amount]: [Address, bigint],
): KuruLeg | KuruRefusal {
  if (!isAddressEqual(spender, ACCOUNT_CORE)) {
    return refuse(`the approval is for ${spender}, not Kuru's AccountCore`);
  }
  // An unlimited allowance outlives the trade: the verifier's "approve equals
  // deposit" rule would catch it, but it must never be signable at all.
  if (amount === maxUint256) return refuse('the approval is unlimited');
  if (amount === 0n) return refuse('the approval is for nothing');
  return {
    ok: true,
    kind: 'approve',
    token: getAddress(token),
    spender: getAddress(spender),
    amount,
  };
}

function classifyDeposit(
  target: Address,
  value: bigint,
  [token, amount]: [Address, bigint],
): KuruLeg | KuruRefusal {
  if (!isAddressEqual(target, ACCOUNT_CORE))
    return refuse(`the deposit goes to ${target}, not AccountCore`);
  if (amount === 0n) return refuse('the deposit is for nothing');
  const native = isAddressEqual(token, NATIVE_TOKEN);
  // AccountCore takes native MON as msg.value; any other value is either an
  // underpaid native deposit or MON sent alongside an ERC-20 one.
  if (native && value !== amount)
    return refuse('the MON deposit sends a different value than it credits');
  if (!native && value !== 0n) return refuse('the token deposit also sends MON');
  return { ok: true, kind: 'deposit', token: getAddress(token), amount, value };
}

function classifyWithdraw(
  target: Address,
  [token, amount]: [Address, bigint],
): KuruLeg | KuruRefusal {
  if (!isAddressEqual(target, ACCOUNT_CORE))
    return refuse(`the withdrawal goes to ${target}, not AccountCore`);
  if (amount === 0n) return refuse('the withdrawal is for nothing');
  return { ok: true, kind: 'withdraw', token: getAddress(token), amount };
}

type RawOrder = {
  side: number;
  quantity: bigint;
  price: number;
  tif: number;
  executionInstruction: number;
  minSizeAfterBlock: number;
};
/** viem decodes integers up to 48 bits (`uint40 userId`) as `number`. */
type BatchArgs = [number, readonly RawOrder[], readonly number[], ...unknown[]];

type Batch = {
  readonly userId: number;
  readonly orders: readonly RawOrder[];
  readonly slots: readonly number[];
  readonly clientOrderId: Hex | undefined;
  readonly builder: KuruBuilderConfig | undefined;
};

function classifyBatch(
  target: Address,
  { userId: rawUserId, orders, slots, clientOrderId, builder }: Batch,
): KuruLeg | KuruRefusal {
  const userId = BigInt(rawUserId);
  const market = KURU_TESTNET_MARKETS.find((m) => isAddressEqual(m.address, target));
  if (market === undefined) return refuse(`${target} is not a Kuru market the app trades`);

  // One order and no cancels, or no orders and some cancels: a mixed batch
  // could cancel a resting order the user never asked to touch.
  if (orders.length > 0 && slots.length > 0) return refuse('the batch both places and cancels');
  if (orders.length > 1) return refuse('the batch places more than one order');

  const [raw] = orders;
  if (raw !== undefined) {
    const order = toOrder(raw);
    if (isRefusal(order)) return order;
    if (builder !== undefined) {
      if (isAddressEqual(builder.builder, zeroAddress)) return refuse('the order pays no builder');
      if (builder.feePps === 0 || builder.feePps > KURU_MAX_BUILDER_FEE_PPS) {
        return refuse(`the order pays a builder ${builder.feePps} pps, outside Kuru's range`);
      }
    }
    return {
      ok: true,
      kind: 'place',
      market: getAddress(market.address),
      userId,
      order,
      ...(clientOrderId === undefined ? {} : { clientOrderId }),
      ...(builder === undefined
        ? {}
        : { builder: { builder: getAddress(builder.builder), feePps: builder.feePps } }),
    };
  }
  if (slots.length === 0) return refuse('the batch does nothing');
  // Nor a builder fee: the server never puts one on a cancel.
  if (builder !== undefined) return refuse('the cancel carries a builder fee');
  // A client order id on a pure cancel is not something the server emits.
  if (clientOrderId !== undefined) return refuse('the cancel carries a client order id');
  return {
    ok: true,
    kind: 'cancel',
    market: getAddress(market.address),
    userId,
    slots: [...slots],
  };
}

function toOrder(raw: RawOrder): KuruOrder | KuruRefusal {
  // uint8 decodes up to 255; only the SDK's enum members mean anything, and an
  // unknown one would be interpreted by the contract, not by the user.
  if (raw.side !== KURU_SIDE.buy && raw.side !== KURU_SIDE.sell) {
    return refuse(`order side ${raw.side} is unknown`);
  }
  if (raw.tif !== KURU_TIF.gtc && raw.tif !== KURU_TIF.ioc && raw.tif !== KURU_TIF.fok) {
    return refuse(`order time-in-force ${raw.tif} is unknown`);
  }
  if (
    raw.executionInstruction !== KURU_EXEC.none &&
    raw.executionInstruction !== KURU_EXEC.postOnly
  ) {
    return refuse(`order execution instruction ${raw.executionInstruction} is unknown`);
  }
  return {
    side: raw.side,
    quantity: raw.quantity,
    price: raw.price,
    tif: raw.tif,
    executionInstruction: raw.executionInstruction,
    minSizeAfterBlock: raw.minSizeAfterBlock,
  };
}
