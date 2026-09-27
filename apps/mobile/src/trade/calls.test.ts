/**
 * Call-list decoder tests (SEN-85). Plain node, no device, no network.
 *
 * Fixtures come from `permissionless` — the server's encoder — so a pass here
 * means the phone accepts what the server actually sends; the refusals are
 * hand-built so each one isolates a single rule.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encode7579Calls } from 'permissionless/utils';
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  toHex,
  type Address,
  type Hex,
} from 'viem';

import {
  CALL_TYPE,
  encodeExecutionMode,
  ERC7579_EXECUTE_ABI,
  EXEC_TYPE,
  type Erc7579Call,
} from '../wallet/batch.ts';
import { decodeTransactionCalls } from './calls.ts';

const WALLET = '0xaaaabbbbccccddddeeeeffff0000111122223333' as Address;
const AUSD = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc' as Address;
const ACCOUNT_CORE = '0x2222222222222222222222222222222222222222' as Address;
const MARKET = '0x3333333333333333333333333333333333333333' as Address;

const APPROVE = encodeFunctionData({
  abi: erc20Abi,
  functionName: 'approve',
  args: [ACCOUNT_CORE, 10_000_000n],
});
const LEGS: Erc7579Call[] = [
  { to: AUSD, value: 0n, data: APPROVE },
  { to: ACCOUNT_CORE, value: 0n, data: '0x47e7ef24' },
  { to: MARKET, value: 0n, data: '0xdeadbeef' },
];

const viaPermissionless = (calls: readonly Erc7579Call[]): Hex =>
  encode7579Calls({
    // `revertOnError: false` emits exec type 0x00, which IS revert-on-failure.
    mode: { type: calls.length > 1 ? 'batchcall' : 'call', revertOnError: false },
    callData: calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? '0x' })),
  });

const execute = (mode: Hex, executionCalldata: Hex): Hex =>
  encodeFunctionData({
    abi: ERC7579_EXECUTE_ABI,
    functionName: 'execute',
    args: [mode, executionCalldata],
  });

const batchCalldata = (calls: readonly Erc7579Call[]): Hex =>
  encodeAbiParameters(
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
    [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, callData: c.data ?? '0x' }))],
  );

const packed = (call: Erc7579Call): Hex =>
  concatHex([call.to, toHex(call.value ?? 0n, { size: 32 }), call.data ?? '0x']);

const selfTx = (data: Hex): Record<string, unknown> => ({ to: WALLET, data, chain_id: 10143 });

function assertRefused(tx: unknown, pattern: RegExp): void {
  const result = decodeTransactionCalls(tx, WALLET);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.problem, pattern);
}

const lower = (calls: readonly Erc7579Call[]) =>
  calls.map((c) => ({ to: c.to.toLowerCase(), value: c.value, data: c.data?.toLowerCase() }));

// ---------------------------------------------------------------------------
// Accepted shapes
// ---------------------------------------------------------------------------

test('a direct call is one unbatched call', () => {
  const result = decodeTransactionCalls(
    { to: getAddress(AUSD), data: APPROVE, chain_id: 10143 },
    WALLET,
  );
  assert.deepEqual(result, {
    ok: true,
    calls: [{ to: getAddress(AUSD), value: 0n, data: APPROVE }],
    batched: false,
  });
});

test('a direct native deposit keeps its value', () => {
  const result = decodeTransactionCalls(
    { to: ACCOUNT_CORE, data: '0x47e7ef24', value: '0xde0b6b3a7640000', chain_id: 10143 },
    WALLET,
  );
  assert.ok(result.ok);
  assert.equal(result.calls[0]?.value, 10n ** 18n);
});

test('a permissionless 3-leg batch decodes to the same legs, batched', () => {
  const result = decodeTransactionCalls(selfTx(viaPermissionless(LEGS)), WALLET);
  assert.ok(result.ok, result.ok ? '' : result.problem);
  assert.equal(result.batched, true);
  assert.deepEqual(lower(result.calls), lower(LEGS));
});

test('a permissionless single-mode wrapper decodes to one unbatched call', () => {
  const leg: Erc7579Call = { to: ACCOUNT_CORE, value: 5n, data: '0x47e7ef24' };
  const result = decodeTransactionCalls(selfTx(viaPermissionless([leg])), WALLET);
  assert.ok(result.ok, result.ok ? '' : result.problem);
  assert.equal(result.batched, false);
  assert.deepEqual(lower(result.calls), lower([leg]));
});

test('a single-mode call with empty data decodes', () => {
  const leg: Erc7579Call = { to: ACCOUNT_CORE, value: 1n, data: '0x' };
  const result = decodeTransactionCalls(selfTx(viaPermissionless([leg])), WALLET);
  assert.ok(result.ok);
  assert.equal(result.calls[0]?.data, '0x');
});

test('the wallet matches regardless of address casing', () => {
  const data = viaPermissionless(LEGS);
  const checksummed = decodeTransactionCalls({ to: getAddress(WALLET), data }, WALLET);
  assert.ok(checksummed.ok && checksummed.batched);
  const lowered = decodeTransactionCalls({ to: WALLET, data }, getAddress(WALLET));
  assert.ok(lowered.ok && lowered.batched);
});

test('a badly checksummed address is refused rather than guessed at', () => {
  const garbled = WALLET.toUpperCase().replace('0X', '0x');
  assertRefused({ to: garbled, data: viaPermissionless(LEGS) }, /valid "to"/);
});

// ---------------------------------------------------------------------------
// Refusals — execution mode
// ---------------------------------------------------------------------------

test('delegatecall mode is refused', () => {
  const mode = encodeExecutionMode(CALL_TYPE.delegatecall, EXEC_TYPE.revertOnFailure);
  assertRefused(selfTx(execute(mode, packed(LEGS[2]!))), /execution mode/);
});

test('try-mode batch is refused, including the permissionless encoding of it', () => {
  const mode = encodeExecutionMode(CALL_TYPE.batch, EXEC_TYPE.try);
  assertRefused(selfTx(execute(mode, batchCalldata(LEGS))), /execution mode/);
  const theirs = encode7579Calls({
    mode: { type: 'batchcall', revertOnError: true },
    callData: LEGS.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? '0x' })),
  });
  assertRefused(selfTx(theirs), /execution mode/);
});

test('try-mode single call is refused', () => {
  const mode = encodeExecutionMode(CALL_TYPE.single, EXEC_TYPE.try);
  assertRefused(selfTx(execute(mode, packed(LEGS[2]!))), /execution mode/);
});

test('a non-zero mode selector is refused', () => {
  const mode = `0x0100000000001234${'00'.repeat(24)}` as Hex;
  assertRefused(selfTx(execute(mode, batchCalldata(LEGS))), /execution mode/);
});

// ---------------------------------------------------------------------------
// Refusals — legs and encoding
// ---------------------------------------------------------------------------

test('a nested self-call is refused in batch and single mode', () => {
  const nested: Erc7579Call = { to: WALLET, value: 0n, data: viaPermissionless(LEGS) };
  assertRefused(selfTx(viaPermissionless([LEGS[0]!, nested])), /call 1 targets your wallet/);
  assertRefused(selfTx(viaPermissionless([nested])), /call 0 targets your wallet/);
});

test('trailing bytes after execute are refused', () => {
  assertRefused(selfTx(concatHex([viaPermissionless(LEGS), '0x00'])), /canonical/);
  assertRefused(selfTx(concatHex([viaPermissionless(LEGS), `0x${'00'.repeat(32)}`])), /canonical/);
});

test('a one-leg batch-mode wrapper is refused (the server always uses single mode)', () => {
  const mode = encodeExecutionMode(CALL_TYPE.batch, EXEC_TYPE.revertOnFailure);
  assertRefused(selfTx(execute(mode, batchCalldata([LEGS[0]!]))), /canonical/);
});

test('an empty batch is refused', () => {
  const mode = encodeExecutionMode(CALL_TYPE.batch, EXEC_TYPE.revertOnFailure);
  assertRefused(selfTx(execute(mode, batchCalldata([]))), /no calls/);
});

test('a non-canonical batch offset is refused', () => {
  // Same legs, but the head offset points 32 bytes further with a zero pad in
  // between: decodes identically, encodes differently.
  const canonical = batchCalldata(LEGS);
  const shifted = concatHex([
    toHex(64n, { size: 32 }),
    `0x${'00'.repeat(32)}`,
    `0x${canonical.slice(2 + 64)}`,
  ]);
  const mode = encodeExecutionMode(CALL_TYPE.batch, EXEC_TYPE.revertOnFailure);
  assertRefused(selfTx(execute(mode, shifted)), /canonical/);
});

test('a truncated single call is refused', () => {
  const mode = encodeExecutionMode(CALL_TYPE.single, EXEC_TYPE.revertOnFailure);
  assertRefused(selfTx(execute(mode, AUSD)), /truncated/);
});

test('a self-call that is not execute is refused', () => {
  assertRefused(selfTx(APPROVE), /not execute/);
});

test('a self-call without data or with value is refused', () => {
  assertRefused({ to: WALLET }, /no data/);
  assertRefused({ ...selfTx(viaPermissionless(LEGS)), value: '0x1' }, /carries value/);
});

// ---------------------------------------------------------------------------
// Refusals — transaction shape
// ---------------------------------------------------------------------------

test('malformed transactions are refused', () => {
  assertRefused(null, /not an object/);
  assertRefused([], /not an object/);
  assertRefused({ to: AUSD, data: APPROVE, from: WALLET }, /also carries from/);
  assertRefused({ data: APPROVE }, /valid "to"/);
  assertRefused({ to: '0x1234', data: APPROVE }, /valid "to"/);
  assertRefused({ to: AUSD, data: 'approve' }, /not hex/);
  assertRefused({ to: AUSD, data: '0x095' }, /not hex/);
});

test('only a canonical hex quantity is accepted as value', () => {
  for (const value of [1, '1', '0x', '0x01', '-0x1', 1n]) {
    assertRefused({ to: ACCOUNT_CORE, value }, /hex quantity/);
  }
  assert.ok(decodeTransactionCalls({ to: ACCOUNT_CORE, value: '0x0' }, WALLET).ok);
});

test('an invalid wallet address is refused', () => {
  const result = decodeTransactionCalls({ to: AUSD, data: APPROVE }, '0xnope' as Address);
  assert.equal(result.ok, false);
});
