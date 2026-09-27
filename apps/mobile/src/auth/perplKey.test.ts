/**
 * Perpl trade-key tests (SEN-89). Plain node, no device.
 *
 * The expected keys come from `node:crypto`'s `hkdfSync` (OpenSSL), not from
 * `@noble/hashes`, and the public key is checked against
 * `@sente/venues/perpl`'s `publicKeyOf` (`@noble/ed25519`), not the
 * `@noble/curves` Ed25519 the module uses — so no assertion is the module's own
 * code checking itself. The hex literal pins the vector across both: if it ever
 * changes, every enrolled trade key has changed with it.
 */
import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { test } from 'node:test';

import { publicKeyOf } from '@sente/venues/perpl';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getAddress, type Address } from 'viem';

import { PERPL_TRADE_KEY_LABEL, perplTradeKey } from './perplKey.ts';

/** Arbitrary but pinned 32-byte device key: 0x00, 0x01, ... 0x1f. */
const DEVICE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);

/** Anvil #0 and #1 (CLAUDE.md gotcha 11): public, never fund anything from them. */
const WALLET_A: Address = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const WALLET_B: Address = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

/** HKDF-SHA256(ikm = DEVICE_KEY, salt = empty, info = label ‖ WALLET_A), from `hkdfSync`. */
const VECTOR_A = 'e4efa31a5c7ad9de661afea83e8f43f47cd2cf2d576451a7a16c39400710a329';

function nodeHkdf(ikm: Uint8Array, wallet: string): string {
  const info = Buffer.from(`${PERPL_TRADE_KEY_LABEL}${wallet.toLowerCase()}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32)).toString('hex');
}

test('the label is pinned — renaming it forces every user to re-enroll', () => {
  assert.equal(PERPL_TRADE_KEY_LABEL, 'sente.perpl.trade-key.v1');
});

test('fixed vector matches node:crypto HKDF and the pinned literal', () => {
  const { secretKey } = perplTradeKey(DEVICE_KEY, WALLET_A);
  assert.equal(bytesToHex(secretKey), nodeHkdf(DEVICE_KEY, WALLET_A));
  assert.equal(bytesToHex(secretKey), VECTOR_A);
});

test('the public key matches @sente/venues/perpl publicKeyOf', () => {
  const { secretKey, publicKeyHex } = perplTradeKey(DEVICE_KEY, WALLET_A);
  assert.equal(publicKeyHex, `0x${bytesToHex(publicKeyOf(secretKey))}`);
  assert.match(publicKeyHex, /^0x[0-9a-f]{64}$/);
});

test('different wallets derive different keys', () => {
  const a = perplTradeKey(DEVICE_KEY, WALLET_A);
  const b = perplTradeKey(DEVICE_KEY, WALLET_B);
  assert.notEqual(bytesToHex(a.secretKey), bytesToHex(b.secretKey));
  assert.notEqual(a.publicKeyHex, b.publicKeyHex);
  assert.equal(bytesToHex(b.secretKey), nodeHkdf(DEVICE_KEY, WALLET_B));
});

test('different device keys derive different keys', () => {
  const other = Uint8Array.from(DEVICE_KEY);
  other[31] ^= 1;
  assert.notEqual(
    bytesToHex(perplTradeKey(other, WALLET_A).secretKey),
    bytesToHex(perplTradeKey(DEVICE_KEY, WALLET_A).secretKey),
  );
});

test('checksummed and lowercase spellings of one wallet derive one key', () => {
  const checksummed = getAddress(WALLET_A);
  assert.notEqual(checksummed, WALLET_A);
  assert.equal(bytesToHex(perplTradeKey(DEVICE_KEY, checksummed).secretKey), VECTOR_A);
});

test('a malformed address is refused rather than derived from', () => {
  assert.throws(() => perplTradeKey(DEVICE_KEY, '0x1234' as Address), TypeError);
});
