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
import { createECDH, createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { test } from 'node:test';

import { wordlist } from '@scure/bip39/wordlists/english.js';
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
  // That the pinned key is *correct*, not merely stable, is checked by the
  // node:crypto reference derivation below (SEN-138).
  assert.equal(addressFor(PRF_A), '0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F');
});

/*
 * Reference BIP-39/BIP-32 derivation on node:crypto alone (SEN-138).
 *
 * Why it exists: deriveEvmKey is built on @scure/bip39 + @scure/bip32, and so
 * is viem, so agreeing with viem proved nothing. This shares no code with
 * either — only the English wordlist, which is data, not implementation — and
 * is itself checked against official vectors before it is trusted.
 */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const toBigInt = (bytes: Uint8Array): bigint => BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
const toBytes32 = (n: bigint): Buffer => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest();

function referenceMnemonic(entropy: Uint8Array): string {
  // 256 bits of entropy + 8 checksum bits = 24 words of 11 bits.
  const bits = [...entropy, sha256(entropy)[0]]
    .map((byte) => byte.toString(2).padStart(8, '0'))
    .join('');
  return Array.from(
    { length: 24 },
    (_, i) => wordlist[parseInt(bits.slice(i * 11, i * 11 + 11), 2)],
  ).join(' ');
}

const referenceSeed = (mnemonic: string, passphrase = ''): Buffer =>
  pbkdf2Sync(
    mnemonic.normalize('NFKD'),
    `mnemonic${passphrase.normalize('NFKD')}`,
    2048,
    64,
    'sha512',
  );

function referenceBip32(seed: Uint8Array, path: string): { key: Buffer; chainCode: Buffer } {
  let digest = createHmac('sha512', 'Bitcoin seed').update(seed).digest();
  let key: Buffer = digest.subarray(0, 32);
  let chainCode: Buffer = digest.subarray(32);
  for (const segment of path.split('/').slice(1)) {
    const hardened = segment.endsWith("'");
    const index = Buffer.alloc(4);
    index.writeUInt32BE(parseInt(segment, 10) + (hardened ? 0x80000000 : 0));
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(key);
    const parent = hardened
      ? Buffer.concat([Buffer.alloc(1), key])
      : ecdh.getPublicKey(null, 'compressed');
    digest = createHmac('sha512', chainCode)
      .update(Buffer.concat([parent, index]))
      .digest();
    key = toBytes32((toBigInt(digest.subarray(0, 32)) + toBigInt(key)) % SECP256K1_N);
    chainCode = digest.subarray(32);
  }
  return { key, chainCode };
}

/** Base58Check-decodes an xprv into its chain code and private key. */
function decodeXprv(xprv: string): { key: Buffer; chainCode: Buffer } {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const char of xprv) n = n * 58n + BigInt(alphabet.indexOf(char));
  const raw = Buffer.from(n.toString(16).padStart(164, '0'), 'hex'); // 78 + 4 checksum
  const payload = raw.subarray(0, 78);
  assert.deepEqual(raw.subarray(78), sha256(sha256(payload)).subarray(0, 4), 'bad checksum');
  return { chainCode: payload.subarray(13, 45), key: payload.subarray(46, 78) };
}

test('the reference BIP-32 reproduces official BIP-32 test vector 1', () => {
  // Seed and xprvs copied from BIP-32 "Test vector 1" (bips/bip-0032.mediawiki).
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const vectors: [string, string][] = [
    [
      'm',
      'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
    ],
    [
      "m/0'/1/2'/2/1000000000",
      'xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76',
    ],
  ];
  for (const [path, xprv] of vectors) {
    assert.deepEqual(referenceBip32(seed, path), decodeXprv(xprv), path);
  }
});

test('the reference BIP-39 reproduces the official Trezor vector', () => {
  // First 256-bit English entry of trezor/python-mnemonic vectors.json.
  const mnemonic = referenceMnemonic(new Uint8Array(32));
  assert.equal(mnemonic, `${'abandon '.repeat(23)}art`);
  assert.equal(
    referenceSeed(mnemonic, 'TREZOR').toString('hex'),
    'bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8',
  );
});

test('deriveEvmKey agrees with the independent reference derivation', () => {
  // The path is spelled out rather than taken from evmDerivationPath, so a
  // change to the production path fails here instead of being mirrored.
  const seed = referenceSeed(referenceMnemonic(PRF_A));
  for (const index of [0, 1]) {
    const { key } = referenceBip32(seed, `m/44'/60'/0'/0/${index}`);
    assert.deepEqual(Buffer.from(deriveEvmKey(PRF_A, index)), key, `index ${index}`);
  }
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

test('the namespace list is append-only and its salts are pinned', () => {
  // Counting namespaces would not catch the mistake that matters. These strings
  // are permanent inputs to the derivation (CLAUDE.md), so a rename silently
  // strands every key already derived under the old salt — including, for
  // `device`, every Privy wallet whose owner the phone could then no longer
  // reproduce. Pin the list and the bytes, not the length.
  assert.deepEqual([...PRF_NAMESPACES], ['wallet', 'agent-memory', 'device']);
  assert.equal(
    bytesToHex(prfSaltFor('device')),
    '0x8a34f722d90c3832e7745deef93794a35a96616cf76d0db2ddab132d03d366f8',
  );
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
