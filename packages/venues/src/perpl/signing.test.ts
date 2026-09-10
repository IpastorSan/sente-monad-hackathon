/**
 * Request signing pinned against fixed vectors.
 *
 * The expected signatures were produced by node's own `crypto.sign` (OpenSSL's
 * Ed25519), not by noble, from the RFC 8032 test-1 key — so a match here is
 * two independent implementations agreeing, not one agreeing with itself.
 * Ed25519 is deterministic, which is what makes a fixed vector possible.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as ed from '@noble/ed25519';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import {
  RequestTargetError,
  ServerClock,
  base64url,
  canonicalRequest,
  newNonce,
  publicKeyOf,
  signInCanonical,
  signInFrame,
  signRequest,
} from './signing.ts';

const SECRET = hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const CREDENTIALS = { apiKey: 'test-token', secretKey: SECRET };
const NONCE = 'AAECAwQFBgcICQoLDA0ODw'; // base64url of bytes 0x00..0x0f
const TS = 1789065422000;

test('public key matches RFC 8032 test 1', () => {
  assert.equal(Buffer.from(publicKeyOf(SECRET)).toString('hex'), PUBLIC);
});

test('base64url: no padding, url alphabet, all tail lengths', () => {
  assert.equal(base64url(Uint8Array.from([...Array(16).keys()])), NONCE);
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 255);
    assert.equal(base64url(bytes), Buffer.from(bytes).toString('base64url'), `length ${n}`);
  }
  assert.equal(base64url(Uint8Array.from([0xfb, 0xff])), '-_8');
});

test('canonical REST string: six lines, sha256 of the empty body', () => {
  assert.equal(
    canonicalRequest({
      chainId: 10143,
      method: 'get',
      target: '/v1/trading/fills?count=100',
      timestampMs: TS,
      nonce: NONCE,
    }),
    [
      '10143',
      'GET',
      '/v1/trading/fills?count=100',
      '1789065422000',
      NONCE,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ].join('\n'),
  );
});

test('signRequest: GET vector, byte-exact headers', () => {
  const headers = signRequest(CREDENTIALS, {
    chainId: 10143,
    method: 'GET',
    target: '/v1/trading/fills?count=100',
    timestampMs: TS,
    nonce: NONCE,
  });
  assert.deepEqual(headers, {
    'X-API-Key': 'test-token',
    'X-API-Timestamp': '1789065422000',
    'X-API-Nonce': NONCE,
    'X-API-Signature':
      'YwZ3q0hZMCT-UhbILjXI-ejuN9I9wwjKxiBFgr-Wq-o4St2tt1qYV79EuTndAmOsBiSNxRxdhPUYzMoGtWgQDg',
  });
});

test('signRequest: POST vector hashes the body', () => {
  const headers = signRequest(CREDENTIALS, {
    chainId: 10143,
    method: 'POST',
    target: '/v1/some/target',
    timestampMs: TS,
    nonce: NONCE,
    body: '{"a":1}',
  });
  assert.equal(
    headers['X-API-Signature'],
    'v8HTKi05ma7JyvOKCzbRvfbVVdCRR3IgtlCTpp_Z8t-Nf7o-EjGECKyU5lfeEMfPS8L-7Cf9RYq93pPJScIIAA',
  );
});

test('the /api prefix is refused before it can cost a 401', () => {
  assert.throws(
    () =>
      canonicalRequest({
        chainId: 10143,
        method: 'GET',
        target: '/api/v1/trading/fills',
        timestampMs: TS,
        nonce: NONCE,
      }),
    RequestTargetError,
  );
});

test('WS sign-in frame: four-line canonical string, vector signature', () => {
  assert.equal(
    signInCanonical(10143, TS, NONCE),
    `10143\ntrading-ws-signin\n1789065422000\n${NONCE}`,
  );
  assert.deepEqual(signInFrame(CREDENTIALS, 10143, TS, NONCE), {
    mt: 29,
    chain_id: 10143,
    api_key: 'test-token',
    timestamp: '1789065422000',
    nonce: NONCE,
    signature:
      'KkZOVYfycuBTKT5Mt4ngtR0NtVYk_73dB8TTPyzcfi4v2FNVhpqwBplNgPyLYWYPXLq96OTAsX48zox1KX10Cg',
  });
});

test('signatures verify under the public key', () => {
  const frame = signInFrame(CREDENTIALS, 10143, TS, NONCE);
  const signature = Buffer.from(frame.signature, 'base64url');
  assert.ok(
    ed.verify(signature, utf8ToBytes(signInCanonical(10143, TS, NONCE)), hexToBytes(PUBLIC)),
  );
});

test('nonces are 16 bytes and never repeat', () => {
  const seen = new Set(Array.from({ length: 200 }, newNonce));
  assert.equal(seen.size, 200);
  for (const nonce of seen) assert.equal(Buffer.from(nonce, 'base64url').length, 16);
});

test('ServerClock: corrects a local clock 45s behind', () => {
  const server = 1789065422000;
  let local = server - 45_000;
  const clock = new ServerClock(() => local);
  assert.equal(clock.isSynced, false);

  // A 200ms round trip, answered at `server` (the Date header truncates to the second).
  clock.observe(new Date(server).toUTCString(), local - 100, local + 100);
  assert.equal(clock.isSynced, true);
  assert.equal(clock.offset, 45_500);

  local += 10_000;
  const skew = clock.now() - (server + 10_000);
  assert.ok(Math.abs(skew) <= 1_000, `skew ${skew}ms must be well inside the 30s window`);
});

test('ServerClock: ignores a missing or garbage Date header', () => {
  const clock = new ServerClock(() => 1_000);
  clock.observe(null, 0, 0);
  clock.observe('not a date', 0, 0);
  assert.equal(clock.isSynced, false);
  assert.equal(clock.now(), 1_000);
});
