/**
 * The one-prompt sign-in (SEN-176): our mera patch (`eval.second`) and the
 * ceremonies built on it, against a fake WebAuthn client.
 *
 * The fake models what matters about PRF: each output is a function of the
 * credential and its own salt only — HMAC-SHA256(credential secret, salt) — so
 * asking for a salt in `first` or in `second` yields the same bytes, exactly as
 * WebAuthn specifies. That the *real* stack behaves this way is proven against
 * Chrome's authenticator by `scripts/prf-equivalence.ts`, not here.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
  type WebAuthnClient,
} from '@category-labs/mera';
import { base64urlnopad } from '@scure/base';

import { assertKeyMaterial, createKeyMaterial } from './ceremony.ts';
import { RP_ID } from './constants.ts';
import { deriveEvmKey, prfSaltFor } from './derive.ts';

const WALLET = prfSaltFor('wallet');
const DEVICE = prfSaltFor('device');

type Behaviour = {
  /** Evaluate `second` when asked. */
  second: boolean;
  /** Evaluate PRF during creation (else only `prfEnabled`). */
  prfAtCreate: boolean;
  /** Evaluate `second` during creation, when it evaluates at all. */
  secondAtCreate: boolean;
  /** Credential an assertion answers with; defaults to the one asked for. */
  answerWith?: Uint8Array;
};

const CRED_A = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const CRED_B = Uint8Array.from({ length: 16 }, (_, i) => 100 + i);

function prf(credentialId: Uint8Array, salt: Uint8Array): Uint8Array {
  const secret = Buffer.concat([Buffer.from('fake-authenticator:'), credentialId]);
  return new Uint8Array(createHmac('sha256', secret).update(salt).digest());
}

function fakeClient(behaviour: Partial<Behaviour> = {}) {
  const b: Behaviour = { second: true, prfAtCreate: true, secondAtCreate: true, ...behaviour };
  const calls: { kind: 'create' | 'get'; request: Record<string, unknown> }[] = [];
  const client: WebAuthnClient = {
    async createCredential(request) {
      calls.push({ kind: 'create', request: { ...request } });
      const id = CRED_A;
      return {
        credentialId: id,
        transports: ['internal', 'hybrid'],
        prfEnabled: true,
        ...(b.prfAtCreate ? { prfOutput: prf(id, request.prfSalt) } : {}),
        ...(b.prfAtCreate && b.secondAtCreate && b.second && request.prfSecondSalt
          ? { prfSecondOutput: prf(id, request.prfSecondSalt) }
          : {}),
      };
    },
    async getCredential(request) {
      calls.push({ kind: 'get', request: { ...request } });
      const id = b.answerWith ?? request.allowCredential?.credentialId ?? CRED_A;
      return {
        credentialId: id,
        prfOutput: prf(id, request.prfSalt),
        ...(b.second && request.prfSecondSalt
          ? { prfSecondOutput: prf(id, request.prfSecondSalt) }
          : {}),
      };
    },
  };
  return { client, calls };
}

const A = base64urlnopad.encode(CRED_A);
const EXPECTED_KEY = deriveEvmKey(prf(CRED_A, WALLET), 0);
const EXPECTED_DEVICE = prf(CRED_A, DEVICE);

// ---------------------------------------------------------------- mera patch

test('patched mera: a second salt is passed through and its output returned', async () => {
  const { client, calls } = fakeClient();
  const result = await getPasskeyPrfOutput({
    rpId: RP_ID,
    prfSalt: WALLET,
    prfSecondSalt: DEVICE,
    webAuthnClient: client,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.request.prfSecondSalt, DEVICE);
  assert.deepEqual(result.prfOutput, prf(CRED_A, WALLET));
  assert.deepEqual(result.prfSecondOutput, prf(CRED_A, DEVICE));
});

test('patched mera: without a second salt nothing changes (existing callers)', async () => {
  const { client, calls } = fakeClient();
  const result = await getPasskeyPrfOutput({
    rpId: RP_ID,
    prfSalt: WALLET,
    webAuthnClient: client,
  });
  assert.equal('prfSecondSalt' in (calls[0]?.request ?? {}), false);
  assert.equal(result.prfSecondOutput, undefined);
  assert.deepEqual(Object.keys(result).sort(), ['credentialId', 'prfOutput']);
});

test('patched mera: an absent second output is not an error', async () => {
  const { client } = fakeClient({ second: false });
  const result = await getPasskeyPrfOutput({
    rpId: RP_ID,
    prfSalt: WALLET,
    prfSecondSalt: DEVICE,
    webAuthnClient: client,
  });
  assert.deepEqual(result.prfOutput, prf(CRED_A, WALLET));
  assert.equal(result.prfSecondOutput, undefined);
});

test('patched mera: a second salt that is not 32 bytes is refused before any ceremony', async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(
    getPasskeyPrfOutput({
      rpId: RP_ID,
      prfSalt: WALLET,
      prfSecondSalt: new Uint8Array(31),
      webAuthnClient: client,
    }),
    (error: unknown) => isMeraError(error) && error.code === 'INPUT_INVALID',
  );
  assert.equal(calls.length, 0);
});

test('patched mera: a second output that is not 32 bytes is PRF_UNAVAILABLE', async () => {
  const client: WebAuthnClient = {
    createCredential: () => Promise.reject(new Error('unused')),
    getCredential: async () => ({
      credentialId: CRED_A,
      prfOutput: new Uint8Array(32),
      prfSecondOutput: new Uint8Array(16),
    }),
  };
  await assert.rejects(
    getPasskeyPrfOutput({
      rpId: RP_ID,
      prfSalt: WALLET,
      prfSecondSalt: DEVICE,
      webAuthnClient: client,
    }),
    (error: unknown) => isMeraError(error) && error.code === 'PRF_UNAVAILABLE',
  );
});

test('patched mera: creation evaluates both salts, and its fallback asks for both', async () => {
  const both = fakeClient();
  const created = await createPasskeyWithPrfOutput({
    rp: { id: RP_ID, name: 'Sente' },
    user: { name: 'u', displayName: 'u' },
    prfSalt: WALLET,
    prfSecondSalt: DEVICE,
    webAuthnClient: both.client,
  });
  assert.equal(both.calls.length, 1);
  assert.deepEqual(created.prfSecondOutput, prf(CRED_A, DEVICE));

  const late = fakeClient({ prfAtCreate: false });
  const fallback = await createPasskeyWithPrfOutput({
    rp: { id: RP_ID, name: 'Sente' },
    user: { name: 'u', displayName: 'u' },
    prfSalt: WALLET,
    prfSecondSalt: DEVICE,
    webAuthnClient: late.client,
  });
  assert.deepEqual(
    late.calls.map((c) => c.kind),
    ['create', 'get'],
  );
  assert.deepEqual(late.calls[1]?.request.prfSecondSalt, DEVICE);
  assert.deepEqual(fallback.prfOutput, prf(CRED_A, WALLET));
  assert.deepEqual(fallback.prfSecondOutput, prf(CRED_A, DEVICE));
});

/** A `PublicKeyCredential`-shaped answer for the browser client. */
function browserCredential(ext: unknown) {
  return {
    type: 'public-key',
    rawId: CRED_A.buffer.slice(0),
    response: { getTransports: () => ['internal'] },
    getClientExtensionResults: () => ext,
  };
}

test('patched mera browser client: sends eval.first and eval.second, reads results.second', async (t) => {
  const seen: { publicKey: { extensions: { prf: { eval: Record<string, Uint8Array> } } } }[] = [];
  const credentials = {
    get: async (options: (typeof seen)[number]) => {
      seen.push(options);
      const { first, second } = options.publicKey.extensions.prf.eval;
      return browserCredential({
        prf: {
          results: {
            first: prf(CRED_A, first as Uint8Array).buffer,
            ...(second ? { second: prf(CRED_A, second).buffer } : {}),
          },
        },
      });
    },
  };
  const navigator = globalThis.navigator as unknown as Record<string, unknown>;
  Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true });
  t.after(() => {
    delete navigator.credentials;
  });

  const both = await getPasskeyPrfOutput({ rpId: RP_ID, prfSalt: WALLET, prfSecondSalt: DEVICE });
  assert.deepEqual(Object.keys(seen[0]?.publicKey.extensions.prf.eval ?? {}), ['first', 'second']);
  assert.deepEqual(both.prfOutput, prf(CRED_A, WALLET));
  assert.deepEqual(both.prfSecondOutput, prf(CRED_A, DEVICE));

  const one = await getPasskeyPrfOutput({ rpId: RP_ID, prfSalt: WALLET });
  assert.deepEqual(Object.keys(seen[1]?.publicKey.extensions.prf.eval ?? {}), ['first']);
  assert.equal(one.prfSecondOutput, undefined);
});

test('patched mera React Native client: passes eval.second and decodes results.second', async () => {
  // The internal module is not in mera's exports map (it exists so tests can
  // stub react-native-passkey), so it is loaded by file path.
  const require = createRequire(import.meta.url);
  const internal = join(
    dirname(require.resolve('@category-labs/mera')),
    'react-native-webauthn-client-internal.js',
  );
  const { createReactNativeWebAuthnClient } = (await import(pathToFileURL(internal).href)) as {
    createReactNativeWebAuthnClient: (api: unknown) => WebAuthnClient;
  };
  const requests: { extensions: { prf: { eval: Record<string, Uint8Array> } } }[] = [];
  const client = createReactNativeWebAuthnClient({
    getPlatformKey: async (request: (typeof requests)[number]) => {
      requests.push(request);
      const { first, second } = request.extensions.prf.eval;
      return {
        id: base64urlnopad.encode(CRED_A),
        rawId: base64urlnopad.encode(CRED_A),
        // Credential Manager answers in base64url strings.
        clientExtensionResults: {
          prf: {
            results: {
              first: base64urlnopad.encode(prf(CRED_A, first as Uint8Array)),
              ...(second ? { second: base64urlnopad.encode(prf(CRED_A, second)) } : {}),
            },
          },
        },
      };
    },
  });
  const both = await getPasskeyPrfOutput({
    rpId: RP_ID,
    prfSalt: WALLET,
    prfSecondSalt: DEVICE,
    webAuthnClient: client,
  });
  assert.deepEqual(Object.keys(requests[0]?.extensions.prf.eval ?? {}), ['first', 'second']);
  assert.deepEqual(both.prfSecondOutput, prf(CRED_A, DEVICE));

  const one = await getPasskeyPrfOutput({ rpId: RP_ID, prfSalt: WALLET, webAuthnClient: client });
  assert.deepEqual(Object.keys(requests[1]?.extensions.prf.eval ?? {}), ['first']);
  assert.equal(one.prfSecondOutput, undefined);
});

// ---------------------------------------------------------------- ceremonies

test('sign-in: one ceremony when the provider evaluates both salts', async () => {
  const { client, calls } = fakeClient();
  const material = await assertKeyMaterial({ accountIndex: 0, webAuthnClient: client });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.request.prfSalt, WALLET);
  assert.deepEqual(calls[0]?.request.prfSecondSalt, DEVICE);
  assert.equal(calls[0]?.request.rpId, 'sente.lol');
  assert.deepEqual(material.privateKey, EXPECTED_KEY);
  assert.deepEqual(material.devicePrfOutput, EXPECTED_DEVICE);
  assert.equal(material.credential.credentialId, A);
});

test('sign-in: falls back to a pinned device assertion when the second output is missing', async () => {
  const { client, calls } = fakeClient({ second: false });
  const material = await assertKeyMaterial({ accountIndex: 0, webAuthnClient: client });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.request.prfSalt, DEVICE);
  assert.equal(calls[1]?.request.prfSecondSalt, undefined);
  const pinned = calls[1]?.request.allowCredential as { credentialId: Uint8Array } | undefined;
  assert.deepEqual(pinned?.credentialId, CRED_A);
  // Same bytes as the one-ceremony path: that is the whole point.
  assert.deepEqual(material.privateKey, EXPECTED_KEY);
  assert.deepEqual(material.devicePrfOutput, EXPECTED_DEVICE);
});

test('sign-in: the fallback refuses a device output from a different passkey', async () => {
  const { client } = fakeClient({ second: false });
  let first = true;
  const switching: WebAuthnClient = {
    createCredential: client.createCredential,
    getCredential: async (request) => {
      const answer = await client.getCredential(request);
      if (first) {
        first = false;
        return answer;
      }
      return { ...answer, credentialId: CRED_B };
    },
  };
  await assert.rejects(
    assertKeyMaterial({ accountIndex: 0, webAuthnClient: switching }),
    /different passkey/,
  );
});

test('sign-in: keeps the stored transports only for the credential it asked for', async () => {
  const { client } = fakeClient();
  const material = await assertKeyMaterial({
    credential: { credentialId: A, transports: ['internal'] },
    accountIndex: 0,
    webAuthnClient: client,
  });
  assert.deepEqual(material.credential.transports, ['internal']);

  const other = fakeClient({ answerWith: CRED_B });
  const switched = await assertKeyMaterial({
    credential: { credentialId: A, transports: ['internal'] },
    accountIndex: 0,
    webAuthnClient: other.client,
  });
  assert.equal(switched.credential.credentialId, base64urlnopad.encode(CRED_B));
  assert.equal(switched.credential.transports, undefined);
});

test('create: one ceremony when creation evaluates both salts', async () => {
  const { client, calls } = fakeClient();
  const material = await createKeyMaterial({
    rp: { id: RP_ID, name: 'Sente' },
    user: { name: 'u', displayName: 'u' },
    accountIndex: 0,
    webAuthnClient: client,
  });
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['create'],
  );
  assert.deepEqual(material.privateKey, EXPECTED_KEY);
  assert.deepEqual(material.devicePrfOutput, EXPECTED_DEVICE);
  assert.deepEqual(material.credential.transports, ['internal', 'hybrid']);
});

test('create: two ceremonies when creation evaluates only the first salt', async () => {
  const { client, calls } = fakeClient({ secondAtCreate: false });
  const material = await createKeyMaterial({
    rp: { id: RP_ID, name: 'Sente' },
    user: { name: 'u', displayName: 'u' },
    accountIndex: 0,
    webAuthnClient: client,
  });
  assert.deepEqual(
    calls.map((c) => [c.kind, Buffer.from(c.request.prfSalt as Uint8Array).equals(DEVICE)]),
    [
      ['create', false],
      ['get', true],
    ],
  );
  assert.deepEqual(material.devicePrfOutput, EXPECTED_DEVICE);
});

test('create: two ceremonies when PRF is only evaluated at assertion time', async () => {
  const { client, calls } = fakeClient({ prfAtCreate: false });
  const material = await createKeyMaterial({
    rp: { id: RP_ID, name: 'Sente' },
    user: { name: 'u', displayName: 'u' },
    accountIndex: 0,
    webAuthnClient: client,
  });
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['create', 'get'],
  );
  assert.deepEqual(material.privateKey, EXPECTED_KEY);
  assert.deepEqual(material.devicePrfOutput, EXPECTED_DEVICE);
});

test('create: three ceremonies, as before SEN-176, when nothing evaluates a second salt', async () => {
  const { client, calls } = fakeClient({ prfAtCreate: false, second: false });
  const material = await createKeyMaterial({
    rp: { id: RP_ID, name: 'Sente' },
    user: { name: 'u', displayName: 'u' },
    accountIndex: 0,
    webAuthnClient: client,
  });
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['create', 'get', 'get'],
  );
  assert.deepEqual(material.devicePrfOutput, EXPECTED_DEVICE);
});
