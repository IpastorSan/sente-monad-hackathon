/**
 * Order encoding: what the account signs. Plain node, no network.
 *
 * The batch calldata is assembled here word by word from the ABI layout
 * rather than by calling an encoder, so the SDK's encoder and this test would
 * have to drift the same way to stay green. The selector is also pinned to the
 * value the SDK produced in the live Kernel simulation on 2026-09-10.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { abi as kuruAbi } from '@toxicflow-labs/ts-sdk';
import {
  decodeFunctionData,
  erc20Abi,
  keccak256,
  toBytes,
  toFunctionSelector,
  type Hex,
} from 'viem';

import { KURU_TESTNET_CONTRACTS, KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from './constants.ts';
import {
  cancelOrderCall,
  depositCalls,
  encodeNativeOrder,
  faucetClaimCall,
  formatOrderId,
  KuruOrderError,
  parseOrderId,
  placeOrderCall,
  toClientOrderId,
  type KuruMarketParams,
} from './orders.ts';

const MON_USDC = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'MON-USDC')!;

const PARAMS: KuruMarketParams = {
  pricePrecision: 1_000_000n,
  sizePrecision: 100_000_000n,
  tickSize: 1n,
  minQuoteNotional: 10_000_000n, // 10 USDC
  maxQuoteNotional: 5_000_000_000_000n,
  takerFeePps: 7000n,
  makerFeePps: 4000n,
};

/** One 32-byte ABI word. */
const word = (value: bigint | number): string => BigInt(value).toString(16).padStart(64, '0');

/** `NativeOrder` is (side uint8, quantity uint96, price uint32, tif uint8, execInstr uint8, rab uint32). */
const BATCH = 'batch(uint40,(uint8,uint96,uint32,uint8,uint8,uint32)[],uint8[])';
const BATCH_WITH_CLIENT_ID =
  'batch(uint40,(uint8,uint96,uint32,uint8,uint8,uint32)[],uint8[],bytes32)';

test('a 500 MON bid at 0.02 USDC encodes to native book units', () => {
  assert.deepEqual(encodeNativeOrder({ side: 'buy', price: '0.02', size: '500' }, PARAMS, 6), {
    side: 'buy',
    quantity: 50_000_000_000n, // 500 * 1e8
    price: 20_000n, // 0.02 * 1e6
    tif: 'gtc',
    executionInstruction: 'none',
    minSizeAfterBlock: 0n,
  });
});

test('time in force: POST_ONLY is GTC plus an execution instruction', () => {
  const at = (timeInForce: 'GTC' | 'IOC' | 'FOK' | 'POST_ONLY') =>
    encodeNativeOrder({ side: 'sell', price: '0.03', size: '500', timeInForce }, PARAMS, 6);
  assert.equal(at('IOC').tif, 'ioc');
  assert.equal(at('FOK').tif, 'fok');
  assert.equal(at('POST_ONLY').tif, 'gtc');
  assert.equal(at('POST_ONLY').executionInstruction, 'postOnly');
  assert.equal(at('GTC').executionInstruction, 'none');
});

test('orders the contract would reject are refused before anything is signed', () => {
  const encode = (price: string, size: string, params = PARAMS) =>
    encodeNativeOrder({ side: 'buy', price, size }, params, 6);
  assert.throws(() => encode('0.0000105', '1000000'), /decimal places/); // finer than a tick unit
  assert.throws(() => encode('0.000015', '1000000', { ...PARAMS, tickSize: 10n }), /not on a tick/);
  assert.throws(() => encode('0', '500'), KuruOrderError);
  assert.throws(() => encode('0.02', '0'), KuruOrderError);
  assert.throws(() => encode('0.02', '100'), /below the market minimum of 10/); // 2 USDC
  assert.throws(() => encode('5000', '1'), /outside this market's range/); // price > uint32
});

test('placeOrderCall: batch(0, [order], []) word by word', () => {
  const order = encodeNativeOrder({ side: 'buy', price: '0.02', size: '500' }, PARAMS, 6);
  const call = placeOrderCall(MON_USDC.address, order);

  assert.equal(toFunctionSelector(BATCH), '0x0a7e0c6f');
  assert.equal(call.to, MON_USDC.address);
  assert.equal(call.value, 0n);
  assert.equal(
    call.data,
    '0x0a7e0c6f' +
      word(0) + //       userId: 0 = the calling account
      word(0x60) + //    offset of orders[]
      word(0x140) + //   offset of cancelSlotIdxs[] = 0x60 + 32 + 6 * 32
      word(1) + //       orders.length
      word(0) + //       side BUY
      word(50_000_000_000n) + // quantity
      word(20_000) + //  price
      word(0) + //       tif GTC
      word(0) + //       executionInstruction NONE
      word(0) + //       minSizeAfterBlock: RAB off
      word(0), //        cancelSlotIdxs.length
  );
});

test('a client order id selects the bytes32 overload and is echoed verbatim', () => {
  const order = encodeNativeOrder({ side: 'buy', price: '0.02', size: '500' }, PARAMS, 6);
  const clientOrderId = toClientOrderId('agent-7/rebalance-42');
  const call = placeOrderCall(MON_USDC.address, order, clientOrderId);
  assert.ok(call.data!.startsWith(toFunctionSelector(BATCH_WITH_CLIENT_ID)));
  const { args } = decodeFunctionData({ abi: kuruAbi.spotOrderBookAbi, data: call.data! });
  assert.equal(args[3], clientOrderId);
});

test('cancelOrderCall: batch(0, [], [slot]) word by word', () => {
  const call = cancelOrderCall(MON_USDC.address, 3);
  assert.equal(
    call.data,
    '0x0a7e0c6f' +
      word(0) + //    userId
      word(0x60) + // offset of orders[]
      word(0x80) + // offset of cancelSlotIdxs[] = 0x60 + 32
      word(0) + //    orders.length
      word(1) + //    cancelSlotIdxs.length
      word(3), //     slot 3
  );
});

test('an ERC-20 deposit is an exact approve to AccountCore, then deposit', () => {
  const calls = depositCalls(
    KURU_TESTNET_CONTRACTS.accountCore,
    KURU_TESTNET_TOKENS.USDC,
    20_000_000n,
  );
  assert.equal(calls.length, 2);

  const [approve, deposit] = calls;
  assert.equal(approve!.to, KURU_TESTNET_TOKENS.USDC.address);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: approve!.data! }), {
    functionName: 'approve',
    args: [KURU_TESTNET_CONTRACTS.accountCore, 20_000_000n],
  });

  assert.equal(deposit!.to, KURU_TESTNET_CONTRACTS.accountCore);
  assert.equal(deposit!.value, 0n);
  assert.equal(deposit!.data!.slice(0, 10), toFunctionSelector('deposit(address,uint256)'));
  const decoded = decodeFunctionData({ abi: kuruAbi.accountCoreAbi, data: deposit!.data! });
  assert.deepEqual(decoded.args, [KURU_TESTNET_TOKENS.USDC.address, 20_000_000n]);
});

test('a native MON deposit is one payable call carrying the amount as value', () => {
  const calls = depositCalls(
    KURU_TESTNET_CONTRACTS.accountCore,
    KURU_TESTNET_TOKENS.MON,
    10n ** 18n,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.to, KURU_TESTNET_CONTRACTS.accountCore);
  assert.equal(calls[0]!.value, 10n ** 18n);
});

test('a zero deposit is refused', () => {
  assert.throws(
    () => depositCalls(KURU_TESTNET_CONTRACTS.accountCore, KURU_TESTNET_TOKENS.USDC, 0n),
    KuruOrderError,
  );
});

test('the faucet claim is a bare claim() to the faucet', () => {
  assert.deepEqual(faucetClaimCall(), {
    to: KURU_TESTNET_CONTRACTS.testnetTokenFaucet,
    value: 0n,
    data: toFunctionSelector('claim()'),
  });
});

test('client order ids: 32-byte hex passes through, anything else is hashed', () => {
  const raw: Hex = `0x${'ab'.repeat(32)}`;
  assert.equal(toClientOrderId(raw), raw);
  assert.equal(toClientOrderId('order-1'), keccak256(toBytes('order-1')));
  assert.equal(toClientOrderId('0xabc'), keccak256(toBytes('0xabc'))); // short hex is just a string
});

test('order ids bind slot and order id, and reject anything else', () => {
  assert.equal(formatOrderId({ slotIdx: 7, orderId: 23818n }), '7:23818');
  assert.deepEqual(parseOrderId('7:23818'), { slotIdx: 7, orderId: 23818n });
  for (const bad of ['23818', '7:', ':1', '256:1', '0x7:1', '7:1:2']) {
    assert.throws(() => parseOrderId(bad), KuruOrderError, bad);
  }
});
