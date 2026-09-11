// An agent's wallet — a Privy server wallet whose key lives in Privy's enclave
// and signs only what its mandate policy allows. Ported from turnstile
// `buyer/org/org-wallet.ts`, plus `signTypedData` for Perpl API-key enrollment.
//
// ## Sign, then broadcast — never `eth_sendTransaction`
//
// `eth_signTransaction` returns a raw signed transaction and broadcasts
// nothing; we submit it over Monad's own RPC. Two reasons, both in
// docs/privy-policy-enforcement.md: stateful aggregations (the rolling cap)
// are only evaluated on the sign path, and the send path is where Privy runs
// transaction simulation — which we do not want on a chain Privy may not route.
//
// Always set `chain_id`: Privy's SDK defaults to 1, and the chain id is what
// goes into the EIP-155 signature. Fill nonce, gas and fees yourself.

import {
  getAddress,
  getTypesForEIP712Domain,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from 'viem';

import type { AuthorizationKey } from './authorization-key.ts';
import type { PrivyClient } from './privy.client.ts';

export interface AgentWallet {
  /** Privy's wallet id. What `/rpc` is addressed to. */
  id: string;
  /** The EVM address. EIP-55 as Privy returns it; normalise with `getAddress`. */
  address: string;
  chain_type: string;
  policy_ids: string[];
  owner_id: string | null;
}

/**
 * Create an agent wallet: owned by the agent quorum, governed by the mandate
 * policy.
 *
 * Both are set at creation on purpose. A wallet created bare and patched
 * afterwards is briefly a wallet with no owner and no policy — and a policy of
 * none is not "deny": it is no policy at all.
 */
export async function createAgentWallet(
  privy: PrivyClient,
  options: { ownerQuorumId: string; policyId: string; displayName: string },
): Promise<AgentWallet> {
  return privy.post<AgentWallet>('/v1/wallets', {
    chain_type: 'ethereum',
    owner_id: options.ownerQuorumId,
    policy_ids: [options.policyId],
    display_name: options.displayName.slice(0, 50),
  });
}

export async function getAgentWallet(privy: PrivyClient, walletId: string): Promise<AgentWallet> {
  return privy.get<AgentWallet>(`/v1/wallets/${walletId}`);
}

/**
 * An EVM transaction as Privy's RPC wants it: snake_case, and every integer
 * either a JSON number or a `0x` hex string. **A decimal string is rejected**
 * (`Invalid input: must start with "0x"`, turnstile 2026-09-07), which is
 * exactly what `bigint.toString()` produces — use {@link privyTransaction}.
 */
export interface PrivyTransactionRequest {
  to: Address;
  data?: Hex;
  value?: number | Hex;
  chain_id: number;
  nonce: number;
  gas_limit: number | Hex;
  max_fee_per_gas: number | Hex;
  max_priority_fee_per_gas: number | Hex;
  type?: 2;
}

const hex = (value: bigint): Hex => `0x${value.toString(16)}`;

/** Build a {@link PrivyTransactionRequest} from viem-style bigints, hex-encoded. */
export function privyTransaction(input: {
  to: Address;
  data?: Hex;
  value?: bigint;
  chainId: number;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): PrivyTransactionRequest {
  return {
    // Checksummed: Privy compares `to` case-sensitively against the policy.
    to: getAddress(input.to),
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.value === undefined ? {} : { value: hex(input.value) }),
    chain_id: input.chainId,
    nonce: input.nonce,
    gas_limit: hex(input.gas),
    max_fee_per_gas: hex(input.maxFeePerGas),
    max_priority_fee_per_gas: hex(input.maxPriorityFeePerGas),
    type: 2,
  };
}

interface SignTransactionResponse {
  method: string;
  data: { signed_transaction: Hex };
}

/**
 * Have the wallet sign a transaction, if the mandate policy allows it.
 *
 * `approvals` must satisfy the wallet's owner quorum (the agent key). Throws
 * `PrivyError` with `status: 400` and `code: policy_violation` when the policy
 * refuses, and `401` when the approvals are short. Those are different
 * failures — the mandate saying no, versus nobody having asked — and are
 * deliberately not collapsed.
 */
export async function signTransaction(
  privy: PrivyClient,
  options: {
    walletId: string;
    transaction: PrivyTransactionRequest;
    approvals: readonly AuthorizationKey[];
  },
): Promise<Hex> {
  const response = await privy.post<SignTransactionResponse>(
    `/v1/wallets/${options.walletId}/rpc`,
    { method: 'eth_signTransaction', params: { transaction: options.transaction } },
    { approvals: options.approvals },
  );
  return response.data.signed_transaction;
}

/** EIP-712 typed data in the snake_case, JSON-safe shape Privy's RPC takes. */
export interface PrivyTypedData {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primary_type: string;
  message: Record<string, unknown>;
}

/**
 * JSON has no bigint. A safe integer becomes a JSON number (what the
 * authorization canonicalizer accepts), anything larger a `0x` hex string.
 */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= 0n ? Number(value) : hex(value);
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

/**
 * viem's typed-data shape → Privy's. `EIP712Domain` is spelled out from the
 * domain's own keys (as MetaMask's v4 format does) rather than left to Privy
 * to infer, so a non-standard domain like Perpl's (it carries a `salt`) hashes
 * the same on both sides. The live probe recovers the signer locally to prove
 * it.
 */
export function toPrivyTypedData(typed: TypedDataDefinition): PrivyTypedData {
  const domain = (typed.domain ?? {}) as Record<string, unknown>;
  const types = typed.types as Record<string, readonly { name: string; type: string }[]>;
  return {
    domain: jsonSafe(domain) as Record<string, unknown>,
    types: {
      EIP712Domain: types['EIP712Domain'] ?? getTypesForEIP712Domain({ domain }),
      ...types,
    },
    primary_type: typed.primaryType as string,
    message: jsonSafe(typed.message) as Record<string, unknown>,
  };
}

interface SignTypedDataResponse {
  method: string;
  data: { signature: Hex; encoding?: string };
}

/** `eth_signTypedData_v4` — Perpl API-key enrollment is the one caller today. */
export async function signTypedData(
  privy: PrivyClient,
  options: {
    walletId: string;
    typedData: TypedDataDefinition;
    approvals: readonly AuthorizationKey[];
  },
): Promise<Hex> {
  const response = await privy.post<SignTypedDataResponse>(
    `/v1/wallets/${options.walletId}/rpc`,
    { method: 'eth_signTypedData_v4', params: { typed_data: toPrivyTypedData(options.typedData) } },
    { approvals: options.approvals },
  );
  return response.data.signature;
}
