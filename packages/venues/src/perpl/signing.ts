/**
 * Perpl API-key request signing — Ed25519 over a canonical string.
 *
 * There is no TypeScript SDK (only the Rust `perpl-sdk`), so this is the whole
 * scheme, hand-written from `api-docs/authentication.md` and proven byte-exact
 * against testnet (a signed `GET /v1/trading/account-history` returns 200).
 *
 * REST: six fields joined by `\n`
 *
 *     <chain_id>
 *     <METHOD>
 *     <request-target>        path + query, exactly as sent — see below
 *     <timestamp_ms>
 *     <nonce>                 base64url, no padding, single use
 *     <sha256(body) hex>      of "" for a bodyless request
 *
 * WS sign-in (`mt: 29`, first frame on `/ws/v1/trading`): four fields
 *
 *     <chain_id>\ntrading-ws-signin\n<timestamp_ms>\n<nonce>
 *
 * THE REQUEST-TARGET EXCLUDES `/api`. The REST base is `https://…/api`, and the
 * proxy strips that prefix before the signature is checked: signing
 * `/v1/trading/…` returns 200, signing `/api/v1/trading/…` for the very same
 * URL returns 401. Measured, not read — the docs only imply it.
 *
 * The timestamp must be within 30s of SERVER time, so every timestamp comes
 * from `ServerClock`, never straight from `Date.now()`.
 */
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// noble's async API hashes through `crypto.subtle`, which Hermes does not have.
// Wiring the synchronous SHA-512 makes `ed.sign` / `ed.getPublicKey` work the
// same on device and under node.
ed.hashes.sha512 = sha512;

export interface PerplCredentials {
  /** The opaque token from enrollment, sent as `X-API-Key`. */
  readonly apiKey: string;
  /** 32-byte Ed25519 secret key. Never logged, never sent anywhere. */
  readonly secretKey: Uint8Array;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 §5, no padding. Hand-rolled: RN has no `Buffer`. */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += BASE64URL[(n >> 18) & 63]! + BASE64URL[(n >> 12) & 63]! + BASE64URL[(n >> 6) & 63]!;
    out += BASE64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const n = (bytes[i]! << 16) | (rest === 2 ? bytes[i + 1]! << 8 : 0);
    out += BASE64URL[(n >> 18) & 63]! + BASE64URL[(n >> 12) & 63]!;
    if (rest === 2) out += BASE64URL[(n >> 6) & 63]!;
  }
  return out;
}

/** 16 random bytes, base64url. Nonces are single-use within the 30s window. */
export function newNonce(): string {
  return base64url(randomBytes(16));
}

/** A fresh 32-byte Ed25519 secret key. Any 32 bytes are a valid one. */
export function newSecretKey(): Uint8Array {
  return randomBytes(32);
}

export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  return ed.getPublicKey(secretKey);
}

export interface RequestToSign {
  readonly chainId: number;
  readonly method: string;
  /** Path + query as sent, WITHOUT the `/api` prefix — e.g. `/v1/trading/fills?count=1`. */
  readonly target: string;
  readonly timestampMs: number;
  readonly nonce: string;
  readonly body?: string;
}

/** A request-target that can never verify, caught before it costs a 401. */
export class RequestTargetError extends Error {
  constructor(target: string) {
    super(
      `request-target "${target}" must start with /v1/ — Perpl verifies the path with the ` +
        '/api prefix already stripped',
    );
    this.name = 'RequestTargetError';
  }
}

export function canonicalRequest(request: RequestToSign): string {
  if (!request.target.startsWith('/v1/')) throw new RequestTargetError(request.target);
  return [
    String(request.chainId),
    request.method.toUpperCase(),
    request.target,
    String(request.timestampMs),
    request.nonce,
    bytesToHex(sha256(utf8ToBytes(request.body ?? ''))),
  ].join('\n');
}

/** The four `X-API-*` headers for one request. */
export function signRequest(
  credentials: PerplCredentials,
  request: RequestToSign,
): Record<string, string> {
  const signature = ed.sign(utf8ToBytes(canonicalRequest(request)), credentials.secretKey);
  return {
    'X-API-Key': credentials.apiKey,
    'X-API-Timestamp': String(request.timestampMs),
    'X-API-Nonce': request.nonce,
    'X-API-Signature': base64url(signature),
  };
}

export function signInCanonical(chainId: number, timestampMs: number, nonce: string): string {
  return [String(chainId), 'trading-ws-signin', String(timestampMs), nonce].join('\n');
}

export interface ApiKeySignInFrame {
  readonly mt: 29;
  readonly chain_id: number;
  readonly api_key: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}

/** The `ApiKeySignIn` frame. Must be the FIRST frame, within 10s of open on testnet. */
export function signInFrame(
  credentials: PerplCredentials,
  chainId: number,
  timestampMs: number,
  nonce: string,
): ApiKeySignInFrame {
  const signature = ed.sign(
    utf8ToBytes(signInCanonical(chainId, timestampMs, nonce)),
    credentials.secretKey,
  );
  return {
    mt: 29,
    chain_id: chainId,
    api_key: credentials.apiKey,
    timestamp: String(timestampMs),
    nonce,
    signature: base64url(signature),
  };
}

/**
 * Local clock corrected to Perpl's.
 *
 * A phone's clock can be minutes off, and Perpl rejects any timestamp more
 * than 30s from its own. Every HTTP response carries a `Date` header, so each
 * exchange is a free time sample: `Date` has one-second resolution and
 * truncates, so the server read somewhere in `[date, date + 1000)` while we
 * were waiting — take the middle of both windows. Worst-case error is half a
 * second plus half the round trip, far inside the 30s budget.
 */
export class ServerClock {
  private offsetMs = 0;
  private synced = false;
  private readonly localNow: () => number;

  constructor(localNow: () => number = () => Date.now()) {
    this.localNow = localNow;
  }

  get isSynced(): boolean {
    return this.synced;
  }

  /** Estimated server minus local, in ms. */
  get offset(): number {
    return this.offsetMs;
  }

  /** The local clock, uncorrected — for timing a request's round trip. */
  local(): number {
    return this.localNow();
  }

  /** Server time now, in ms. Use this for every signed timestamp. */
  now(): number {
    return Math.round(this.localNow() + this.offsetMs);
  }

  /** Feeds one HTTP exchange. Ignores a missing or unparseable header. */
  observe(dateHeader: string | null, sentAtMs: number, receivedAtMs: number): void {
    if (!dateHeader) return;
    const serverMs = Date.parse(dateHeader);
    if (Number.isNaN(serverMs)) return;
    this.offsetMs = serverMs + 500 - (sentAtMs + receivedAtMs) / 2;
    this.synced = true;
  }
}
