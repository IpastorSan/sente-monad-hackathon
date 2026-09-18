// The Privy REST client, and nothing else. Ported from turnstile
// `buyer/org/privy.ts`, which was verified against the live API on 2026-09-07.
//
// Privy publishes a Node SDK. This is a hand-rolled client over `fetch`
// instead, because the interesting part of this integration is the
// **authorization signature**, and an SDK that computes it for you hides the
// thing a reviewer needs to see. `authorization-key.ts` computes it in twenty
// readable lines, and this file shows exactly where it goes on the wire.
//
// Two authentications stack here and they are not alternatives:
//
//   1. **HTTP basic auth** with `app_id:app_secret`. Proves *which app* is
//      calling. Every request carries it.
//   2. **`privy-authorization-signature`**, one per approving key. Proves *who
//      authorized this specific request*. Only requests that mutate an owned
//      resource carry it.
//
// The app secret alone cannot raise a mandate: the wallet AND its policy are
// both owned by a key the trading path never uses — the trading key is only a
// wallet signer (SEN-31) — and Privy checks that owner signature, not us.
//
// Relative imports carry `.ts` so scripts/privy-probe.ts can load this exact
// file under node's type stripping; tsc rewrites them to `.js` for the CJS
// build (services/api/tsconfig.json).

import { signAuthorizationPayload, type AuthorizationKey } from './authorization-key.ts';
import type { AuthorizationPayload } from '@sente/mandate';

export const PRIVY_API_BASE = 'https://api.privy.io';

/** The methods Privy checks an authorization signature on: everything but GET. */
type SignableMethod = Exclude<AuthorizationPayload['method'], 'PUT'>;

/** Refuses a GET rather than signing one that Privy will never check. */
function signable(method: 'GET' | SignableMethod): SignableMethod {
  if (method === 'GET') {
    throw new Error(
      'a GET is not signed — Privy only checks authorization signatures on mutations',
    );
  }
  return method;
}

export interface PrivyCredentials {
  appId: string;
  appSecret: string;
  /** Override for tests. Defaults to {@link PRIVY_API_BASE}. */
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export class PrivyError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(method: string, path: string, status: number, body: unknown) {
    // Privy's error body, never our request: the app secret and the
    // authorization signatures live in headers, which are not part of this.
    const detail = typeof body === 'object' && body !== null ? JSON.stringify(body) : String(body);
    super(`Privy ${method} ${path} → ${status}: ${detail}`);
    this.name = 'PrivyError';
    this.status = status;
    this.body = body;
  }

  /** Privy's machine-readable error code (`policy_violation`, `invalid_data`, …), if any. */
  get code(): string | undefined {
    const body = this.body as { code?: unknown } | null;
    return typeof body?.code === 'string' ? body.code : undefined;
  }

  /**
   * Did this fail because the request was one approval short?
   *
   * The refusal we *want* when the agent key tries to edit a policy, as
   * distinct from a typo in a policy id. Privy answers 401 for a missing or
   * insufficient authorization signature.
   */
  get isMissingApproval(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** The enclave evaluated the policy and refused to sign. */
  get isPolicyViolation(): boolean {
    return this.status === 400 && this.code === 'policy_violation';
  }
}

export interface RequestOptions {
  /**
   * Keys approving this request, one signature each. Order does not matter to
   * Privy.
   */
  approvals?: readonly AuthorizationKey[];
  /**
   * Approvals whose signature was produced somewhere this process cannot
   * reach — the owner's phone (SEN-44). Each is the base64 DER ECDSA signature
   * {@link signAuthorizationPayload} would have returned, over the payload
   * {@link PrivyClient.authorizationPayload} builds for THIS method, path and
   * body. Appended to the same header as `approvals`, because Privy cannot tell
   * the two apart and must not be able to: a signature is a signature.
   *
   * Nothing here is validated locally. A signature over different bytes is
   * refused by Privy with a 401, which is the check that matters — ours would
   * only be a second opinion about a key we do not hold.
   */
  signatures?: readonly string[];
  /** Privy deduplicates identical requests carrying the same key for 24h. */
  idempotencyKey?: string;
}

/**
 * A thin, honest client. One method per HTTP verb, and `request` doing the work.
 */
export class PrivyClient {
  readonly appId: string;
  readonly #appSecret: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(credentials: PrivyCredentials) {
    this.appId = credentials.appId;
    this.#appSecret = credentials.appSecret;
    this.#baseUrl = (credentials.baseUrl ?? PRIVY_API_BASE).replace(/\/+$/, '');
    this.#fetch = credentials.fetch ?? globalThis.fetch;
  }

  /**
   * The exact object an approver must sign for `request(method, path, body)` —
   * built by the same code that signs it, so the two cannot drift.
   *
   * Public because an owner this process does not hold has to be *handed* the
   * payload (SEN-44: the phone owns its agents' policies). What leaves here is
   * the request and nothing else — no secret is in it — and the receiver is
   * expected to rebuild it from the intent it is approving rather than trust
   * this copy. That is the whole rule the device key exists to enforce; see
   * `apps/mobile/src/auth/deviceKey.ts`.
   *
   * @throws Error for a GET, which Privy never checks a signature on.
   */
  authorizationPayload(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    options: Pick<RequestOptions, 'idempotencyKey'> = {},
  ): AuthorizationPayload {
    return this.#payload(
      signable(method),
      `${this.#baseUrl}${path}`,
      body,
      this.#privyHeaders(options),
    );
  }

  /**
   * The signed payload must mirror the request byte for byte on Privy's side:
   * same URL (no trailing slash), same body object, and *only* the `privy-`
   * headers. Anything else here silently breaks every signature.
   */
  #payload(
    method: SignableMethod,
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): AuthorizationPayload {
    return { version: 1, method, url, body: body ?? {}, headers };
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = `${this.#baseUrl}${path}`;

    // Built once and used for both the request and the signature: the headers
    // are part of the signed bytes, so two constructions of them are two places
    // they can disagree.
    const privyHeaders = this.#privyHeaders(options);
    const headers: Record<string, string> = {
      ...privyHeaders,
      authorization: `Basic ${Buffer.from(`${this.appId}:${this.#appSecret}`).toString('base64')}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const approvals = options.approvals ?? [];
    const precomputed = options.signatures ?? [];
    if (approvals.length + precomputed.length > 0) {
      const payload = this.#payload(signable(method), url, body, privyHeaders);
      headers['privy-authorization-signature'] = [
        ...approvals.map((key) => signAuthorizationPayload(key.privateKey, payload)),
        ...precomputed,
      ].join(',');
    }

    const response = await this.#fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!response.ok) throw new PrivyError(method, path, response.status, parsed);
    return parsed as T;
  }

  /** The `privy-` headers, which are also the only ones a signature covers. */
  #privyHeaders(options: Pick<RequestOptions, 'idempotencyKey'>): Record<string, string> {
    const headers: Record<string, string> = { 'privy-app-id': this.appId };
    if (options.idempotencyKey) headers['privy-idempotency-key'] = options.idempotencyKey;
    return headers;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }
  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, options);
  }
}
