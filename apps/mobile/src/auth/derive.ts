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
 * Nothing here is stored, and nothing is random: the same passkey, rpId and
 * salt always produce the same key. `rpId` is baked into the PRF output by the
 * authenticator, which is why it is a permanent constant (see the repo
 * CLAUDE.md).
 */
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
 * declared here so the two can never collide.
 *
 * These strings are permanent for the same reason `rpId` is: they are inputs
 * to the derivation, so changing one makes existing keys unreachable.
 */
export const PRF_NAMESPACES = ['wallet', 'agent-memory'] as const;

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
  if (prfOutput.length !== PRF_OUTPUT_BYTES) {
    throw new RangeError(
      `PRF output must be ${PRF_OUTPUT_BYTES} bytes, got ${String(prfOutput.length)}`,
    );
  }

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
