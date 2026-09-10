/**
 * ERC-7579 batch encoding for the Kernel smart account.
 *
 * WHY THIS EXISTS AT ALL, given `permissionless` already ships an encoder:
 * the server builds the UserOperation and the client signs it. If the client
 * verified the server's `callData` by calling the same library function the
 * server called, it would verify nothing — it would only prove the two ran the
 * same code. So this is a deliberate, independent, hand-written second
 * implementation, and `assertCallDataMatches` is the check that the batch the
 * user is about to sign is the batch the user asked for.
 *
 * `batch.test.ts` pins it against hand-computed bytes AND cross-checks it
 * against `permissionless`, so a divergence in either direction is a test
 * failure rather than a signature over the wrong calls.
 *
 * ---------------------------------------------------------------------------
 * THE INTERFACE
 *
 * Kernel does NOT implement `executeBatch(Call[])` — that is Coinbase Smart
 * Wallet's shape, and calling it on a Kernel account reverts with
 * `InvalidSelector()`. Kernel implements the ERC-7579 standard executor:
 *
 *     function execute(bytes32 execMode, bytes executionCalldata) payable
 *
 * `execMode` is a packed bytes32:
 *
 *     byte  0      callType    0x00 single | 0x01 batch | 0xff delegatecall
 *     byte  1      execType    0x00 revert-on-failure | 0x01 try
 *     bytes 2-5    unused      zero
 *     bytes 6-9    modeSelector
 *     bytes 10-31  modePayload
 *
 * We only ever use `0x00`/`0x01` for the call type and ALWAYS `0x00` for the
 * exec type: a half-applied onboarding sequence is worse than a failed one.
 *
 * `executionCalldata` is shaped by the call type, and the two shapes are NOT
 * the same encoding:
 *
 *     batch  (0x01)  abi.encode(Execution[]) where Execution = (address,uint256,bytes)
 *     single (0x00)  abi.encodePacked(address target, uint256 value, bytes data)
 *
 * ---------------------------------------------------------------------------
 * WHAT IT BUYS
 *
 * Perpl onboarding is three transactions and three failure modes —
 * `approve` -> `createAccount` -> `allowOrderForwarding` (see
 * docs/monad-testnet-assets.md). Batched, it is one tap and one atomic
 * outcome. Kuru's `approve` -> `deposit` -> `place` is the same story.
 */
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  isAddress,
  isHex,
  size,
  toHex,
} from 'viem';
/** Byte 0 of the execution mode. */
export const CALL_TYPE = {
  single: '0x00',
  batch: '0x01',
  delegatecall: '0xff',
};
/**
 * Byte 1 of the execution mode.
 *
 * NOTE the polarity, because it reads backwards and `permissionless` names its
 * flag `revertOnError` with the opposite sense: `0x00` is EXECTYPE_DEFAULT,
 * which DOES revert the whole batch when a leg fails. `0x01` is EXECTYPE_TRY,
 * which swallows failures. We always want `0x00`.
 */
export const EXEC_TYPE = {
  revertOnFailure: '0x00',
  try: '0x01',
};
/** Packs the 32-byte execution mode word. Bytes 2-31 are always zero for us. */
export function encodeExecutionMode(callType, execType) {
  // bytes1 callType | bytes1 execType | bytes4 unused | bytes4 selector | bytes22 payload
  return `0x${callType.slice(2)}${execType.slice(2)}${'00'.repeat(30)}`;
}
/** `0x0100…00` — batch, revert on failure. The only mode a batch ever uses. */
export const BATCH_EXECUTION_MODE = encodeExecutionMode(CALL_TYPE.batch, EXEC_TYPE.revertOnFailure);
/** `0x0000…00` — single call, revert on failure. */
export const SINGLE_EXECUTION_MODE = encodeExecutionMode(
  CALL_TYPE.single,
  EXEC_TYPE.revertOnFailure,
);
export const ERC7579_EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'execMode', type: 'bytes32', internalType: 'ExecMode' },
      { name: 'executionCalldata', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [],
  },
];
const EXECUTION_TUPLE_ARRAY = {
  name: 'executionBatch',
  type: 'tuple[]',
  components: [
    { name: 'target', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'callData', type: 'bytes' },
  ],
};
/** A call that failed validation before it could be encoded. */
export class InvalidCallError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCallError';
  }
}
function assertValid(call, index) {
  if (!isAddress(call.to)) {
    throw new InvalidCallError(`call ${index}: "to" is not a 20-byte address`);
  }
  if (call.data !== undefined && !isHex(call.data)) {
    throw new InvalidCallError(`call ${index}: "data" is not hex`);
  }
  if (call.value !== undefined && call.value < 0n) {
    throw new InvalidCallError(`call ${index}: "value" is negative`);
  }
}
/**
 * `executionCalldata` for a batch: `abi.encode(Execution[])`.
 *
 * Dynamic-length ABI encoding, so the layout is offset table then payload —
 * see the worked example in `batch.test.ts`.
 */
export function encodeBatchExecutionCalldata(calls) {
  return encodeAbiParameters(
    [EXECUTION_TUPLE_ARRAY],
    [
      calls.map((call) => ({
        target: call.to,
        value: call.value ?? 0n,
        callData: call.data ?? '0x',
      })),
    ],
  );
}
/**
 * `executionCalldata` for a single call: `abi.encodePacked(to, value, data)`.
 *
 * Packed, NOT abi.encode — 20 bytes of address, then a full 32-byte word for
 * the value, then the calldata with no length prefix and no padding.
 */
export function encodeSingleExecutionCalldata(call) {
  return concatHex([call.to, toHex(call.value ?? 0n, { size: 32 }), call.data ?? '0x']);
}
/**
 * Encodes `execute(bytes32,bytes)` for the whole sequence.
 *
 * A one-call sequence still goes through `execute`, because the Kernel account
 * is always the transaction's `to` — it just uses the cheaper single call type
 * rather than paying for an `Execution[]` offset table. Two or more calls use
 * batch mode and land atomically.
 */
export function encodeKernelExecute(calls) {
  if (calls.length === 0) {
    throw new InvalidCallError('a batch needs at least one call');
  }
  calls.forEach(assertValid);
  const batched = calls.length > 1;
  return encodeFunctionData({
    abi: ERC7579_EXECUTE_ABI,
    functionName: 'execute',
    args: [
      batched ? BATCH_EXECUTION_MODE : SINGLE_EXECUTION_MODE,
      // `calls[0]!` is safe: the empty case was refused above.
      batched ? encodeBatchExecutionCalldata(calls) : encodeSingleExecutionCalldata(calls[0]),
    ],
  });
}
/**
 * Hex equality that ignores case.
 *
 * Necessary, not pedantic: the packed single-call encoding concatenates the
 * address verbatim, so a checksummed `to` produces mixed-case output while a
 * lowercased one does not. The bytes are identical; `===` on the strings is
 * not. Comparing raw strings here would reject every legitimate single call.
 */
export function isSameCallData(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}
/** Raised when the server's callData is not the batch the client asked for. */
export class BatchMismatchError extends Error {
  expected;
  actual;
  // Fields are assigned in the body rather than declared as parameter
  // properties: node's strip-only TypeScript mode runs `*.test.ts` directly and
  // rejects parameter properties outright (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  constructor(expected, actual) {
    super(
      'Server returned callData that does not match the requested calls; refusing to sign. ' +
        `expected ${size(expected)} bytes, got ${size(actual)}`,
    );
    this.name = 'BatchMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}
/**
 * The check that makes the prepare/sign/execute split trustworthy from the
 * client's side: re-encode the calls locally and refuse to sign anything else.
 *
 * The server injects fees and sponsors gas, and it is free to — none of that is
 * in `callData`. What it must not be able to do is swap a recipient or an
 * amount, and this is what stops it.
 */
export function assertCallDataMatches(calls, actual) {
  const expected = encodeKernelExecute(calls);
  if (!isSameCallData(expected, actual)) {
    throw new BatchMismatchError(expected, actual);
  }
}
