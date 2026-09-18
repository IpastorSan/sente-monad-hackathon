import { createPublicKey, verify as ecdsaVerify } from 'node:crypto';

import { canonicalize, type AuthorizationPayload } from '@sente/mandate';

export const FAKE_APP_ID = 'app-123';
export const FAKE_APP_SECRET = 'secret-456-FAKE-do-not-leak';

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The body string exactly as sent. */
  rawBody: string | undefined;
  body: unknown;
}

type Reply = { status: number; body: unknown };
type Handler = (request: CapturedRequest) => Reply | undefined;

/** Does `signature` verify over `payload` under this base64 SPKI public key? */
export function signatureVerifies(
  publicKey: string,
  payload: AuthorizationPayload,
  signature: string,
): boolean {
  const key = createPublicKey({
    key: Buffer.from(publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return ecdsaVerify(
    'sha256',
    Buffer.from(canonicalize(payload), 'utf8'),
    key,
    Buffer.from(signature, 'base64'),
  );
}

/**
 * Which of `publicKeys` (base64 SPKI) signed this request, if any? Reconstructs
 * the payload Privy signs — same URL, same body, only the `privy-` headers —
 * from the captured request, then checks every comma-joined signature against
 * every candidate key. Used to enforce owner-only wallet mutation (SEN-31).
 */
export function requestSignedByAny(
  request: CapturedRequest,
  publicKeys: readonly string[],
): boolean {
  const header = request.headers['privy-authorization-signature'];
  if (!header || publicKeys.length === 0) return false;
  const privyHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    if (k.toLowerCase().startsWith('privy-') && k.toLowerCase() !== 'privy-authorization-signature') {
      privyHeaders[k] = v;
    }
  }
  const payload: AuthorizationPayload = {
    version: 1,
    method: request.method as AuthorizationPayload['method'],
    url: request.url,
    body: request.body ?? {},
    headers: privyHeaders,
  };
  const signatures = header.split(',');
  return publicKeys.some((key) =>
    signatures.some((signature) => {
      try {
        return signatureVerifies(key, payload, signature);
      } catch {
        return false;
      }
    }),
  );
}

interface FakeWallet {
  id: string;
  address: string;
  chain_type: string;
  policy_ids: unknown;
  owner_id: unknown;
  additional_signers: unknown;
}

/**
 * A stand-in for Privy's REST API, served through a fake `fetch`. Records every
 * request verbatim so a spec can check that what was signed is what was sent.
 *
 * Default routes cover what the provider calls: quorums, policies, wallets and
 * the wallet `/rpc`. It also models the SEN-31 owner/signer split: it remembers
 * each quorum's public keys, each wallet's owner and each POLICY's owner, and a
 * `PATCH` of either is honoured only when signed by that object's OWNER quorum —
 * anything else gets 401, exactly as Privy answers live. The policy half is what
 * makes SEN-43 testable without the network: a policy created under a user's
 * device quorum refuses this server's mandate key. `handle` runs first and may
 * answer anything itself — that is how a spec makes the enclave refuse.
 */
export function fakePrivy(handle: Handler = () => undefined) {
  const calls: CapturedRequest[] = [];
  const quorums = new Map<string, string[]>(); // quorum id -> public keys
  const policies = new Map<string, string>(); // policy id -> owner quorum id
  const wallets = new Map<string, FakeWallet>();
  let seq = 0;

  const fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const rawBody = init?.body as string | undefined;
    const request: CapturedRequest = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      rawBody,
      body: rawBody === undefined ? undefined : (JSON.parse(rawBody) as unknown),
    };
    calls.push(request);

    const reply = handle(request) ?? route(request);
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  }) as typeof globalThis.fetch;

  function route(request: CapturedRequest): Reply {
    const path = new URL(request.url).pathname;
    const body = (request.body ?? {}) as Record<string, unknown>;
    seq += 1;
    if (request.method === 'POST' && path === '/v1/key_quorums') {
      const id = `kq${seq}`;
      const publicKeys = Array.isArray(body['public_keys'])
        ? (body['public_keys'] as string[])
        : [];
      quorums.set(id, publicKeys);
      return { status: 200, body: { id, ...body } };
    }
    if (request.method === 'POST' && path === '/v1/policies') {
      const id = `pol${seq}`;
      policies.set(id, String(body['owner_id']));
      return { status: 200, body: { id, ...body } };
    }
    if (request.method === 'PATCH' && path.startsWith('/v1/policies/')) {
      // Same rule as a wallet PATCH, and the one SEN-43 turns on us: only the
      // policy's OWNER quorum may change its rules. A policy owned by a user's
      // device quorum refuses this server's mandate key with a 401.
      const id = path.split('/').pop()!;
      const ownerId = policies.get(id);
      if (ownerId !== undefined && !requestSignedByAny(request, quorums.get(ownerId) ?? [])) {
        return {
          status: 401,
          body: { error: 'No valid authorization signatures were provided.', code: 'invalid_data' },
        };
      }
      return { status: 200, body: { id, ...body } };
    }
    if (request.method === 'POST' && path === '/v1/wallets') {
      const wallet: FakeWallet = {
        id: `w${seq}`,
        // Lowercase on purpose: the provider must checksum what it returns.
        address: '0x3de96375140717193f52c220df5ec460971cbe84',
        chain_type: 'ethereum',
        policy_ids: body['policy_ids'],
        owner_id: body['owner_id'],
        additional_signers: body['additional_signers'] ?? [],
      };
      wallets.set(wallet.id, wallet);
      return { status: 200, body: wallet };
    }
    if (request.method === 'PATCH' && /^\/v1\/wallets\/[^/]+$/.test(path)) {
      // The SEN-31 rule: only the wallet's OWNER quorum may change its
      // policy_ids, owner_id or additional_signers. A signer key alone → 401,
      // exactly as Privy answers live.
      const id = path.split('/').pop()!;
      const wallet = wallets.get(id);
      if (!wallet) return { status: 404, body: { error: 'not found' } };
      const ownerKeys = quorums.get(String(wallet.owner_id)) ?? [];
      if (!requestSignedByAny(request, ownerKeys)) {
        return {
          status: 401,
          body: {
            error: 'No valid authorization signatures were provided.',
            code: 'invalid_data',
          },
        };
      }
      if ('policy_ids' in body) wallet.policy_ids = body['policy_ids'];
      if ('owner_id' in body) wallet.owner_id = body['owner_id'];
      if ('additional_signers' in body) wallet.additional_signers = body['additional_signers'];
      return { status: 200, body: wallet };
    }
    if (request.method === 'GET' && /^\/v1\/wallets\/[^/]+$/.test(path)) {
      const id = path.split('/').pop()!;
      const wallet = wallets.get(id);
      if (wallet) return { status: 200, body: wallet };
      return { status: 200, body: { id, chain_type: 'ethereum' } };
    }
    if (request.method === 'POST' && /^\/v1\/wallets\/[^/]+\/rpc$/.test(path)) {
      if (body['method'] === 'eth_signTypedData_v4') {
        return {
          status: 200,
          body: { method: 'eth_signTypedData_v4', data: { signature: '0xsig', encoding: 'hex' } },
        };
      }
      return {
        status: 200,
        body: { method: 'eth_signTransaction', data: { signed_transaction: '0x02f8signed' } },
      };
    }
    return { status: 404, body: { error: 'not found' } };
  }

  return { fetch, calls };
}
