/**
 * Phone call-list decoder (SEN-85, plan M-T3).
 *
 * Turns the `params.transaction` of a server-composed trade step into the list
 * of calls it will actually make, so later checks (the Kuru classifier, the
 * policy verifier) reason about calls rather than raw calldata. The device key
 * signs blindly (`auth/deviceKey.ts`), so this module is part of the security
 * boundary: anything it cannot account for byte-for-byte is refused, never
 * passed through. See docs/design/trading/plan-trading.md, Architecture §1.
 *
 * Two shapes are accepted:
 *
 *   - `to != wallet`: the transaction is itself the one call.
 *   - `to == wallet`: a Kernel `execute(bytes32 mode, bytes executionCalldata)`
 *     whose mode is exactly `SINGLE_EXECUTION_MODE` or `BATCH_EXECUTION_MODE`.
 *     Delegatecall (`0xff`) would run foreign code in the wallet's storage, and
 *     try-mode would let a funding leg land while the order leg fails, so every
 *     other mode word is refused. No leg may target the wallet again: a nested
 *     self-call could smuggle a second `execute` (or a module install) past
 *     every per-leg check.
 *
 * Decoding is followed by a re-encode through `encodeKernelExecute` and a byte
 * comparison. That one check rejects trailing bytes, non-canonical offsets and
 * a one-leg batch-mode wrapper, none of which the server's encoder emits.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  hexToBigInt,
  isAddress,
  isAddressEqual,
  isHex,
  sliceHex,
  size,
  type Address,
  type Hex,
} from 'viem';

import {
  BATCH_EXECUTION_MODE,
  encodeKernelExecute,
  ERC7579_EXECUTE_ABI,
  isSameCallData,
  SINGLE_EXECUTION_MODE,
  type Erc7579Call,
} from '../wallet/batch.ts';

export type DecodedCalls =
  | { readonly ok: true; readonly calls: Erc7579Call[]; readonly batched: boolean }
  | { readonly ok: false; readonly problem: string };

/** Keys a sponsored Privy `eth_sendTransaction` may carry; anything else is unexplained. */
const TRANSACTION_KEYS: readonly string[] = ['to', 'data', 'value', 'chain_id'];

/** Same tuple as `batch.ts`'s encoder; kept local so the decoder names its own shape. */
const EXECUTION_BATCH = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
  },
] as const;

/** 20-byte target + 32-byte value: the fixed head of a packed single execution. */
const SINGLE_HEAD_BYTES = 52;

const refuse = (problem: string): DecodedCalls => ({ ok: false, problem });

/**
 * `0x0` or `0x` + hex digits with no leading zero — what the server's
 * `hexQuantity` emits. Why strict: a lenient parser would let two different
 * strings mean the same value, and the signature covers the string.
 */
function parseQuantity(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) return undefined;
  return hexToBigInt(value as Hex);
}

/** Even-length hex, so `size()` and the re-encode compare whole bytes. */
function isByteHex(value: unknown): value is Hex {
  return typeof value === 'string' && isHex(value, { strict: true }) && value.length % 2 === 0;
}

/**
 * Decodes the calls a trade-step transaction will make, or says why it won't.
 *
 * `batched` is true only for a batch-mode `execute`, i.e. two or more legs
 * that land atomically; a single-mode wrapper reports one call, unbatched.
 */
export function decodeTransactionCalls(tx: unknown, wallet: Address): DecodedCalls {
  if (!isAddress(wallet)) return refuse('the wallet address is not an address');
  if (typeof tx !== 'object' || tx === null || Array.isArray(tx)) {
    return refuse('the transaction is not an object');
  }
  const fields = tx as Record<string, unknown>;
  const extra = Object.keys(fields).filter((key) => !TRANSACTION_KEYS.includes(key));
  if (extra.length > 0) return refuse(`the transaction also carries ${extra.join(', ')}`);

  const { to, data } = fields;
  if (typeof to !== 'string' || !isAddress(to)) return refuse('the transaction has no valid "to"');
  if (data !== undefined && !isByteHex(data)) return refuse('the transaction data is not hex');

  let value = 0n;
  if (fields['value'] !== undefined) {
    const parsed = parseQuantity(fields['value']);
    if (parsed === undefined) return refuse('the transaction value is not a hex quantity');
    value = parsed;
  }

  if (!isAddressEqual(to, wallet)) {
    return { ok: true, calls: [{ to, value, data: data ?? '0x' }], batched: false };
  }

  // A self-call is only ever the Kernel executor. Value sent to itself buys
  // nothing and has no reason to be there.
  if (value !== 0n) return refuse('the call to your wallet carries value');
  if (data === undefined) return refuse('the call to your wallet has no data');
  return decodeExecute(data, wallet);
}

function decodeExecute(data: Hex, wallet: Address): DecodedCalls {
  let mode: Hex;
  let executionCalldata: Hex;
  try {
    const decoded = decodeFunctionData({ abi: ERC7579_EXECUTE_ABI, data });
    [mode, executionCalldata] = decoded.args;
  } catch {
    return refuse('the call to your wallet is not execute(bytes32,bytes)');
  }

  let calls: Erc7579Call[];
  const batched = mode.toLowerCase() === BATCH_EXECUTION_MODE;
  if (batched) {
    try {
      const [executions] = decodeAbiParameters(EXECUTION_BATCH, executionCalldata);
      calls = executions.map((leg) => ({ to: leg.target, value: leg.value, data: leg.callData }));
    } catch {
      return refuse('the batch does not decode');
    }
  } else if (mode.toLowerCase() === SINGLE_EXECUTION_MODE) {
    if (size(executionCalldata) < SINGLE_HEAD_BYTES) return refuse('the single call is truncated');
    calls = [
      {
        to: sliceHex(executionCalldata, 0, 20),
        value: hexToBigInt(sliceHex(executionCalldata, 20, SINGLE_HEAD_BYTES)),
        data:
          size(executionCalldata) > SINGLE_HEAD_BYTES
            ? sliceHex(executionCalldata, SINGLE_HEAD_BYTES)
            : '0x',
      },
    ];
  } else {
    // Delegatecall, try-mode and any non-zero selector/payload land here.
    return refuse(`the execution mode ${mode} is not allowed`);
  }

  if (calls.length === 0) return refuse('the batch has no calls');
  const selfLeg = calls.findIndex((call) => isAddressEqual(call.to, wallet));
  if (selfLeg !== -1) return refuse(`call ${selfLeg} targets your wallet itself`);

  let reencoded: Hex;
  try {
    reencoded = encodeKernelExecute(calls);
  } catch {
    return refuse('the decoded calls do not re-encode');
  }
  if (!isSameCallData(reencoded, data)) {
    return refuse('the calldata is not the canonical encoding of its calls');
  }
  return { ok: true, calls, batched };
}
