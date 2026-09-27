/**
 * Enrollment against a fake Perpl that checks both signatures the way the real
 * one must: the wallet signature by `ecrecover` over the EIP-712 typed data, and
 * the Ed25519 proof-of-possession over the EIP-712 digest.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hashTypedData, hexToBytes, recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  PerplEnrollmentError,
  SCOPE,
  enrollApiKey,
  requestEnrollPayload,
  submitEnrollment,
  toViemTypedData,
} from './enroll.ts';
import { newSecretKey, publicKeyOf } from './signing.ts';
import type { PerplTypedData } from './wire.ts';

const wallet = privateKeyToAccount(`0x${'42'.repeat(32)}`);

/** Shaped exactly like a live testnet payload response (2026-09-10). */
function payloadFor(address: string, publicKey: string): PerplTypedData {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
      PerplRegisterApiKey: [
        { name: 'signer', type: 'address' },
        { name: 'statement', type: 'string' },
        { name: 'publicKey', type: 'string' },
        { name: 'scope', type: 'string' },
        { name: 'label', type: 'string' },
        { name: 'time', type: 'uint64' },
      ],
    },
    primaryType: 'PerplRegisterApiKey',
    domain: {
      name: 'perpl.xyz',
      version: '1',
      chainId: '0x279f',
      verifyingContract: '0x0000000000000000000000000000000000000000',
      salt: '0x00000000000000000000000000000000000000006aa2f731368ca5c38d4d3fb0',
    },
    message: {
      signer: address,
      statement:
        'I authorize the creation of Perpl API key with the specified scope and parameters',
      publicKey,
      scope: '3',
      label: 'test',
      time: '0x1a08c959a61',
    },
  };
}

test('toViemTypedData: hex chainId and uint fields become numbers/bigints', () => {
  const v = toViemTypedData(payloadFor(wallet.address, 'k'));
  assert.equal(v.domain.chainId, 10143);
  assert.equal(v.message['time'], 0x1a08c959a61n);
  assert.equal(v.message['scope'], '3'); // a string field stays a string
  assert.equal('EIP712Domain' in v.types, false);
});

function fakePerpl(enrollStatus = 200) {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  let typedData: PerplTypedData | undefined;
  let publicKeyHex = '';
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    if (url.endsWith('/payload')) {
      publicKeyHex = String(body['public_key']);
      typedData = payloadFor(String(body['address']), 'b64-of-key');
      return new Response(JSON.stringify({ typed_data: typedData, mac: '0xmac' }));
    }
    if (enrollStatus !== 200) return new Response('Bad Request', { status: enrollStatus });
    const v = toViemTypedData(typedData!);
    const signer = await recoverTypedDataAddress({
      ...(v as Parameters<typeof hashTypedData>[0]),
      signature: body['signature'] as Hex,
    });
    assert.equal(signer, wallet.address, 'wallet signature must ecrecover to the signer');
    const digest = hashTypedData(v as Parameters<typeof hashTypedData>[0]);
    assert.ok(
      ed.verify(
        hexToBytes(body['pop_signature'] as Hex),
        hexToBytes(digest),
        hexToBytes(publicKeyHex as Hex),
      ),
      'proof-of-possession must verify over the EIP-712 digest',
    );
    assert.equal(body['mac'], '0xmac');
    return new Response(
      JSON.stringify({
        api_key: { api_key: 'token-1', address: signer, scope_mask: 3, label: 'test', origin: '' },
      }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test('enrolls: both signatures verify, no Origin header is ever sent', async () => {
  const { fetchImpl, calls } = fakePerpl();
  const enrolled = await enrollApiKey({
    restUrl: 'https://testnet.perpl.xyz/api/',
    chainId: 10143,
    signer: wallet,
    label: 'test',
    fetchImpl,
  });
  assert.equal(enrolled.credentials.apiKey, 'token-1');
  assert.equal(enrolled.credentials.secretKey.length, 32);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      'https://testnet.perpl.xyz/api/v1/api-key/payload',
      'https://testnet.perpl.xyz/api/v1/api-key/enroll',
    ],
  );
  for (const call of calls) assert.equal(call.headers.get('origin'), null);
  assert.match(String(calls[0]!.body['public_key']), /^0x[0-9a-f]{64}$/);
});

test('a 400 on enroll explains the ERC-1271 trap', async () => {
  const { fetchImpl } = fakePerpl(400);
  await assert.rejects(
    enrollApiKey({
      restUrl: 'https://x/api',
      chainId: 10143,
      signer: wallet,
      label: 't',
      fetchImpl,
    }),
    (error: unknown) =>
      error instanceof PerplEnrollmentError &&
      error.status === 400 &&
      /ERC-1271/.test(error.message),
  );
});

// SEN-91: the two halves on their own, as a caller whose wallet signs elsewhere uses them.

function hexKey(secretKey: Uint8Array): Hex {
  return `0x${bytesToHex(publicKeyOf(secretKey))}`;
}

test('requestEnrollPayload: posts the request, returns the payload verbatim plus what to sign', async () => {
  const { fetchImpl, calls } = fakePerpl();
  const publicKeyHex = hexKey(newSecretKey());
  const payload = await requestEnrollPayload({
    restUrl: 'https://testnet.perpl.xyz/api/',
    chainId: 10143,
    address: wallet.address,
    publicKeyHex,
    scope: SCOPE.read,
    label: 'agent-1',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://testnet.perpl.xyz/api/v1/api-key/payload');
  assert.equal(calls[0]!.headers.get('origin'), null);
  assert.deepEqual(calls[0]!.body, {
    chain_id: 10143,
    address: wallet.address,
    public_key: publicKeyHex,
    scope_mask: 1,
    label: 'agent-1',
  });
  assert.equal(payload.mac, '0xmac');
  assert.deepEqual(payload.typed_data, payloadFor(wallet.address, 'b64-of-key'));
  assert.deepEqual(payload.typedData, toViemTypedData(payload.typed_data));
  assert.equal(
    payload.digest,
    hashTypedData(payload.typedData as Parameters<typeof hashTypedData>[0]),
  );
});

test('requestEnrollPayload: refuses a payload naming another signer', async () => {
  const other = privateKeyToAccount(`0x${'43'.repeat(32)}`);
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ typed_data: payloadFor(other.address, 'k'), mac: '0xmac' }),
    )) as typeof fetch;
  await assert.rejects(
    requestEnrollPayload({
      restUrl: 'https://x/api',
      chainId: 10143,
      address: wallet.address,
      publicKeyHex: hexKey(newSecretKey()),
      scope: SCOPE.all,
      label: 't',
      fetchImpl,
    }),
    /names signer/,
  );
});

test('requestEnrollPayload: a non-200 is a payload-step PerplEnrollmentError', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 404 })) as typeof fetch;
  await assert.rejects(
    requestEnrollPayload({
      restUrl: 'https://x/api',
      chainId: 10143,
      address: wallet.address,
      publicKeyHex: hexKey(newSecretKey()),
      scope: SCOPE.all,
      label: 't',
      fetchImpl,
    }),
    (error: unknown) =>
      error instanceof PerplEnrollmentError &&
      error.status === 404 &&
      error.message.startsWith('Perpl payload failed with 404 ('),
  );
});

test('submitEnrollment: signatures made outside the module enroll, returning the key info', async () => {
  const { fetchImpl, calls } = fakePerpl();
  const secretKey = newSecretKey();
  const { typed_data, mac, typedData, digest } = await requestEnrollPayload({
    restUrl: 'https://x/api',
    chainId: 10143,
    address: wallet.address,
    publicKeyHex: hexKey(secretKey),
    scope: SCOPE.all,
    label: 'test',
    fetchImpl,
  });
  // Stand-in for a remote signer: it sees only `typedData`, never the Perpl wire shape.
  const signature = await wallet.signTypedData(
    typedData as Parameters<typeof wallet.signTypedData>[0],
  );
  const popSignature: Hex = `0x${bytesToHex(ed.sign(hexToBytes(digest), secretKey))}`;

  const info = await submitEnrollment({
    restUrl: 'https://x/api/',
    chainId: 10143,
    address: wallet.address,
    typed_data,
    mac,
    signature,
    popSignature,
    fetchImpl,
  });

  assert.equal(info.api_key, 'token-1');
  assert.equal(calls[1]!.url, 'https://x/api/v1/api-key/enroll');
  assert.equal(calls[1]!.headers.get('origin'), null);
  assert.deepEqual(calls[1]!.body, {
    chain_id: 10143,
    address: wallet.address,
    typed_data,
    mac,
    signature,
    pop_signature: popSignature,
  });
});

test('submitEnrollment: a non-200 is an enroll-step error with its hint', async () => {
  const fetchImpl = (async () => new Response('dup', { status: 409 })) as typeof fetch;
  await assert.rejects(
    submitEnrollment({
      restUrl: 'https://x/api',
      chainId: 10143,
      address: wallet.address,
      typed_data: payloadFor(wallet.address, 'k'),
      mac: '0xmac',
      signature: '0x00',
      popSignature: '0x00',
      fetchImpl,
    }),
    (error: unknown) =>
      error instanceof PerplEnrollmentError &&
      error.status === 409 &&
      /already registered/.test(error.message),
  );
});
