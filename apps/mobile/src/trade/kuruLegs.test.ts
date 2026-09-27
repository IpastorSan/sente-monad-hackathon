/**
 * Kuru call classifier tests (SEN-92). Plain node, no device, no network.
 *
 * Accepted fixtures come from `@sente/venues/kuru` — the server's own encoders —
 * so a pass means the phone accepts what the server actually sends. The
 * refused functions are encoded with the Kuru SDK's ABI, i.e. exactly what a
 * compromised server could reach for.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cancelOrderCall,
  depositCalls,
  KURU_ACCOUNT_CORE_DEPOSIT_ABI,
  KURU_ACCOUNT_CORE_WITHDRAW_ABI,
  KURU_ORDERBOOK_BATCH_ABI,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  placeOrderCall,
  toClientOrderId,
  withdrawCall,
} from '@sente/venues/kuru';
// Why the SDK directly: the pin must be against the SDK's full ABI, not the
// filtered cuts `@sente/venues` re-exports. Resolves through the hoisted
// node_modules (`nodeLinker: hoisted`).
import { abi as kuruAbi } from '@toxicflow-labs/ts-sdk';
import {
  concatHex,
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  toFunctionSelector,
  toFunctionSignature,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';

import type { Erc7579Call } from '../wallet/batch.ts';
import { classifyKuruCall, KURU_LEG_ABI, type KuruLeg } from './kuruLegs.ts';

const ACCOUNT_CORE = KURU_TESTNET_CONTRACTS.accountCore;
const USDC = KURU_TESTNET_TOKENS.USDC;
const MON_USDC = KURU_TESTNET_MARKETS[0]!;
const STRANGER = '0x1111111111111111111111111111111111111111' as Address;

const ORDER = {
  side: 0,
  quantity: 50_000_000_000n,
  price: 20_000n,
  tif: 0,
  executionInstruction: 1,
  minSizeAfterBlock: 0n,
} as const;
const DECODED_ORDER = {
  side: 0,
  quantity: 50_000_000_000n,
  price: 20_000,
  tif: 0,
  executionInstruction: 1,
  minSizeAfterBlock: 0,
};

const functions = (abi: Abi | readonly unknown[]): AbiFunction[] =>
  (abi as Abi).filter((item): item is AbiFunction => item.type === 'function');

const sdkFunction = (abi: readonly unknown[], signature: string): AbiFunction => {
  const found = functions(abi).find((fn) => toFunctionSignature(fn) === signature);
  assert.ok(found, `${signature} is not in the SDK ABI`);
  return found;
};

function accepted(call: Erc7579Call): KuruLeg {
  const result = classifyKuruCall(call);
  assert.ok(result.ok, result.ok ? '' : result.problem);
  return result;
}

function refused(call: Erc7579Call, pattern: RegExp): void {
  const result = classifyKuruCall(call);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.problem, pattern);
}

// ---------------------------------------------------------------------------
// The hand-written allow-list is the SDK's, byte for byte
// ---------------------------------------------------------------------------

test('each hand-written fragment has the selector of its SDK counterpart', () => {
  const sources: Record<string, readonly unknown[]> = {
    'approve(address,uint256)': erc20Abi,
    'deposit(address,uint256)': kuruAbi.accountCoreAbi,
    'withdraw(address,uint256)': kuruAbi.accountCoreAbi,
    'batch(uint40,(uint8,uint96,uint32,uint8,uint8,uint32)[],uint8[])': kuruAbi.spotOrderBookAbi,
    'batch(uint40,(uint8,uint96,uint32,uint8,uint8,uint32)[],uint8[],bytes32)':
      kuruAbi.spotOrderBookAbi,
  };
  const ours = KURU_LEG_ABI.map((fn) => toFunctionSignature(fn));
  assert.deepEqual(ours.toSorted(), Object.keys(sources).toSorted());
  for (const fragment of KURU_LEG_ABI) {
    const signature = toFunctionSignature(fragment);
    assert.equal(
      toFunctionSelector(fragment),
      toFunctionSelector(sdkFunction(sources[signature]!, signature)),
      signature,
    );
  }
});

test('the fragments match what the server encodes with (@sente/venues cuts)', () => {
  const selectors = (abi: Abi) => functions(abi).map((fn) => toFunctionSelector(fn));
  const ours = new Set(KURU_LEG_ABI.map((fn) => toFunctionSelector(fn)));
  for (const selector of [
    ...selectors(KURU_ORDERBOOK_BATCH_ABI),
    ...selectors(KURU_ACCOUNT_CORE_DEPOSIT_ABI),
    ...selectors(KURU_ACCOUNT_CORE_WITHDRAW_ABI),
  ]) {
    assert.ok(ours.has(selector), selector);
  }
});

test('the SDK has exactly four batch overloads: ours plus the two builder-config ones', () => {
  // A new overload in an SDK bump should be looked at, not silently ignored.
  const batches = functions(kuruAbi.spotOrderBookAbi)
    .filter((fn) => fn.name === 'batch')
    .map((fn) => toFunctionSignature(fn))
    .toSorted();
  assert.deepEqual(batches, [
    'batch(uint40,(uint8,uint96,uint32,uint8,uint8,uint32)[],uint8[])',
    'batch(uint40,(uint8,uint96,uint32,uint8,uint8,uint32)[],uint8[],(address,uint32))',
    'batch(uint40,(uint8,uint96,uint32,uint8,uint8,uint32)[],uint8[],bytes32)',
    'batch(uint40,(uint8,uint96,uint32,uint8,uint8,uint32)[],uint8[],bytes32,(address,uint32))',
  ]);
});

// ---------------------------------------------------------------------------
// What the server sends is classified
// ---------------------------------------------------------------------------

test('an ERC-20 funding pair is an exact approve then a deposit', () => {
  const [approve, deposit] = depositCalls(ACCOUNT_CORE, USDC, 20_000_000n);
  assert.deepEqual(accepted(approve!), {
    ok: true,
    kind: 'approve',
    token: USDC.address,
    spender: ACCOUNT_CORE,
    amount: 20_000_000n,
  });
  assert.deepEqual(accepted(deposit!), {
    ok: true,
    kind: 'deposit',
    token: USDC.address,
    amount: 20_000_000n,
    value: 0n,
  });
});

test('a native MON deposit carries its amount as value', () => {
  const [deposit] = depositCalls(ACCOUNT_CORE, KURU_TESTNET_TOKENS.MON, 10n ** 18n);
  assert.deepEqual(accepted(deposit!), {
    ok: true,
    kind: 'deposit',
    token: KURU_TESTNET_TOKENS.MON.address,
    amount: 10n ** 18n,
    value: 10n ** 18n,
  });
});

test('a withdraw names only token and amount', () => {
  assert.deepEqual(accepted(withdrawCall(ACCOUNT_CORE, USDC, 5n)), {
    ok: true,
    kind: 'withdraw',
    token: USDC.address,
    amount: 5n,
  });
});

test('a place without a client order id uses the 3-argument batch', () => {
  assert.deepEqual(accepted(placeOrderCall(MON_USDC.address, ORDER)), {
    ok: true,
    kind: 'place',
    market: MON_USDC.address,
    userId: 0n,
    order: DECODED_ORDER,
  });
});

test('a place with a client order id uses the 4-argument batch and echoes it', () => {
  const clientOrderId = toClientOrderId('trade-42');
  assert.deepEqual(accepted(placeOrderCall(MON_USDC.address, ORDER, clientOrderId)), {
    ok: true,
    kind: 'place',
    market: MON_USDC.address,
    userId: 0n,
    order: DECODED_ORDER,
    clientOrderId,
  });
});

test('a cancel reports its slots', () => {
  assert.deepEqual(accepted(cancelOrderCall(MON_USDC.address, 3)), {
    ok: true,
    kind: 'cancel',
    market: MON_USDC.address,
    userId: 0n,
    slots: [3],
  });
});

test('a non-zero userId is reported, not hidden, for the verifier to refuse', () => {
  const data = encodeFunctionData({
    abi: KURU_LEG_ABI,
    functionName: 'batch',
    args: [7, [], [3]],
  });
  const leg = accepted({ to: MON_USDC.address, value: 0n, data });
  assert.equal(leg.kind === 'cancel' && leg.userId, 7n);
});

// ---------------------------------------------------------------------------
// Functions that are never signable
// ---------------------------------------------------------------------------

const BUILDER = { builder: STRANGER, feePps: 1_000 };

test('both builder-config batch overloads are refused', () => {
  for (const signature of [
    'batch(uint40,(uint8,uint96,uint32,uint8,uint8,uint32)[],uint8[],(address,uint32))',
    'batch(uint40,(uint8,uint96,uint32,uint8,uint8,uint32)[],uint8[],bytes32,(address,uint32))',
  ]) {
    const fragment = sdkFunction(kuruAbi.spotOrderBookAbi, signature);
    const tail = fragment.inputs.length === 5 ? [toClientOrderId('x'), BUILDER] : [BUILDER];
    const data = encodeFunctionData({
      abi: [fragment],
      functionName: 'batch',
      args: [0, [ORDER], [], ...tail],
    });
    refused({ to: MON_USDC.address, value: 0n, data }, /is not a Kuru call/);
  }
});

test('withdrawFromAccount is refused', () => {
  const data = encodeFunctionData({
    abi: kuruAbi.accountCoreAbi,
    functionName: 'withdrawFromAccount',
    args: [STRANGER, USDC.address, 5n],
  });
  refused({ to: ACCOUNT_CORE, value: 0n, data }, /is not a Kuru call/);
});

test('ERC-20 transfer and transferFrom are refused', () => {
  const transfer = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [STRANGER, 5n],
  });
  const transferFrom = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transferFrom',
    args: [STRANGER, STRANGER, 5n],
  });
  refused({ to: USDC.address, value: 0n, data: transfer }, /is not a Kuru call/);
  refused({ to: USDC.address, value: 0n, data: transferFrom }, /is not a Kuru call/);
});

test('an unlimited approval is refused', () => {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [ACCOUNT_CORE, maxUint256],
  });
  refused({ to: USDC.address, value: 0n, data }, /unlimited/);
});

test('an approval to anyone but AccountCore is refused', () => {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [STRANGER, 5n] });
  refused({ to: USDC.address, value: 0n, data }, /not Kuru's AccountCore/);
});

test('empty calldata is refused', () => {
  refused({ to: USDC.address, value: 0n }, /no function selector/);
});

// ---------------------------------------------------------------------------
// Off-canonical encodings
// ---------------------------------------------------------------------------

test('a trailing byte is refused', () => {
  const call = placeOrderCall(MON_USDC.address, ORDER);
  refused({ ...call, data: concatHex([call.data!, '0x00']) }, /not canonically encoded/);
});

test('dirty padding on an address word is refused', () => {
  const call = withdrawCall(ACCOUNT_CORE, USDC, 5n);
  // Byte 4 is the first padding byte of the `token` word.
  const data = `0x${call.data!.slice(2, 10)}ff${call.data!.slice(12)}` as Hex;
  refused({ ...call, data }, /not canonically encoded|does not decode/);
});

test('a non-canonical array offset is refused', () => {
  // cancelSlotIdxs offset 0x80 -> 0xa0 with a 32-byte gap: decodes, but the
  // server's encoder never emits it.
  const call = cancelOrderCall(MON_USDC.address, 3);
  const words = call.data!.slice(10).match(/.{64}/g)!;
  words[2] = (0xa0).toString(16).padStart(64, '0');
  words.splice(4, 0, '0'.repeat(64));
  refused({ ...call, data: `${call.data!.slice(0, 10)}${words.join('')}` as Hex }, /canonical/);
});

// ---------------------------------------------------------------------------
// Context-free value rules
// ---------------------------------------------------------------------------

test('value on a place, approve or withdraw is refused', () => {
  refused({ ...placeOrderCall(MON_USDC.address, ORDER), value: 1n }, /carries value/);
  refused({ ...depositCalls(ACCOUNT_CORE, USDC, 5n)[0]!, value: 1n }, /carries value/);
  refused({ ...withdrawCall(ACCOUNT_CORE, USDC, 5n), value: 1n }, /carries value/);
});

test('a token deposit sending MON is refused', () => {
  refused({ ...depositCalls(ACCOUNT_CORE, USDC, 5n)[1]!, value: 1n }, /also sends MON/);
});

test('a native deposit whose value differs from its amount is refused', () => {
  const [deposit] = depositCalls(ACCOUNT_CORE, KURU_TESTNET_TOKENS.MON, 10n ** 18n);
  refused({ ...deposit!, value: 10n ** 18n - 1n }, /different value/);
});

test('AccountCore calls to another address are refused', () => {
  refused({ ...depositCalls(ACCOUNT_CORE, USDC, 5n)[1]!, to: STRANGER }, /not AccountCore/);
  refused({ ...withdrawCall(ACCOUNT_CORE, USDC, 5n), to: STRANGER }, /not AccountCore/);
});

// ---------------------------------------------------------------------------
// Batch shape
// ---------------------------------------------------------------------------

const batch = (args: readonly unknown[]): Erc7579Call => ({
  to: MON_USDC.address,
  value: 0n,
  data: encodeFunctionData({ abi: KURU_LEG_ABI, functionName: 'batch', args: args as never }),
});

test('an order to a market outside the allow-list is refused', () => {
  refused({ ...placeOrderCall(MON_USDC.address, ORDER), to: STRANGER }, /not a Kuru market/);
});

test('a batch that places and cancels, places twice, or does nothing is refused', () => {
  refused(batch([0, [ORDER], [3]]), /both places and cancels/);
  refused(batch([0, [ORDER, ORDER], []]), /more than one order/);
  refused(batch([0, [], []]), /does nothing/);
});

test('a cancel with a client order id is refused', () => {
  refused(batch([0, [], [3], toClientOrderId('x')]), /client order id/);
});

test('out-of-range enum values are refused', () => {
  refused(batch([0, [{ ...ORDER, side: 2 }], []]), /side 2/);
  refused(batch([0, [{ ...ORDER, tif: 3 }], []]), /time-in-force 3/);
  refused(batch([0, [{ ...ORDER, executionInstruction: 2 }], []]), /execution instruction 2/);
});
