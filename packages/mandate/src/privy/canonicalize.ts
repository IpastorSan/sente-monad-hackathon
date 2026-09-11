/**
 * RFC 8785 canonical JSON, and the request shape Privy signs.
 *
 * Ported verbatim from turnstile's `buyer/org/authorization-key.ts` (MOV-228),
 * where it was exercised against the live Privy API on 2026-09-07: a policy
 * PATCH signed over this encoding was accepted with a full quorum of
 * signatures and refused one signature short. Only `canonicalize` and
 * `AuthorizationPayload` came across. The signing half needs `node:crypto` and
 * stays server-side; this half is pure, so the phone can share it and produce
 * byte-identical payloads.
 *
 * Note for callers building policy bodies: a `bigint` is not JSON and is
 * rejected here, which is why every uint in a compiled rule is a `0x` hex
 * string (see `policy-types.ts`).
 */

/**
 * The object Privy signs: the request, reduced to the five things that identify
 * it.
 *
 * `headers` carries only the `privy-` prefixed ones, so a proxy adding a
 * `user-agent` does not invalidate a signature.
 */
export interface AuthorizationPayload {
  version: 1;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Full URL, no trailing slash. */
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * RFC 8785 JSON Canonicalization Scheme, for the shapes Privy payloads actually
 * contain.
 *
 * Written out rather than pulled from npm because it is twenty lines and it is
 * on the security path: a canonicalizer that disagrees with Privy's by one
 * character produces a signature that verifies against nothing, and a dependency
 * is a worse place to debug that than this file.
 *
 * **Scope, stated rather than implied:** objects, arrays, strings, booleans,
 * `null`, and integers within `Number.MAX_SAFE_INTEGER`. Privy's payloads are
 * exactly that. Non-integer numbers are *rejected* rather than serialized,
 * because RFC 8785 mandates ECMAScript `Number::toString` for them and a
 * half-right implementation would fail silently at signature-check time instead
 * of here. `undefined` members are dropped, as `JSON.stringify` drops them.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`canonicalize: only safe integers are supported, got ${value}`);
    }
    return String(value);
  }
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    // RFC 8785 sorts by UTF-16 code unit, which is what `<` on JS strings does.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  throw new Error(`canonicalize: unsupported value of type ${typeof value}`);
}
