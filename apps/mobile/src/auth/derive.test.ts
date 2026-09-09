/**
 * Derivation tests. Run under plain node (`pnpm --filter @sente/mobile test`);
 * no device, no authenticator, no network.
 *
 * `./derive.ts` is imported with its extension because node's native type
 * stripping resolves specifiers literally — same reason `scripts/*.ts` do it.
 *
 * These cover the properties the wallet depends on. What they cannot cover is
 * whether a real authenticator produces a PRF output at all; that is MOV-259,
 * on a physical Android phone.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { privateKeyToAddress } from 'viem/accounts';
import { bytesToHex } from 'viem/utils';

import {
  deriveEvmKey,
  evmDerivationPath,
  PRF_NAMESPACES,
  PRF_OUTPUT_BYTES,
  prfSaltFor,
  zeroize,
} from './derive.ts';

/** Fixed 32-byte PRF vector: 0x00, 0x01, ... 0x1f. Arbitrary but pinned. */
const PRF_A = Uint8Array.from({ length: PRF_OUTPUT_BYTES }, (_, i) => i);

/** A second vector differing from PRF_A in exactly one bit of the last byte. */
const PRF_B = (() => {
  const bytes = Uint8Array.from(PRF_A);
  bytes[31] ^= 0x01;
  return bytes;
})();

const addressFor = (prf: Uint8Array, index = 0): string =>
  privateKeyToAddress(bytesToHex(deriveEvmKey(prf, index)));

test('the same PRF output always derives the same address', () => {
  assert.equal(addressFor(PRF_A), addressFor(Uint8Array.from(PRF_A)));
});

test('the derived address is pinned to a known vector', () => {
  // Regression guard. If this changes, every existing wallet moved — the only
  // legitimate reason to update it is a deliberate, documented scheme change.
  //
  // Cross-checked against viem's independent BIP-39/BIP-44 implementation:
  // `mnemonicToAccount(entropyToMnemonic(PRF_A, wordlist)).address` agrees, and
  // PRF_A is the canonical BIP-39 entropy vector 000102…1f, whose mnemonic is
  // "abandon amount liar amount expire adjust cage candy arch gather drum
  // bullet absurd math era live bid rhythm alien crouch range attend journey
  // unaware".
  assert.equal(addressFor(PRF_A), '0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F');
});

test('a one-bit difference in the PRF output gives an unrelated address', () => {
  assert.notEqual(addressFor(PRF_A), addressFor(PRF_B));
});

test('each BIP-44 index gives a different address from the same PRF output', () => {
  const addresses = new Set([addressFor(PRF_A, 0), addressFor(PRF_A, 1), addressFor(PRF_A, 2)]);
  assert.equal(addresses.size, 3);
});

test('salts are namespaced, so one passkey yields unrelated keys per domain', () => {
  const salts = PRF_NAMESPACES.map((namespace) => bytesToHex(prfSaltFor(namespace)));
  assert.equal(new Set(salts).size, PRF_NAMESPACES.length);
  for (const salt of salts) assert.equal(salt.length, 2 + PRF_OUTPUT_BYTES * 2);

  // A salt is what the authenticator evaluates, so distinct salts standing in
  // for distinct PRF outputs is the property that separates the domains.
  assert.notEqual(addressFor(prfSaltFor('wallet')), addressFor(prfSaltFor('agent-memory')));
});

test('prfSaltFor is deterministic across calls', () => {
  assert.deepEqual(prfSaltFor('wallet'), prfSaltFor('wallet'));
});

test('deriveEvmKey returns a 32-byte key and does not mutate its input', () => {
  const prf = Uint8Array.from(PRF_A);
  const key = deriveEvmKey(prf);
  assert.equal(key.length, 32);
  assert.deepEqual(prf, PRF_A);
});

test('deriveEvmKey rejects a PRF output that is not 32 bytes', () => {
  assert.throws(() => deriveEvmKey(new Uint8Array(31)), RangeError);
  assert.throws(() => deriveEvmKey(new Uint8Array(33)), RangeError);
});

test('evmDerivationPath is BIP-44 for coin type 60 and rejects bad indices', () => {
  assert.equal(evmDerivationPath(0), "m/44'/60'/0'/0/0");
  assert.equal(evmDerivationPath(7), "m/44'/60'/0'/0/7");
  assert.throws(() => evmDerivationPath(-1), RangeError);
  assert.throws(() => evmDerivationPath(1.5), RangeError);
  assert.throws(() => evmDerivationPath(0x80000000), RangeError);
});

test('zeroize overwrites every array it is given and tolerates nullish', () => {
  const secret = Uint8Array.from(PRF_A);
  zeroize(secret, null, undefined);
  assert.deepEqual(secret, new Uint8Array(PRF_OUTPUT_BYTES));
});

test('a derived key is zeroable by the caller', () => {
  // The contract openWalletSession relies on: the returned key is an ordinary
  // owned buffer, so wiping it after mera copies it actually destroys it.
  const key = deriveEvmKey(PRF_A);
  zeroize(key);
  assert.deepEqual(key, new Uint8Array(32));
});
