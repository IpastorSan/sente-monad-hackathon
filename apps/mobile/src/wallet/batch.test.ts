/**
 * ERC-7579 batch encoder tests. Plain node, no device, no network.
 *
 * Two independent standards of proof, because this encoder decides what the
 * user's signature authorises:
 *
 *   1. HAND-COMPUTED BYTES. The expected calldata is assembled here word by
 *      word from the ABI layout, with every 32-byte word labelled. If viem's
 *      encoder and this test both drifted, they would have to drift the same
 *      way to stay green.
 *   2. CROSS-CHECK AGAINST `permissionless`. The server encodes with
 *      `permissionless`; the client verifies with `./batch.ts`. If the two ever
 *      disagree the client would refuse to sign a perfectly good batch, so the
 *      agreement is itself a property worth testing.
 *
 * `./batch.ts` is imported with its extension because node's native type
 * stripping resolves specifiers literally — same as `auth/derive.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encode7579Calls } from 'permissionless/utils';
import { toFunctionSelector, type Address, type Hex } from 'viem';

import {
  assertCallDataMatches,
  BATCH_EXECUTION_MODE,
  BatchMismatchError,
  CALL_TYPE,
  encodeBatchExecutionCalldata,
  encodeExecutionMode,
  encodeKernelExecute,
  encodeSingleExecutionCalldata,
  EXEC_TYPE,
  InvalidCallError,
  isSameCallData,
  SINGLE_EXECUTION_MODE,
  type Erc7579Call,
} from './batch.ts';

/** Real Monad testnet addresses, lowercased — see docs/monad-testnet-assets.md. */
const AUSD = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc' as Address;
const PERPL_EXCHANGE = '0x1964c32f0be608e7d29302aff5e61268e72080cc' as Address;

/** `approve(address,uint256)` and `createAccount(uint256)` selectors, args elided. */
const APPROVE = '0x095ea7b3' as Hex;
const CREATE_ACCOUNT = '0xcab13915' as Hex;

const TWO_CALLS: readonly Erc7579Call[] = [
  { to: AUSD, value: 0n, data: APPROVE },
  { to: PERPL_EXCHANGE, value: 0n, data: CREATE_ACCOUNT },
];

/** Joins labelled 32-byte words into a hex body. Whitespace and labels stripped. */
const words = (...hex: string[]): string => {
  const body = hex.join('');
  assert.equal(body.length % 64, 0, 'expected whole 32-byte words');
  return body;
};

// ---------------------------------------------------------------------------
// The mode word
// ---------------------------------------------------------------------------

test('the batch mode word is 0x01 batch, 0x00 revert-on-failure, then zeroes', () => {
  assert.equal(
    BATCH_EXECUTION_MODE,
    '0x0100000000000000000000000000000000000000000000000000000000000000',
  );
  // Spelled out byte by byte so a wrong constant cannot hide behind a typo.
  assert.equal(BATCH_EXECUTION_MODE.slice(2, 4), '01', 'byte 0: callType = batch');
  assert.equal(BATCH_EXECUTION_MODE.slice(4, 6), '00', 'byte 1: execType = revert on failure');
  assert.equal(BATCH_EXECUTION_MODE.slice(6), '0'.repeat(60), 'bytes 2-31: unused');
  assert.equal(BATCH_EXECUTION_MODE.length, 66, 'a bytes32 is 32 bytes');
});

test('the single-call mode word is all zeroes', () => {
  assert.equal(
    SINGLE_EXECUTION_MODE,
    '0x0000000000000000000000000000000000000000000000000000000000000000',
  );
});

test('execType 0x01 (try) is reachable but is never what we encode', () => {
  // Kept honest: the encoder must be *choosing* 0x00, not incapable of 0x01.
  // A batch that silently swallows a failed leg would strand a user mid-flow.
  const tryMode = encodeExecutionMode(CALL_TYPE.batch, EXEC_TYPE.try);
  assert.equal(tryMode.slice(4, 6), '01');
  assert.notEqual(tryMode, BATCH_EXECUTION_MODE);
  assert.equal(encodeKernelExecute(TWO_CALLS).slice(10, 74), BATCH_EXECUTION_MODE.slice(2));
});

// ---------------------------------------------------------------------------
// The selector
// ---------------------------------------------------------------------------

test('the function selector is execute(bytes32,bytes)', () => {
  const selector = toFunctionSelector('execute(bytes32,bytes)');
  assert.equal(selector, '0xe9ae5c53');
  assert.equal(encodeKernelExecute(TWO_CALLS).slice(0, 10), selector);
  // NOT executeBatch(Call[]) — that is Coinbase Smart Wallet's interface and
  // Kernel reverts on it with InvalidSelector().
  assert.notEqual(selector, toFunctionSelector('executeBatch((address,uint256,bytes)[])'));
});

// ---------------------------------------------------------------------------
// A 2-call batch, hand-computed
// ---------------------------------------------------------------------------

test('a 2-call batch encodes to exactly the hand-computed bytes', () => {
  const expectedCallData =
    '0xe9ae5c53' +
    words(
      // --- execute() head -----------------------------------------------
      '0100000000000000000000000000000000000000000000000000000000000000', // execMode: batch / revert-on-fail
      '0000000000000000000000000000000000000000000000000000000000000040', // offset to executionCalldata = 0x40
      '00000000000000000000000000000000000000000000000000000000000001c0', // executionCalldata length = 448
      // --- executionCalldata = abi.encode(Execution[]) ------------------
      '0000000000000000000000000000000000000000000000000000000000000020', // offset to the array = 0x20
      '0000000000000000000000000000000000000000000000000000000000000002', // array length = 2
      '0000000000000000000000000000000000000000000000000000000000000040', // offset of element 0 = 0x40
      '00000000000000000000000000000000000000000000000000000000000000e0', // offset of element 1 = 0xe0
      // --- element 0: AUSD.approve --------------------------------------
      '000000000000000000000000a9012a055bd4e0edff8ce09f960291c09d5322dc', // target
      '0000000000000000000000000000000000000000000000000000000000000000', // value = 0
      '0000000000000000000000000000000000000000000000000000000000000060', // offset to callData = 0x60
      '0000000000000000000000000000000000000000000000000000000000000004', // callData length = 4
      '095ea7b300000000000000000000000000000000000000000000000000000000', // approve selector, right-padded
      // --- element 1: Exchange.createAccount ----------------------------
      '0000000000000000000000001964c32f0be608e7d29302aff5e61268e72080cc', // target
      '0000000000000000000000000000000000000000000000000000000000000000', // value = 0
      '0000000000000000000000000000000000000000000000000000000000000060', // offset to callData = 0x60
      '0000000000000000000000000000000000000000000000000000000000000004', // callData length = 4
      'cab1391500000000000000000000000000000000000000000000000000000000', // createAccount selector, padded
    );

  assert.equal(encodeKernelExecute(TWO_CALLS), expectedCallData);
});

test('the batch execution calldata length matches its own declared length', () => {
  // 0x1c0 above is not a magic number: 2 words of array header + 2 offset
  // words + 5 words per element.
  const inner = encodeBatchExecutionCalldata(TWO_CALLS);
  const byteLength = (inner.length - 2) / 2;
  assert.equal(byteLength, 32 * (1 + 1 + 2) + 32 * 5 * 2);
  assert.equal(byteLength, 0x1c0);
});

test('a value-bearing leg puts the value in the tuple, not the packed word', () => {
  const withValue = encodeBatchExecutionCalldata([
    { to: AUSD, value: 1_000_000n, data: '0x' },
    { to: PERPL_EXCHANGE, value: 0n, data: '0x' },
  ]);
  // 1_000_000 = 0xf4240, in the second word of element 0.
  assert.ok(withValue.includes('00000000000000000000000000000000000000000000000000000000000f4240'));
});

// ---------------------------------------------------------------------------
// A single call: packed, not ABI-encoded
// ---------------------------------------------------------------------------

test('a single call uses call type 0x00 and the PACKED execution calldata', () => {
  const expected =
    '0xe9ae5c53' +
    words(
      '0000000000000000000000000000000000000000000000000000000000000000', // execMode: single / revert-on-fail
      '0000000000000000000000000000000000000000000000000000000000000040', // offset to executionCalldata
      '0000000000000000000000000000000000000000000000000000000000000038', // length = 0x38 = 20 + 32 + 4
      // abi.encodePacked(address, uint256, bytes) — no offsets, no length prefix
      'a9012a055bd4e0edff8ce09f960291c09d5322dc' + // 20-byte target
        '0000000000000000000000000000000000000000000000000000000000000000' + // 32-byte value
        '095ea7b3' + // 4-byte calldata
        '0000000000000000', // 8 bytes of tail padding: 20 + 32 + 4 = 56 -> 64
    );

  assert.equal(encodeKernelExecute([TWO_CALLS[0]!]), expected);
  assert.equal(
    encodeSingleExecutionCalldata(TWO_CALLS[0]!),
    '0xa9012a055bd4e0edff8ce09f960291c09d5322dc' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '095ea7b3',
  );
});

// ---------------------------------------------------------------------------
// Agreement with permissionless — the server's encoder
// ---------------------------------------------------------------------------

const viaPermissionless = (calls: readonly Erc7579Call[]): Hex =>
  encode7579Calls({
    mode: {
      type: calls.length > 1 ? 'batchcall' : 'call',
      // NOTE the inverted naming: permissionless's `revertOnError: false` emits
      // execType byte 0x00, which IS revert-on-failure. Verified by asserting
      // the mode word below rather than trusting the flag name.
      revertOnError: false,
      selector: '0x',
      context: '0x',
    },
    callData: calls.map((call) => ({
      to: call.to,
      value: call.value ?? 0n,
      data: call.data ?? '0x',
    })),
  });

test('agrees with permissionless on a 2-call batch', () => {
  const theirs = viaPermissionless(TWO_CALLS);
  assert.equal(theirs.slice(10, 74), BATCH_EXECUTION_MODE.slice(2), 'same mode word');
  assert.ok(isSameCallData(encodeKernelExecute(TWO_CALLS), theirs));
});

test('agrees with permissionless on a single call and on a 3-call batch', () => {
  const one = [TWO_CALLS[0]!];
  const three: Erc7579Call[] = [
    ...TWO_CALLS,
    { to: PERPL_EXCHANGE, value: 0n, data: '0x7962f910' }, // allowOrderForwarding(bool)
  ];
  assert.ok(isSameCallData(encodeKernelExecute(one), viaPermissionless(one)));
  assert.ok(isSameCallData(encodeKernelExecute(three), viaPermissionless(three)));
});

// ---------------------------------------------------------------------------
// The client-side guard
// ---------------------------------------------------------------------------

test('assertCallDataMatches accepts the server encoding the same calls', () => {
  assert.doesNotThrow(() => assertCallDataMatches(TWO_CALLS, viaPermissionless(TWO_CALLS)));
});

test('assertCallDataMatches rejects a swapped recipient', () => {
  const tampered = viaPermissionless([
    TWO_CALLS[0]!,
    { ...TWO_CALLS[1]!, to: '0x000000000000000000000000000000000000dead' as Address },
  ]);
  assert.throws(() => assertCallDataMatches(TWO_CALLS, tampered), BatchMismatchError);
});

test('assertCallDataMatches rejects an extra appended call', () => {
  const tampered = viaPermissionless([
    ...TWO_CALLS,
    { to: AUSD, value: 0n, data: '0xa9059cbb' }, // a sneaky transfer(...)
  ]);
  assert.throws(() => assertCallDataMatches(TWO_CALLS, tampered), BatchMismatchError);
});

test('checksummed and lowercased addresses compare equal', () => {
  // The packed single-call encoding copies `to` verbatim, so string equality
  // would reject a correct batch purely on hex case.
  const checksummed = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC' as Address;
  assert.doesNotThrow(() =>
    assertCallDataMatches(
      [{ to: AUSD, value: 0n, data: APPROVE }],
      viaPermissionless([{ to: checksummed, value: 0n, data: APPROVE }]),
    ),
  );
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('an empty batch is refused rather than encoded', () => {
  assert.throws(() => encodeKernelExecute([]), InvalidCallError);
});

test('a malformed target is refused', () => {
  assert.throws(
    () => encodeKernelExecute([{ to: '0xnope' as Address, data: APPROVE }]),
    InvalidCallError,
  );
});
