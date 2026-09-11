// Operator authorization keys — the P-256 keypairs that make a Privy key quorum
// mean something. Ported from turnstile `buyer/org/authorization-key.ts`; the
// pure half (`canonicalize`, `AuthorizationPayload`) lives in `@sente/mandate`
// so the phone can share it, and this file keeps only what needs node:crypto.
//
// A Privy resource (a wallet, a policy) can name an **owner**. Once it has one,
// Privy's server refuses to mutate it unless the request carries enough
// `privy-authorization-signature` headers to satisfy that owner's quorum
// threshold. The signature is over the request itself, so it cannot be replayed
// against a different body or a different URL.
//
// That is why Sente holds two of these and never one: the agent key owns the
// wallets (it signs trades), the mandate-owner key owns the policies (it can
// change the limits). **The key that spends can never raise its own limit**,
// and the check runs on Privy's side, not ours.
//
// ## Three encodings, and mixing them up is the first hour you lose
//
// | Where | Encoding |
// |---|---|
// | `key_quorums.public_keys[]` | base64 **SPKI DER** — the body of a PEM public key, no armour |
// | Privy's own dashboard export | base64 **PKCS#8 DER** with a literal `wallet-auth:` prefix |
// | `privy-authorization-signature` | base64 of the **DER-encoded** ECDSA signature (not raw r‖s) |
//
// Node's `crypto.sign('sha256', …)` on a P-256 key already emits DER, so the
// third is free. The first two are what {@link loadAuthorizationKey} normalises.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as ecdsaSign,
} from 'node:crypto';

import { canonicalize, type AuthorizationPayload } from '@sente/mandate';

/**
 * One operator's authorization keypair.
 *
 * Both halves are base64 DER with no PEM armour and no `wallet-auth:` prefix,
 * because those are the two forms Privy's API actually accepts.
 */
export interface AuthorizationKey {
  /** base64 PKCS#8 DER. The secret. Never logged, never committed. */
  privateKey: string;
  /** base64 SPKI DER. What `key_quorums.public_keys[]` wants. */
  publicKey: string;
}

/** Generate a fresh P-256 (secp256r1) authorization keypair. */
export function generateAuthorizationKey(): AuthorizationKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  return { privateKey: privateKey.toString('base64'), publicKey: publicKey.toString('base64') };
}

/**
 * Read a private key in any of the shapes it arrives in, and derive its public
 * half.
 *
 * Accepts a bare base64 PKCS#8 blob, the same blob with Privy's `wallet-auth:`
 * prefix, or a full PEM. Deriving the public key rather than storing it means
 * `.env` holds one secret instead of a pair that can drift apart.
 */
export function loadAuthorizationKey(secret: string): AuthorizationKey {
  const trimmed = secret.trim();
  const base64 = trimmed.startsWith('wallet-auth:')
    ? trimmed.slice('wallet-auth:'.length)
    : trimmed;

  const key = base64.includes('-----BEGIN')
    ? createPrivateKey({ key: base64, format: 'pem' })
    : createPrivateKey({ key: pem(base64, 'PRIVATE KEY'), format: 'pem' });

  const asn1 = key.export({ type: 'pkcs8', format: 'der' });
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { privateKey: asn1.toString('base64'), publicKey: publicKey.toString('base64') };
}

function pem(base64: string, label: string): string {
  const body = base64
    .replace(/\s+/g, '')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

/**
 * Sign a request payload with one operator's key.
 *
 * Returns the base64 of a DER ECDSA signature — one element of the
 * comma-separated `privy-authorization-signature` header.
 */
export function signAuthorizationPayload(
  privateKeyBase64: string,
  payload: AuthorizationPayload,
): string {
  const key = createPrivateKey({ key: pem(privateKeyBase64, 'PRIVATE KEY'), format: 'pem' });
  return ecdsaSign('sha256', Buffer.from(canonicalize(payload), 'utf8'), key).toString('base64');
}
