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
 * A stand-in for Privy's REST API, served through a fake `fetch`. Records every
 * request verbatim so a spec can check that what was signed is what was sent.
 *
 * Default routes cover what the provider calls: quorums, policies, wallets and
 * the wallet `/rpc`. `handle` runs first and may answer anything itself —
 * that is how a spec makes the enclave refuse.
 */
export function fakePrivy(handle: Handler = () => undefined) {
  const calls: CapturedRequest[] = [];
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
      return { status: 200, body: { id: `kq${seq}`, ...body } };
    }
    if (request.method === 'POST' && path === '/v1/policies') {
      return { status: 200, body: { id: `pol${seq}`, ...body } };
    }
    if (request.method === 'PATCH' && path.startsWith('/v1/policies/')) {
      return { status: 200, body: { id: path.split('/').pop(), ...body } };
    }
    if (request.method === 'POST' && path === '/v1/wallets') {
      return {
        status: 200,
        body: {
          id: `w${seq}`,
          // Lowercase on purpose: the provider must checksum what it returns.
          address: '0x3de96375140717193f52c220df5ec460971cbe84',
          chain_type: 'ethereum',
          policy_ids: body['policy_ids'],
          owner_id: body['owner_id'],
        },
      };
    }
    if (request.method === 'GET' && /^\/v1\/wallets\/[^/]+$/.test(path)) {
      return { status: 200, body: { id: path.split('/').pop(), chain_type: 'ethereum' } };
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
