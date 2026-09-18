/**
 * Deterministic key derivation from a WebAuthn PRF output.
 *
 * This module is deliberately free of React Native and `@category-labs/mera`
 * imports so it can be exercised under plain node (`src/auth/derive.test.ts`).
 * Everything that touches an authenticator lives in `./mera`.
 *
 * The pipeline is:
 *
 *     PRF(credential, rpId, salt)  ->  32 bytes
 *       -> BIP-39 entropy (24 words)
 *       -> BIP-39 seed
 *       -> BIP-44 m/44'/60'/0'/0/n
 *       -> secp256k1 private key
 *
 * and, under the `device` salt, a second and much shorter one:
 *
 *     PRF(credential, rpId, salt)  ->  32 bytes
 *       -> sha256
 *       -> reduced into [1, n-1]
 *       -> P-256 private key
 *
 * Nothing here is stored, and nothing is random: the same passkey, rpId and
 * salt always produce the same key. `rpId` is baked into the PRF output by the
 * authenticator, which is why it is a permanent constant (see the repo
 * CLAUDE.md).
 */
import { p256 } from '@noble/curves/nist.js';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** WebAuthn PRF outputs are always 32 bytes, and BIP-39 accepts 32 as entropy. */
export const PRF_OUTPUT_BYTES = 32;

/**
 * Namespaces for PRF salts.
 *
 * One passkey, many keys: a different salt against the same credential yields
 * an unrelated 32-byte output, so each namespace is an independent key domain.
 * `wallet` is the signing EOA. `agent-memory` is reserved for the encrypted
 * agent-memory vault (MOV-2xx, the "One Passkey, Many Keys" bounty) and is
 * declared here so the two can never collide. `device` is the P-256 key that
 * owns the user's Privy wallet and its agents' mandate policies (SEN-38): it
 * is a *separate* domain on purpose, so the key that spends on chain and the
 * key that can widen an agent's authority are not the same secret.
 *
 * These strings are permanent for the same reason `rpId` is: they are inputs
 * to the derivation, so changing one makes existing keys unreachable.
 *
 * Append only. Renaming one strands every wallet registered under it.
 */
export const PRF_NAMESPACES = ['wallet', 'agent-memory', 'device'] as const;

export type PrfNamespace = (typeof PRF_NAMESPACES)[number];

/** Versioned prefix so a future salt scheme can coexist with this one. */
const PRF_SALT_PREFIX = 'sente.prf.v1.';

/**
 * The 32-byte PRF salt for a namespace.
 *
 * Every caller goes through this rather than hard-coding a salt, so adding a
 * key domain is a one-line change and no two domains can accidentally share
 * key material.
 */
export function prfSaltFor(namespace: PrfNamespace): Uint8Array {
  return sha256(utf8ToBytes(PRF_SALT_PREFIX + namespace));
}

/** BIP-44 path for Ethereum (coin type 60), account 0, external chain. */
export function evmDerivationPath(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new RangeError(`account index must be a non-hardened uint31, got ${String(index)}`);
  }
  return `m/44'/60'/0'/0/${index}`;
}

/** Overwrites byte arrays in place. Safe to call with already-detached views. */
export function zeroize(...arrays: (Uint8Array | null | undefined)[]): void {
  for (const array of arrays) {
    if (array != null && array.byteLength > 0) array.fill(0);
  }
}

/** @throws RangeError when `prfOutput` is not exactly {@link PRF_OUTPUT_BYTES}. */
function assertPrfOutput(prfOutput: Uint8Array): void {
  if (prfOutput.length !== PRF_OUTPUT_BYTES) {
    throw new RangeError(
      `PRF output must be ${PRF_OUTPUT_BYTES} bytes, got ${String(prfOutput.length)}`,
    );
  }
}

/**
 * Derives the secp256k1 private key for `index` from a 32-byte PRF output.
 *
 * The caller owns the returned key and is responsible for zeroing it — see
 * `openWalletSession` in `./mera`, which hands it straight to a mera signing
 * session (which takes its own copy) and then wipes it.
 *
 * Caveat worth stating plainly: `entropyToMnemonic` returns a JS string, and
 * strings cannot be zeroed. That copy of the entropy lives until GC collects
 * it. Everything we *can* wipe — the seed, the HD nodes — is wiped in `finally`.
 *
 * @throws RangeError when `prfOutput` is not exactly 32 bytes.
 */
export function deriveEvmKey(prfOutput: Uint8Array, index = 0): Uint8Array {
  assertPrfOutput(prfOutput);

  const path = evmDerivationPath(index);
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  let master: HDKey | undefined;
  let node: HDKey | undefined;
  try {
    master = HDKey.fromMasterSeed(seed);
    node = master.derive(path);
    // `privateKey` is a getter returning a fresh copy, so wiping the node below
    // does not clobber what we return.
    const { privateKey } = node;
    if (privateKey === null) throw new Error(`derivation produced no private key for ${path}`);
    return privateKey;
  } finally {
    zeroize(seed);
    master?.wipePrivateData();
    node?.wipePrivateData();
  }
}

/** A P-256 private key is a scalar in [1, n-1], serialized as 32 big-endian bytes. */
const DEVICE_KEY_BYTES = 32;

/**
 * Derives the P-256 "device key" from a 32-byte PRF output.
 *
 * Used with the `device` namespace's salt (`prfSaltFor('device')`), so this key
 * is independent of the wallet EOA: neither can be computed from the other
 * without the passkey. It is the key Privy is told to accept as the *owner* of
 * the user's wallet and of every agent mandate policy, which is what keeps the
 * server — which holds the Privy app secret — unable to widen an agent.
 *
 * The reduction is `sha256(prfOutput) mod (n - 1) + 1`, byte for byte what
 * noble's own `mapHashToField` does (`@noble/curves/abstract/modular.js`). It
 * is not called directly because it refuses an input shorter than 1.5x the
 * field — 48 bytes for P-256 — which is the general condition for its bias to
 * be negligible. This derivation does not meet that condition and does not need
 * to: P-256's order n is within 2^-128 of 2^256, so reducing a uniform 256-bit
 * value modulo n-1 skews it by about 2^-128, and the FIPS 186-4 B.4.1 rule that
 * motivates the 1.5x figure exists for curves whose order sits far from a power
 * of two. What the reduction buys is a derivation that is one hash long and
 * cannot fail, so there is no rejection loop whose iteration count could leak
 * through timing.
 *
 * The caller owns the returned key and is responsible for zeroing it. The
 * intermediate `bigint` cannot be wiped — bigints are immutable and GC-managed,
 * exactly like the BIP-39 mnemonic string in {@link deriveEvmKey}. The sha256
 * digest, which can be, is wiped here.
 *
 * @throws RangeError when `prfOutput` is not exactly 32 bytes.
 */
export function deriveDeviceKey(prfOutput: Uint8Array): Uint8Array {
  assertPrfOutput(prfOutput);

  const digest = sha256(prfOutput);
  try {
    const order = p256.Point.Fn.ORDER;
    const scalar = (bytesToNumberBE(digest) % (order - 1n)) + 1n;
    return numberToBytesBE(scalar, DEVICE_KEY_BYTES);
  } finally {
    zeroize(digest);
  }
}
