/**
 * A fake Privy that ENFORCES, for the refusal demo's spec: served through a
 * fake `fetch` to the real `PrivyClient`, it
 *
 * - checks every `privy-authorization-signature` against the quorum that may
 *   authorize the resource: a policy PATCH or a wallet PATCH needs the
 *   mandate-owner key (the OWNER), a sign needs the agent key (a SIGNER,
 *   SEN-31), answering 401 as Privy does when none verifies. A signer key
 *   cannot PATCH the wallet;
 * - evaluates the wallet's compiled ALLOW rules on `eth_signTransaction` —
 *   `to`, `chain_id`, `value`, decoded calldata (`eq`, `lte`, function name)
 *   and `system.current_unix_timestamp` — and answers 400 `policy_violation`
 *   when no rule matches, deny-by-default like the real enclave;
 * - signs what it allows with a real secp256k1 key per wallet, so the fake
 *   chain can recover the sender and check the nonce.
 *
 * What it does NOT model, on purpose: Privy's PATCH lag and its late
 * rolling-cap aggregation (SEN-3). A rule here takes effect at once. Typed
 * data is always refused. Any field or operator it does not know fails the
 * condition, so an unknown rule can never allow more than the real one.
 */
import type { AuthorizationPayload, PolicyRule } from '@sente/mandate';
import {
  decodeFunctionData,
  getAbiItem,
  isAddress,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  type TransactionSerializedEIP1559,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import type { PrivyTransactionRequest } from '../../privy/agent-wallet';
import type { AuthorizationKey } from '../../privy/authorization-key';
import { signatureVerifies } from '../../privy/testing/fake-privy';
import type { AgentChainClient, AgentReceipt } from '../../venues/agent-transactions';

export const POLICY_VIOLATION = {
  error: 'RPC request denied due to policy violation',
  code: 'policy_violation',
};

/** Exactly what the provider sends to `/rpc`: every integer a JSON number or `0x` hex. */
type FakeTx = PrivyTransactionRequest;

type Condition = Record<string, unknown> & {
  field_source: string;
  field: string;
  operator: string;
  value: string;
};

function compare(actual: bigint, operator: string, bound: bigint): boolean {
  switch (operator) {
    case 'eq':
      return actual === bound;
    case 'lt':
      return actual < bound;
    case 'lte':
      return actual <= bound;
    case 'gt':
      return actual > bound;
    case 'gte':
      return actual >= bound;
    default:
      return false;
  }
}

function calldataMatches(c: Condition, data: Hex | undefined): boolean {
  const abi = c['abi'] as Abi | undefined;
  if (!abi || !data) return false;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi, data });
  } catch {
    return false;
  }
  if (c.field === 'function_name') return c.operator === 'eq' && decoded.functionName === c.value;
  const [fn, param] = c.field.split('.');
  if (decoded.functionName !== fn || !param) return false;
  const item = getAbiItem({ abi, name: fn }) as AbiFunction | undefined;
  const index = item?.inputs.findIndex((input) => input.name === param) ?? -1;
  const actual = index >= 0 ? (decoded.args as readonly unknown[] | undefined)?.[index] : undefined;
  if (typeof actual === 'string' && isAddress(actual)) {
    return c.operator === 'eq' && isAddress(c.value) && isAddressEqual(actual, c.value);
  }
  if (typeof actual === 'bigint') return compare(actual, c.operator, BigInt(c.value));
  return false;
}

function conditionMatches(c: Condition, tx: FakeTx, now: number): boolean {
  switch (c.field_source) {
    case 'ethereum_transaction':
      // `to` is compared case-sensitively, as Privy does (privyTransaction checksums).
      if (c.field === 'to') return c.operator === 'eq' && tx.to === c.value;
      if (c.field === 'chain_id') return compare(BigInt(tx.chain_id), c.operator, BigInt(c.value));
      if (c.field === 'value') return compare(BigInt(tx.value ?? 0), c.operator, BigInt(c.value));
      return false;
    case 'ethereum_calldata':
      return calldataMatches(c, tx.data);
    case 'system':
      return (
        c.field === 'current_unix_timestamp' && compare(BigInt(now), c.operator, BigInt(c.value))
      );
    default:
      return false;
  }
}

/** Does any ALLOW rule of `rules` let `tx` be signed at unix second `now`? */
export function allows(rules: readonly PolicyRule[], tx: FakeTx, now: number): boolean {
  return rules.some(
    (rule) =>
      rule.action === 'ALLOW' &&
      rule.method === 'eth_signTransaction' &&
      rule.conditions.every((c) => conditionMatches(c as unknown as Condition, tx, now)),
  );
}

export interface FakeEnclaveOptions {
  readonly appId: string;
  readonly agentKey: AuthorizationKey;
  readonly ownerKey: AuthorizationKey;
  /** Unix seconds: the enclave's own clock. */
  readonly now?: () => number;
}

export interface EnclaveRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

export function fakeEnclave(options: FakeEnclaveOptions) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const quorums = new Map<string, string[]>([
    ['kq-agent', [options.agentKey.publicKey]],
    ['kq-owner', [options.ownerKey.publicKey]],
  ]);
  const policies = new Map<string, { ownerId: string; rules: readonly PolicyRule[] }>();
  interface WalletSigner {
    signerId: string;
    overridePolicyIds: string[];
  }
  const wallets = new Map<
    string,
    { ownerId: string; policyIds: string[]; signers: WalletSigner[]; account: PrivateKeyAccount }
  >();
  const requests: EnclaveRequest[] = [];
  let seq = 0;

  function authorized(
    ownerId: string,
    method: string,
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): boolean {
    const keys = quorums.get(ownerId) ?? [];
    const signatures = (headers['privy-authorization-signature'] ?? '').split(',').filter(Boolean);
    const privyHeaders = Object.fromEntries(
      Object.entries(headers).filter(
        ([name]) => name.startsWith('privy-') && name !== 'privy-authorization-signature',
      ),
    );
    const payload: AuthorizationPayload = {
      version: 1,
      method: method as AuthorizationPayload['method'],
      url,
      body: (body ?? {}) as AuthorizationPayload['body'],
      headers: privyHeaders,
    };
    return signatures.some((sig) => keys.some((key) => signatureVerifies(key, payload, sig)));
  }

  async function route(
    method: string,
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    const path = new URL(url).pathname;
    seq += 1;
    if (method === 'POST' && path === '/v1/policies') {
      const id = `pol-${seq}`;
      policies.set(id, { ownerId: String(body['owner_id']), rules: body['rules'] as PolicyRule[] });
      return { status: 200, body: { id, ...body } };
    }
    if (method === 'POST' && path === '/v1/wallets') {
      const id = `wal-${seq}`;
      const account = privateKeyToAccount(generatePrivateKey());
      const policyIds = body['policy_ids'] as string[];
      const signers = (
        (body['additional_signers'] as
          { signer_id: string; override_policy_ids: string[] }[] | undefined) ?? []
      ).map((s) => ({
        signerId: s.signer_id,
        overridePolicyIds: s.override_policy_ids ?? [],
      }));
      wallets.set(id, { ownerId: String(body['owner_id']), policyIds, signers, account });
      return {
        status: 200,
        body: {
          id,
          address: account.address,
          chain_type: 'ethereum',
          policy_ids: policyIds,
          owner_id: body['owner_id'],
          additional_signers: body['additional_signers'] ?? [],
        },
      };
    }
    const policyMatch = /^\/v1\/policies\/([^/]+)$/.exec(path);
    if (method === 'PATCH' && policyMatch) {
      const policy = policies.get(policyMatch[1]!);
      if (!policy) return { status: 404, body: { error: 'not found' } };
      if (!authorized(policy.ownerId, method, url, body, headers)) {
        return { status: 401, body: { error: 'No valid authorization signatures' } };
      }
      policies.set(policyMatch[1]!, { ...policy, rules: body['rules'] as PolicyRule[] });
      return { status: 200, body: { id: policyMatch[1], ...body } };
    }
    const walletMatch = /^\/v1\/wallets\/([^/]+)$/.exec(path);
    if (method === 'PATCH' && walletMatch) {
      // SEN-31: only the wallet OWNER may change it; a signer key alone → 401.
      const wallet = wallets.get(walletMatch[1]!);
      if (!wallet) return { status: 404, body: { error: 'not found' } };
      if (!authorized(wallet.ownerId, method, url, body, headers)) {
        return { status: 401, body: { error: 'No valid authorization signatures' } };
      }
      if ('policy_ids' in body) wallet.policyIds = body['policy_ids'] as string[];
      if ('owner_id' in body) wallet.ownerId = String(body['owner_id']);
      if ('additional_signers' in body) {
        wallet.signers = (
          body['additional_signers'] as { signer_id: string; override_policy_ids: string[] }[]
        ).map((s) => ({ signerId: s.signer_id, overridePolicyIds: s.override_policy_ids ?? [] }));
      }
      return { status: 200, body: { id: walletMatch[1], ...body } };
    }
    const rpcMatch = /^\/v1\/wallets\/([^/]+)\/rpc$/.exec(path);
    if (method === 'POST' && rpcMatch) {
      const wallet = wallets.get(rpcMatch[1]!);
      if (!wallet) return { status: 404, body: { error: 'not found' } };
      // A sign is authorized by a SIGNER (evaluated against its override
      // policy) or by the owner (evaluated against the wallet's own policies).
      const signer = wallet.signers.find((s) => authorized(s.signerId, method, url, body, headers));
      const byOwner = !signer && authorized(wallet.ownerId, method, url, body, headers);
      if (!signer && !byOwner) {
        return { status: 401, body: { error: 'No valid authorization signatures' } };
      }
      if (body['method'] !== 'eth_signTransaction') return { status: 400, body: POLICY_VIOLATION };
      const tx = (body['params'] as { transaction: FakeTx }).transaction;
      const effectivePolicyIds = signer ? signer.overridePolicyIds : wallet.policyIds;
      const rules = effectivePolicyIds.flatMap((id) => policies.get(id)?.rules ?? []);
      if (!allows(rules, tx, now())) return { status: 400, body: POLICY_VIOLATION };
      const signed = await wallet.account.signTransaction({
        type: 'eip1559',
        chainId: Number(tx.chain_id),
        to: tx.to,
        data: tx.data ?? '0x',
        value: BigInt(tx.value ?? 0),
        nonce: tx.nonce,
        gas: BigInt(tx.gas_limit),
        maxFeePerGas: BigInt(tx.max_fee_per_gas),
        maxPriorityFeePerGas: BigInt(tx.max_priority_fee_per_gas),
      });
      return {
        status: 200,
        body: { method: 'eth_signTransaction', data: { signed_transaction: signed } },
      };
    }
    return { status: 404, body: { error: 'not found' } };
  }

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const raw = init?.body as string | undefined;
    const body = (raw === undefined ? {} : JSON.parse(raw)) as Record<string, unknown>;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const reply = await route(method, url, body, headers);
    requests.push({ method, path: new URL(url).pathname, status: reply.status });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    requests,
    policies,
    agentQuorumId: 'kq-agent',
    mandateQuorumId: 'kq-owner',
  };
}

/**
 * A chain that accepts only a correctly signed EIP-1559 transaction at the
 * sender's next nonce, and reports success. Nothing else.
 */
export function fakeChain() {
  const nonces = new Map<string, number>();
  const sent: { hash: Hex; from: Address; to: Address | null | undefined; nonce: number }[] = [];
  const client: AgentChainClient = {
    pendingNonce: (address) => Promise.resolve(nonces.get(address.toLowerCase()) ?? 0),
    fees: () =>
      Promise.resolve({ maxFeePerGas: 102_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n }),
    sendRawTransaction: async (serialized) => {
      const tx = parseTransaction(serialized);
      const from = await recoverTransactionAddress({
        serializedTransaction: serialized as TransactionSerializedEIP1559,
      });
      const expected = nonces.get(from.toLowerCase()) ?? 0;
      if (tx.nonce !== expected) throw new Error(`nonce ${tx.nonce}, expected ${expected}`);
      nonces.set(from.toLowerCase(), expected + 1);
      const hash = keccak256(serialized);
      sent.push({ hash, from, to: tx.to, nonce: expected });
      return hash;
    },
    waitForReceipt: (hash): Promise<AgentReceipt> =>
      Promise.resolve({
        transactionHash: hash,
        success: true,
        logs: [],
        blockNumber: 74_000_001n,
      }),
  };
  return { client, sent, nonceOf: (address: Address) => nonces.get(address.toLowerCase()) ?? 0 };
}
