import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * ---------------------------------------------------------------------------
 * THE SESSION TOKEN
 *
 * `v1.<payload>.<mac>`, both segments base64url, where `payload` is the JSON
 * `{sub, exp}` and `mac` is HMAC-SHA256 over the string `v1.<payload>` under
 * `AUTH_SESSION_SECRET`.
 *
 * Shaped like a JWT and deliberately not one: there is no `alg` field, so there
 * is no algorithm to confuse and no `none` to accept. The version prefix is
 * inside the MAC, so a future `v2` with different claims cannot be replayed as
 * a v1 token. One secret, one algorithm, verified in one place.
 *
 * The token is a BEARER credential: whoever holds it is the user until it
 * expires. That is why the TTL is bounded, why the phone keeps it in memory
 * only, and why nothing else about the user is encoded in it — `sub` and `exp`
 * are the whole claim set, and everything else is looked up server-side.
 * ---------------------------------------------------------------------------
 */
export const SESSION_TOKEN_VERSION = 'v1';

export interface SessionClaims {
  /** Subject: the caller's lowercase EOA address. */
  sub: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

export type SessionTokenFailure =
  /** Not three dot-separated segments, or not our version, or not JSON. */
  | 'malformed'
  /** The MAC does not match: forged, tampered with, or signed by another key. */
  | 'bad_signature'
  /** Well-formed and genuine, but past `exp`. */
  | 'expired';

export type SessionTokenVerification =
  { ok: true; claims: SessionClaims } | { ok: false; failure: SessionTokenFailure };

export function mintSessionToken(secret: Buffer, claims: SessionClaims): string {
  const payload = base64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const signed = `${SESSION_TOKEN_VERSION}.${payload}`;
  return `${signed}.${base64url(sign(secret, signed))}`;
}

/**
 * Verifies signature BEFORE expiry, and expiry before anything else is read.
 *
 * Order matters: the claims of an unverified token are attacker-controlled
 * bytes, so nothing may be trusted — not even to decide the failure reason —
 * until the MAC has matched.
 */
export function verifySessionToken(
  secret: Buffer,
  token: string,
  nowS: number,
): SessionTokenVerification {
  const segments = token.split('.');
  if (segments.length !== 3) return { ok: false, failure: 'malformed' };

  const [version, payload, mac] = segments as [string, string, string];
  if (version !== SESSION_TOKEN_VERSION || payload === '' || mac === '') {
    return { ok: false, failure: 'malformed' };
  }

  const expected = sign(secret, `${version}.${payload}`);
  const presented = Buffer.from(mac, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, failure: 'bad_signature' };
  }

  const claims = parseClaims(payload);
  if (!claims) return { ok: false, failure: 'malformed' };
  if (claims.exp <= nowS) return { ok: false, failure: 'expired' };

  return { ok: true, claims };
}

function sign(secret: Buffer, signed: string): Buffer {
  return createHmac('sha256', secret).update(signed, 'utf8').digest();
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function parseClaims(payload: string): SessionClaims | undefined {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return undefined;
    const { sub, exp } = decoded as Partial<SessionClaims>;
    if (typeof sub !== 'string' || sub.length === 0) return undefined;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;
    return { sub, exp };
  } catch {
    return undefined;
  }
}
