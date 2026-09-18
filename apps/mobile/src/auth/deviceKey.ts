/**
 * The phone's half of Privy authorization: the device key's public form, and
 * the signature Privy checks before it will mutate anything that key owns.
 *
 * A Privy resource (a wallet, a policy) can name an **owner**. Once it has one,
 * Privy refuses to mutate it unless the request carries enough
 * `privy-authorization-signature` headers to satisfy that owner's quorum. Sente
 * makes the phone that owner: the server holds the Privy app secret and can
 * therefore *ask*, but only the passkey-derived key on the device can *approve*.
 * That is the SEN-31 property taken one step further — see
 * `services/api/src/agents/privy/authorization-key.ts`, which is the same
 * signature built on `node:crypto` for the keys the server does hold.
 *
 * **That property only holds if the phone builds the payload it signs.**
 * {@link signPrivyAuthorization} signs whatever it is handed, so a caller that
 * signs a payload the server sent it has built a rubber stamp: the server could
 * hand it a policy PATCH that widens an agent, which is the one thing this whole
 * arrangement exists to prevent. The payload's assembly convention lives in
 * `services/api/src/agents/privy/privy.client.ts` (`body ?? {}`, only the
 * `privy-` headers, URL with no trailing slash) and the phone must reproduce it
 * from the request it is about to approve. SEN-42 is where that lands.
 *
 * Three encodings, and mixing them up is the first hour you lose:
 *
 * | Where                           | Encoding                                      |
 * | ------------------------------- | --------------------------------------------- |
 * | `key_quorums.public_keys[]`     | base64 **SPKI DER** — a PEM public key's body |
 * | Privy's dashboard export        | base64 PKCS#8 DER, `wallet-auth:` prefixed    |
 * | `privy-authorization-signature` | base64 of the **DER** ECDSA signature          |
 *
 * This module produces the first and the third. It never produces the second:
 * the private key is 32 raw bytes that live in memory for one session and are
 * re-derived from the passkey next time (see `./derive`), so there is nothing
 * to export and nothing to store.
 *
 * Deliberately free of React Native, `node:crypto` and `@category-labs/mera`,
 * so `deviceKey.test.ts` runs under plain node with no device — the same
 * contract `./derive` keeps.
 */
import { p256 } from '@noble/curves/nist.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';

// Type-only, therefore erased by tsc and by Metro's Babel: no `@sente/mandate`
// import survives into the bundle, so the app still needs no alias for it
// (CLAUDE.md gotcha 10). Sharing the *type* is what makes a change to Privy's
// signed request shape a compile error here instead of every device signature
// silently verifying against nothing. Never drop the `type` keyword.
import type { AuthorizationPayload } from '@sente/mandate';

export type { AuthorizationPayload };

/**
 * RFC 8785 JSON Canonicalization Scheme, for the shapes Privy payloads actually
 * contain.
 *
 * **Copied, not imported, from `packages/mandate/src/privy/canonicalize.ts`.**
 * The app does not import `@sente/mandate` at runtime — package exports are off
 * (CLAUDE.md gotchas 2 and 10), so it would need a hand-written Metro alias —
 * and this is twenty lines on the security path. The copy is not trusted to
 * stay a copy: `deviceKey.test.ts` pins it byte-equal to the mandate package's
 * implementation over a fixture set, with `@sente/mandate` a devDependency
 * resolved through `--conditions=source`. If that test fails, the two have
 * drifted and every signature this file makes is worthless.
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

/**
 * The 26 bytes that precede an uncompressed P-256 point in an SPKI DER key.
 *
 * SPKI is `SEQUENCE { AlgorithmIdentifier, BIT STRING }`, and for P-256 every
 * field but the point is constant, so the whole header can be a literal instead
 * of a DER encoder:
 *
 * ```text
 * 30 59                            SEQUENCE, 89 bytes to follow
 *   30 13                          SEQUENCE, 19 bytes — AlgorithmIdentifier
 *     06 07 2a8648ce3d0201         OID 1.2.840.10045.2.1   id-ecPublicKey
 *     06 08 2a8648ce3d030107       OID 1.2.840.10045.3.1.7 prime256v1
 *   03 42 00                       BIT STRING, 66 bytes, 0 unused bits
 *     04 <x:32> <y:32>             the uncompressed point, 65 bytes
 * ```
 *
 * 26 + 65 = 91 bytes, and 0x59 = 89 = 91 - 2. Verified against node's own DER
 * encoder in `deviceKey.test.ts` rather than against this comment.
 */
const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

/**
 * The device key's public half, in the one encoding Privy's
 * `key_quorums.public_keys[]` accepts: base64 SPKI DER, no PEM armour and no
 * `wallet-auth:` prefix.
 *
 * This is what the phone sends to `POST /wallet/register` (SEN-40/41), and what
 * the server then names as the owner of the user's Privy wallet. It is public
 * by construction — deriving it does not put the private key anywhere new.
 *
 * @throws Error when `privateKey` is not a valid P-256 scalar.
 */
export function devicePublicKeySpki(privateKey: Uint8Array): string {
  // `false` asks for the uncompressed SEC1 form (0x04 ‖ x ‖ y). SPKI carries
  // the point verbatim, and Privy's parser wants the uncompressed one.
  const point = p256.getPublicKey(privateKey, false);
  const spki = new Uint8Array(P256_SPKI_PREFIX.length + point.length);
  spki.set(P256_SPKI_PREFIX);
  spki.set(point, P256_SPKI_PREFIX.length);
  return base64.encode(spki);
}

/**
 * Signs one Privy authorization payload with the device key.
 *
 * Returns the base64 of a DER ECDSA-P256/SHA-256 signature — one element of the
 * comma-separated `privy-authorization-signature` header, byte-compatible with
 * what `signAuthorizationPayload` emits on the server, because node's
 * `crypto.sign('sha256', …)` on a P-256 key also emits DER.
 *
 * Signatures are not reproducible across the two implementations and are not
 * meant to be: noble derives `k` deterministically (RFC 6979) while OpenSSL
 * draws it at random, so two correct signers over the same bytes disagree. What
 * must match byte for byte is the *message* — the canonical payload — and that
 * is what the canonicalization test pins.
 *
 * The low-S normalization noble applies by default is kept. A low-S signature
 * is an ordinary valid ECDSA signature; every verifier that accepts high-S
 * accepts it too, so this costs nothing and removes the malleability.
 *
 * See the module header before deciding where `payload` comes from: signing one
 * the server composed gives away the property this key exists to hold.
 *
 * @throws Error when `privateKey` is not a valid P-256 scalar, or when the
 * payload contains something {@link canonicalize} refuses to encode.
 */
export function signPrivyAuthorization(
  privateKey: Uint8Array,
  payload: AuthorizationPayload,
): string {
  const message = utf8ToBytes(canonicalize(payload));
  // `prehash: true` is sha256(message) inside noble, which is what the header
  // is defined over; `format: 'der'` is the encoding Privy parses.
  return base64.encode(p256.sign(message, privateKey, { prehash: true, format: 'der' }));
}
