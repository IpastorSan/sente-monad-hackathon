/**
 * The sealed session that lets a web tab survive a reload (SEN-176), under
 * node's WebCrypto with an in-memory stand-in for sessionStorage and IndexedDB.
 * The browser wiring itself (`sessionSeal.web.ts`) is exercised by the
 * end-to-end run recorded in `docs/web.md`.
 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';

import * as native from './sessionSeal.ts';
import {
  createSessionSeal,
  SEAL_TTL_MS,
  type KeyStore,
  type SealedSession,
  type SealStorage,
} from './sessionSealCore.ts';

const subtle = webcrypto.subtle as SubtleCrypto;

function memoryStorage(): SealStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function memoryKeys(): KeyStore & { map: Map<string, CryptoKey> } {
  const map = new Map<string, CryptoKey>();
  return {
    map,
    put: async (id, key) => void map.set(id, key),
    get: async (id) => map.get(id),
    delete: async (id) => void map.delete(id),
  };
}

function harness(start = 1_000_000) {
  const storage = memoryStorage();
  const keys = memoryKeys();
  const clock = { now: start };
  const seal = createSessionSeal({
    storage,
    keys,
    subtle,
    randomBytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)),
    now: () => clock.now,
  });
  return { storage, keys, clock, seal };
}

const ADDRESS = '0xa762FA7ba694ACb76Bd3Fb77A7964F7c845226e0';

function session(): SealedSession {
  return {
    credential: { credentialId: 'AQIDBAUGBwgJCgsMDQ4PEA', transports: ['internal'] },
    accountIndex: 0,
    address: ADDRESS,
    privateKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    devicePrfOutput: Uint8Array.from({ length: 32 }, (_, i) => 200 - i),
  };
}

const SESSION_KEY = 'sente.session.seal.v1';
const TOKEN_KEY = 'sente.session.token.v1';

function record(storage: SealStorage, name = SESSION_KEY): Record<string, unknown> {
  return JSON.parse(storage.getItem(name) ?? 'null') as Record<string, unknown>;
}

test('round trip: what was sealed comes back, and nothing in storage is plaintext', async () => {
  const { storage, seal } = harness();
  const input = session();
  await seal.seal(input);

  const raw = storage.getItem(SESSION_KEY) ?? '';
  for (const secret of [input.privateKey, input.devicePrfOutput]) {
    assert.equal(raw.includes(Buffer.from(secret).toString('base64')), false);
    assert.equal(raw.includes(Buffer.from(secret).toString('hex')), false);
  }

  const out = await seal.unseal();
  assert.ok(out);
  assert.deepEqual(out.privateKey, input.privateKey);
  assert.deepEqual(out.devicePrfOutput, input.devicePrfOutput);
  assert.deepEqual(out.credential, input.credential);
  assert.equal(out.accountIndex, 0);
  assert.equal(out.address, ADDRESS);
});

test('the wrapping key is non-extractable', async () => {
  const { keys, seal } = harness();
  await seal.seal(session());
  const [key] = [...keys.map.values()];
  assert.ok(key);
  assert.equal(key.extractable, false);
  await assert.rejects(subtle.exportKey('raw', key));
});

test('expiry: a seal older than 8 h reads as absent and is cleared', async () => {
  const { storage, keys, clock, seal } = harness();
  await seal.seal(session());
  clock.now += SEAL_TTL_MS - 1;
  assert.ok(await seal.unseal());
  clock.now += 1;
  assert.equal(await seal.unseal(), null);
  assert.equal(storage.getItem(SESSION_KEY), null);
  assert.equal(keys.map.size, 0);
});

test('tamper: an edited ciphertext, IV or header fails cleanly and clears', async () => {
  const edits: [string, (r: Record<string, unknown>) => void][] = [
    [
      'ciphertext',
      (r) => {
        const ct = Buffer.from(r.ct as string, 'base64');
        ct[0] = (ct[0] ?? 0) ^ 1;
        r.ct = ct.toString('base64');
      },
    ],
    [
      'iv',
      (r) => {
        const iv = Buffer.from(r.iv as string, 'base64');
        iv[0] = (iv[0] ?? 0) ^ 1;
        r.iv = iv.toString('base64');
      },
    ],
    ['address', (r) => void (r.address = '0x0000000000000000000000000000000000000001')],
    ['account index', (r) => void (r.accountIndex = 1)],
    ['credential', (r) => void (r.credentialId = 'AAAA')],
    ['expiry pushed out', (r) => void (r.expiresAt = (r.expiresAt as number) + SEAL_TTL_MS)],
    ['wrong shape', (r) => void (r.v = 2)],
  ];
  for (const [what, edit] of edits) {
    const { storage, keys, seal } = harness();
    await seal.seal(session());
    const r = record(storage);
    edit(r);
    storage.setItem(SESSION_KEY, JSON.stringify(r));
    assert.equal(await seal.unseal(), null, what);
    assert.equal(storage.getItem(SESSION_KEY), null, what);
    assert.equal(keys.map.size, 0, what);
  }
});

test('garbage in sessionStorage and a missing key both read as absent', async () => {
  const garbage = harness();
  garbage.storage.setItem(SESSION_KEY, '{not json');
  assert.equal(await garbage.seal.unseal(), null);

  const keyless = harness();
  await keyless.seal.seal(session());
  keyless.keys.map.clear();
  assert.equal(await keyless.seal.unseal(), null);
  assert.equal(keyless.storage.getItem(SESSION_KEY), null);
});

test('a ciphertext from another tab (another key) does not decrypt', async () => {
  const a = harness();
  const b = harness();
  await a.seal.seal(session());
  await b.seal.seal(session());
  // Tab B's ciphertext, tab A's key id: as if storage were copied between tabs.
  const stolen = record(b.storage);
  stolen.keyId = record(a.storage).keyId;
  a.storage.setItem(SESSION_KEY, JSON.stringify(stolen));
  assert.equal(await a.seal.unseal(), null);
});

test('sign-out: clear removes both records and destroys the key', async () => {
  const { storage, keys, seal } = harness();
  await seal.seal(session());
  await seal.sealToken(ADDRESS, 'tok', new Date(2_000_000).toISOString());
  assert.ok(storage.getItem(TOKEN_KEY));
  await seal.clear();
  assert.equal(storage.map.size, 0);
  assert.equal(keys.map.size, 0);
  assert.equal(await seal.unseal(), null);
  assert.equal(await seal.unsealToken(ADDRESS), null);
});

test('a new seal replaces the old one and destroys its key', async () => {
  const { keys, seal } = harness();
  await seal.seal(session());
  const [first] = [...keys.map.keys()];
  await seal.seal(session());
  assert.equal(keys.map.size, 1);
  assert.notEqual([...keys.map.keys()][0], first);
});

test('token: sealed under the session key, for its address only, until it expires', async () => {
  const { storage, clock, seal } = harness();
  // No session: nothing to seal under.
  await seal.sealToken(ADDRESS, 'tok', clock.now + 60_000);
  assert.equal(storage.getItem(TOKEN_KEY), null);

  await seal.seal(session());
  await seal.sealToken(ADDRESS, 'bearer-token-value', new Date(clock.now + 60_000).toISOString());
  assert.equal((storage.getItem(TOKEN_KEY) ?? '').includes('bearer-token-value'), false);
  assert.equal(await seal.unsealToken(ADDRESS.toLowerCase()), 'bearer-token-value');
  assert.equal(await seal.unsealToken('0x0000000000000000000000000000000000000001'), null);
  // Refused once for the wrong address, it is gone.
  assert.equal(await seal.unsealToken(ADDRESS), null);

  await seal.sealToken(ADDRESS, 'again', clock.now + 60_000);
  clock.now += 60_000;
  assert.equal(await seal.unsealToken(ADDRESS), null);
});

test('token: never outlives the session seal, and a token for another address is not sealed', async () => {
  const { storage, seal } = harness();
  await seal.seal(session());
  const sessionExpiry = record(storage).expiresAt as number;
  await seal.sealToken(ADDRESS, 'tok', sessionExpiry + 10 * SEAL_TTL_MS);
  assert.equal(record(storage, TOKEN_KEY).expiresAt, sessionExpiry);

  await seal.clear();
  await seal.seal(session());
  await seal.sealToken('0x0000000000000000000000000000000000000001', 'tok', sessionExpiry);
  assert.equal(storage.getItem(TOKEN_KEY), null);
});

test('native twin: every call is a no-op', async () => {
  await native.sealSession(session());
  assert.equal(await native.unsealSession(), null);
  await native.sealApiToken(ADDRESS, 'tok', '2030-01-01T00:00:00Z');
  assert.equal(await native.unsealApiToken(ADDRESS), null);
  await native.clearSealedSession();
});
