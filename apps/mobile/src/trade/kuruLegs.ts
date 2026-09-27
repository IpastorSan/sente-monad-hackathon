/**
 * Phone Kuru call classifier (SEN-92, plan M-T9).
 *
 * Takes one call out of `decodeTransactionCalls` (`calls.ts`) and says which
 * Kuru leg it is — approve, deposit, withdraw, place or cancel — with every
 * argument decoded, or refuses it. The policy verifier (M-T10) then compares
 * the legs with what the user confirmed. The device key signs blindly, so
 * this is part of the security boundary: see docs/design/trading/plan-trading.md,
 * Architecture §1 "Allowed functions" and "Kuru values".
 *
 * Why hand-written fragments rather than the SDK's ABI: decoding against the
 * SDK's whole `spotOrderBookAbi`/`accountCoreAbi` would make every function in
 * them decodable, including the two `batch` overloads that take a
 * `builderConfig(address builder, uint32 feePps)` — a server could route a
 * builder fee to itself on every order — and `withdrawFromAccount`, which names
 * a recipient. A function missing from `KURU_LEG_ABI` fails to decode and is
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
import { KURU_TESTNET_CONTRACTS, KURU_TESTNET_MARKETS, NATIVE_TOKEN } from '@sente/venues/kuru';
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  maxUint256,
  size,
  sliceHex,
  toFunctionSelector,
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
 * - `deposit` / `withdraw`: AccountCore calls; `value` is the MON the call sends.
 * - `place`: `batch(userId, [order], [])`, `market` being the call's target.
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
      readonly kind: 'place';
      readonly market: Address;
      readonly userId: bigint;
      readonly order: KuruOrder;
      readonly clientOrderId?: Hex;
    }
  | {
      readonly ok: true;
      readonly kind: 'cancel';
      readonly market: Address;
      readonly userId: bigint;
      readonly slots: readonly number[];
    };

export type KuruRefusal = { readonly ok: false; readonly problem: string };

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

/**
 * The whole allow-list. Exported only so the test can pin each selector to the
 * SDK's ABI; nothing else should decode with it.
 */
export const KURU_LEG_ABI = [APPROVE, DEPOSIT, WITHDRAW, BATCH, BATCH_WITH_CLIENT_ID] as const;

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
 * `withdrawFromAccount`, the builder-config `batch` overloads — lands on the
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
  return classifyBatch(call.to, args as BatchArgs);
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
type BatchArgs = [number, readonly RawOrder[], readonly number[], Hex?];

function classifyBatch(
  target: Address,
  [rawUserId, orders, slots, clientOrderId]: BatchArgs,
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
    return {
      ok: true,
      kind: 'place',
      market: getAddress(market.address),
      userId,
      order,
      ...(clientOrderId === undefined ? {} : { clientOrderId }),
    };
  }
  if (slots.length === 0) return refuse('the batch does nothing');
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
