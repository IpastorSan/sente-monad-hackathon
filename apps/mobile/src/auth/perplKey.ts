/**
 * The phone's Perpl trade key (SEN-89, plan M-T7): an Ed25519 key derived from
 * the device key, so it needs no storage, survives a reinstall and costs no
 * extra passkey prompt.
 *
 *     device private key (P-256 scalar, see `./derive`)
 *       -> HKDF-SHA256(salt = empty,
 *                      info = "sente.perpl.trade-key.v1" ‖ lowercase wallet)
 *       -> 32 bytes = Ed25519 secret key
 *
 * The wallet address is in `info` so one device key yields an independent
 * trade key per Perpl account, and it is lowercased because the same address
 * arrives checksummed from viem and lowercase from Perpl's typed data — two
 * spellings of one account must not derive two keys.
 *
 * Why the device key and not a new PRF salt: a new salt costs a WebAuthn prompt
 * per sign-in (CLAUDE.md, "A second salt costs a second WebAuthn prompt"),
 * while the device key is already in memory for the session.
 *
 * Like `./derive`, free of React Native, `node:crypto` and mera, so
 * `perplKey.test.ts` runs under plain node. Uses `@noble/curves`' Ed25519
 * rather than `@noble/ed25519` (what `@sente/venues/perpl` uses) because the
 * app already bundles the former; the test pins the two to the same public key.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { isAddress, type Address, type Hex } from 'viem';

/**
 * The HKDF `info` label for the Perpl trade key.
 *
 * **PERMANENT once a key derived under it is enrolled with Perpl.** It is an
 * input to the derivation, exactly like a `sente.prf.v1.*` salt namespace:
 * rename it and every phone derives a different key that Perpl does not
 * recognise, so each user must re-enroll — and every enrollment burns one of
 * the account's 16 Perpl API-key slots. Unlike the PRF salts, renaming it
 * cannot lose funds (the account is still the wallet's), but it is listed in
 * CLAUDE.md's permanent values for that reason. Add a `.v2` label beside it;
 * never edit this one.
 */
export const PERPL_TRADE_KEY_LABEL = 'sente.perpl.trade-key.v1';

/** Ed25519 secret keys are 32 bytes, and any 32 bytes are a valid one. */
const TRADE_KEY_BYTES = 32;

export interface PerplTradeKey {
  /** Ed25519 secret key. The caller owns it and must zeroize it when done. */
  readonly secretKey: Uint8Array;
  /** `0x`-prefixed 32-byte public key, the form Perpl's `public_key` field takes. */
  readonly publicKeyHex: Hex;
}

/**
 * Derives the Perpl trade key for `wallet` from the device private key.
 *
 * Deterministic: the same device key and wallet always give the same key, which
 * is what lets the phone re-derive it every session instead of storing it.
 *
 * @throws TypeError when `wallet` is not a 20-byte hex address — a malformed
 * address would otherwise derive a valid-looking key for no account at all.
 */
export function perplTradeKey(devicePrivateKey: Uint8Array, wallet: Address): PerplTradeKey {
  // Non-strict: checksum casing is irrelevant once lowercased below.
  if (!isAddress(wallet, { strict: false })) {
    throw new TypeError(`perplTradeKey: not an address: ${String(wallet)}`);
  }
  const info = concatBytes(utf8ToBytes(PERPL_TRADE_KEY_LABEL), utf8ToBytes(wallet.toLowerCase()));
  // `undefined` salt is RFC 5869's "not provided", i.e. HashLen zero bytes —
  // the same key node's `hkdfSync` produces for an empty salt.
  const secretKey = hkdf(sha256, devicePrivateKey, undefined, info, TRADE_KEY_BYTES);
  const publicKeyHex: Hex = `0x${bytesToHex(ed25519.getPublicKey(secretKey))}`;
  return { secretKey, publicKeyHex };
}
