/**
 * Device-key tests. Run under plain node (`pnpm --filter @sente/mobile test`);
 * no device, no authenticator, no network.
 *
 * Two of these are load-bearing rather than merely reassuring:
 *
 * - **node verifies what the phone signs.** `node:crypto` is a different ECDSA
 *   implementation (OpenSSL) reading a public key we encoded by hand. If it
 *   accepts the signature, the SPKI bytes, the DER signature bytes and the
 *   digest all agree with the rest of the world — which is what Privy is.
 * - **the copied canonicalizer is pinned to the original.** `./deviceKey.ts`
 *   carries its own copy of `packages/mandate/src/privy/canonicalize.ts`
 *   (CLAUDE.md gotcha 10: the app must not import `@sente/mandate` at runtime),
 *   and a canonicalizer that drifts by one character produces signatures that
 *   verify against nothing. `@sente/mandate` is a devDependency and the test
 *   script passes `--conditions=source`, so this runs the real one.
 *
 * `.ts` extensions on the local imports because node's native type stripping
 * resolves specifiers literally — same reason `scripts/*.ts` do it.
 */
import assert from 'node:assert/strict';
import { createPublicKey, verify as ecdsaVerify } from 'node:crypto';
import { test } from 'node:test';

import { canonicalize as mandateCanonicalize } from '@sente/mandate';

import { deriveDeviceKey, PRF_OUTPUT_BYTES, prfSaltFor, zeroize } from './derive.ts';
import {
  canonicalize,
  devicePublicKeySpki,
  signPrivyAuthorization,
  type AuthorizationPayload,
} from './deviceKey.ts';

/** Fixed 32-byte PRF vector: 0x00, 0x01, ... 0x1f. Arbitrary but pinned. */
const PRF_A = Uint8Array.from({ length: PRF_OUTPUT_BYTES }, (_, i) => i);

/** A second vector differing from PRF_A in exactly one bit of the last byte. */
const PRF_B = (() => {
  const bytes = Uint8Array.from(PRF_A);
  bytes[31] ^= 0x01;
  return bytes;
})();

/**
 * A payload shaped exactly like the ones `PrivyClient.request` signs — see
 * `services/api/src/agents/privy/privy.client.ts`: full URL with no trailing
 * slash, the body object itself, and only the `privy-` headers.
 */
const PAYLOAD: AuthorizationPayload = {
  version: 1,
  method: 'PATCH',
  url: 'https://api.privy.io/v1/policies/xyzpolicy123',
  body: {
    version: '1.0',
    rules: [{ name: 'cap', method: 'eth_sendTransaction', action: 'ALLOW' }],
  },
  headers: { 'privy-app-id': 'test-app-id' },
};

const publicKeyFrom = (spkiBase64: string) =>
  createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });

test('the same PRF output always derives the same device key', () => {
  assert.deepEqual(deriveDeviceKey(PRF_A), deriveDeviceKey(Uint8Array.from(PRF_A)));
});

test('the device public key is pinned to a known vector', () => {
  // Regression guard, the P-256 twin of derive.test.ts's address pin. If this
  // changes, every Privy wallet already registered under the old key is owned
  // by a key the phone can no longer produce — the only legitimate reason to
  // update it is a deliberate, documented scheme change.
  assert.equal(
    devicePublicKeySpki(deriveDeviceKey(PRF_A)),
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAECPZsjN16YyMk2MKu0/F8rQLEj/OWV1XNAHqpZ1T51LXCN9r2d4OZxQ8lqwjHcGL+Ozkw4tDMXQeCl3xGa3fVDw==',
  );
});

test('a one-bit difference in the PRF output gives an unrelated device key', () => {
  assert.notEqual(
    devicePublicKeySpki(deriveDeviceKey(PRF_A)),
    devicePublicKeySpki(deriveDeviceKey(PRF_B)),
  );
});

test('each PRF namespace yields an unrelated device key', () => {
  // Salts stand in for PRF outputs here, as in derive.test.ts: a distinct salt
  // is what makes the authenticator return distinct bytes, so distinct salts
  // are the property that separates the domains.
  const keys = (['wallet', 'agent-memory', 'device'] as const).map((namespace) =>
    devicePublicKeySpki(deriveDeviceKey(prfSaltFor(namespace))),
  );
  assert.equal(new Set(keys).size, keys.length);
});

test('deriveDeviceKey returns a 32-byte key and does not mutate its input', () => {
  const prf = Uint8Array.from(PRF_A);
  const key = deriveDeviceKey(prf);
  assert.equal(key.length, 32);
  assert.deepEqual(prf, PRF_A);
});

test('deriveDeviceKey rejects a PRF output that is not 32 bytes', () => {
  assert.throws(() => deriveDeviceKey(new Uint8Array(31)), RangeError);
  assert.throws(() => deriveDeviceKey(new Uint8Array(33)), RangeError);
});

test('the derived scalar is always a usable P-256 key, never zero', () => {
  // The `mod (n - 1) + 1` reduction exists to guarantee this without a retry
  // loop. Walk enough distinct PRF outputs that a reduction off by one at
  // either end would show up as node refusing the key.
  for (let i = 0; i < 64; i++) {
    const prf = Uint8Array.from(PRF_A);
    prf[0] = i;
    prf[31] = 255 - i;
    const key = deriveDeviceKey(prf);
    assert.notDeepEqual(key, new Uint8Array(32));
    assert.doesNotThrow(() => publicKeyFrom(devicePublicKeySpki(key)));
  }
});

test('the public key is P-256 SPKI DER that node parses and re-encodes identically', () => {
  const spki = devicePublicKeySpki(deriveDeviceKey(PRF_A));
  const key = publicKeyFrom(spki);

  assert.equal(key.asymmetricKeyType, 'ec');
  assert.equal(key.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  // Node re-encoding to the same bytes is what pins the hand-written 26-byte
  // prefix: it is node's DER encoder agreeing with the literal, not a comment.
  assert.equal(key.export({ type: 'spki', format: 'der' }).toString('base64'), spki);
  // 26-byte header + the 65-byte uncompressed point. Spelled out rather than
  // compared to a constant built from the same prefix, which could not fail:
  // a compressed point would land here as 59.
  assert.equal(Buffer.from(spki, 'base64').length, 91);
});

test('node verifies a signature the device key produced', () => {
  const privateKey = deriveDeviceKey(PRF_A);
  const signature = signPrivyAuthorization(privateKey, PAYLOAD);
  const publicKey = publicKeyFrom(devicePublicKeySpki(privateKey));

  assert.equal(
    ecdsaVerify(
      'sha256',
      Buffer.from(canonicalize(PAYLOAD), 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64'),
    ),
    true,
  );
});

test('a signature does not verify against a different request', () => {
  const privateKey = deriveDeviceKey(PRF_A);
  const signature = signPrivyAuthorization(privateKey, PAYLOAD);
  const publicKey = publicKeyFrom(devicePublicKeySpki(privateKey));

  // The point of signing the request rather than a nonce: the same signature on
  // another URL is worthless, so it cannot be replayed onto another resource.
  const elsewhere = { ...PAYLOAD, url: 'https://api.privy.io/v1/policies/otherpolicy' };
  assert.equal(
    ecdsaVerify(
      'sha256',
      Buffer.from(canonicalize(elsewhere), 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64'),
    ),
    false,
  );
});

test('a signature does not verify under another device key', () => {
  const signature = signPrivyAuthorization(deriveDeviceKey(PRF_A), PAYLOAD);
  const otherKey = publicKeyFrom(devicePublicKeySpki(deriveDeviceKey(PRF_B)));

  assert.equal(
    ecdsaVerify(
      'sha256',
      Buffer.from(canonicalize(PAYLOAD), 'utf8'),
      otherKey,
      Buffer.from(signature, 'base64'),
    ),
    false,
  );
});

test('signing with a zeroed key throws rather than producing garbage', () => {
  // The session's `signPrivyAuthorization` guard turns this into a readable
  // "session ended"; the underlying refusal is what makes that guard safe
  // rather than merely tidy.
  const key = deriveDeviceKey(PRF_A);
  zeroize(key);
  assert.throws(() => signPrivyAuthorization(key, PAYLOAD));
});

/**
 * Fixtures that exercise every branch of the canonicalizer and every shape a
 * Privy payload reaches it with.
 */
const CANONICAL_FIXTURES: unknown[] = [
  PAYLOAD,
  null,
  true,
  false,
  0,
  -1,
  Number.MAX_SAFE_INTEGER,
  'plain',
  'quotes " backslash \\ newline \n tab \t',
  'unicode: é ü 中文 🙂',
  [],
  {},
  [1, 'two', null, { three: 3 }],
  // Key order: RFC 8785 sorts by UTF-16 code unit, so the output must not
  // depend on insertion order, and uppercase must sort before lowercase.
  { b: 1, a: 2, A: 3, '': 4, 'privy-app-id': 5, 'privy-idempotency-key': 6 },
  { outer: { inner: { deep: [1, { deeper: true }] } } },
  // `undefined` members are dropped from objects and become `null` in arrays,
  // exactly as `JSON.stringify` treats them.
  { kept: 1, dropped: undefined },
  [undefined, 1],
  { version: 1, method: 'POST', url: 'https://api.privy.io/v1/wallets', body: {}, headers: {} },
];

test('canonicalize agrees with @sente/mandate on every fixture', () => {
  for (const fixture of CANONICAL_FIXTURES) {
    assert.equal(
      canonicalize(fixture),
      mandateCanonicalize(fixture),
      `canonicalization drifted on ${JSON.stringify(fixture)}`,
    );
  }
});

test('canonicalize refuses what @sente/mandate refuses', () => {
  for (const rejected of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, 1n, () => 1]) {
    assert.throws(() => canonicalize(rejected));
    assert.throws(() => mandateCanonicalize(rejected));
  }
});

test('the canonical payload is the sorted, minimal JSON Privy expects', () => {
  // Spelled out once rather than only compared to the other implementation: two
  // copies of the same mistake would agree with each other.
  assert.equal(
    canonicalize(PAYLOAD),
    '{"body":{"rules":[{"action":"ALLOW","method":"eth_sendTransaction","name":"cap"}],' +
      '"version":"1.0"},"headers":{"privy-app-id":"test-app-id"},"method":"PATCH",' +
      '"url":"https://api.privy.io/v1/policies/xyzpolicy123","version":1}',
  );
});
