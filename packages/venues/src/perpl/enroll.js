/**
 * Programmatic API-key enrollment: `POST /v1/api-key/payload` then `/enroll`.
 *
 * Two signatures over one EIP-712 payload:
 *
 *   1. the WALLET's secp256k1 signature — proves the address owns the Perpl
 *      account;
 *   2. an Ed25519 proof-of-possession by the new API key over the EIP-712
 *      digest `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))`.
 *
 * Verified end to end on testnet 2026-09-10 — the first time `/enroll` was
 * exercised in this repo. Three things that are not in the docs, or are wrong
 * there:
 *
 *   - NO `Origin` HEADER. The docs say a non-whitelisted Origin is rejected; an
 *     ABSENT one is accepted by both endpoints and recorded as `origin: ""`.
 *     Node's fetch and React Native's fetch send none, so this module never
 *     sets one.
 *
 *   - THE SIGNER MUST BE AN EOA. Perpl recovers the wallet signature with
 *     `ecrecover` only. A Kernel smart account that owns a Perpl account, signing
 *     through ERC-1271 with a signature its own `isValidSignature` accepts
 *     (`0x1626ba7e`), gets a bare 400 — the same answer as a garbage signature.
 *     So the passkey EOA, not the smart account, owns the Perpl account.
 *
 *   - 404 means "this address has no Perpl account yet", not a bad route: the
 *     signature is checked first (a bad one is 400), then the profile lookup.
 *     Run onboarding from the same address before enrolling.
 */
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hashTypedData, hexToBytes } from 'viem';
import { newSecretKey, publicKeyOf } from './signing.ts';
/** `scope_mask` bits. Trade implies read; withdrawals are never possible via a key. */
export const SCOPE = { read: 1, trade: 2, all: 3 };
/**
 * Perpl returns `chainId` and `time` as hex STRINGS. viem needs numbers/bigints
 * for integer fields and computes the domain type itself, so `EIP712Domain` is
 * dropped from `types` — keeping it would be harmless only by accident.
 */
export function toViemTypedData(typedData) {
  const types = Object.fromEntries(
    Object.entries(typedData.types).filter(([name]) => name !== 'EIP712Domain'),
  );
  const fields = typedData.types[typedData.primaryType] ?? [];
  const message = {};
  for (const [name, value] of Object.entries(typedData.message)) {
    const type = fields.find((field) => field.name === name)?.type ?? 'string';
    message[name] = /^u?int\d*$/.test(type) ? BigInt(value) : value;
  }
  return {
    domain: {
      name: typedData.domain.name,
      version: typedData.domain.version,
      chainId: Number(BigInt(typedData.domain.chainId)),
      verifyingContract: typedData.domain.verifyingContract,
      salt: typedData.domain.salt,
    },
    types,
    primaryType: typedData.primaryType,
    message,
  };
}
const ENROLL_HINTS = {
  400:
    'Perpl rejected the wallet signature. It verifies with ecrecover only — an ERC-1271 ' +
    'smart-account signature fails here exactly like a malformed one.',
  404: 'This address has no Perpl account yet. Run onboarding from it first.',
  409: 'This public key is already registered (revoked keys cannot be reused).',
  423: 'The account already has the maximum of 16 active keys.',
};
export class PerplEnrollmentError extends Error {
  status;
  body;
  constructor(step, status, body) {
    const hint = step === 'enroll' ? ENROLL_HINTS[status] : undefined;
    super(`Perpl ${step} failed with ${status}${hint ? `: ${hint}` : ''} (${body.slice(0, 200)})`);
    this.name = 'PerplEnrollmentError';
    this.status = status;
    this.body = body;
  }
}
async function postJson(fetchImpl, url, body) {
  // Deliberately no Origin header — see the module comment.
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}
export async function enrollApiKey(options) {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const restUrl = options.restUrl.replace(/\/+$/, '');
  const secretKey = options.secretKey ?? newSecretKey();
  const address = options.signer.address;
  const payload = await postJson(fetchImpl, `${restUrl}/v1/api-key/payload`, {
    chain_id: options.chainId,
    address,
    public_key: `0x${bytesToHex(publicKeyOf(secretKey))}`,
    scope_mask: options.scope ?? SCOPE.all,
    label: options.label,
  });
  if (payload.status !== 200)
    throw new PerplEnrollmentError('payload', payload.status, payload.text);
  const { typed_data, mac } = JSON.parse(payload.text);
  const typedData = toViemTypedData(typed_data);
  // Sign only what we asked for: the server fills `signer` from our request.
  if (String(typedData.message['signer']).toLowerCase() !== address.toLowerCase()) {
    throw new Error(`Perpl payload names signer ${String(typedData.message['signer'])}`);
  }
  const signature = await options.signer.signTypedData(typedData);
  const digest = hashTypedData(typedData);
  const popSignature = `0x${bytesToHex(ed.sign(hexToBytes(digest), secretKey))}`;
  const enrolled = await postJson(fetchImpl, `${restUrl}/v1/api-key/enroll`, {
    chain_id: options.chainId,
    address,
    typed_data,
    mac,
    signature,
    pop_signature: popSignature,
  });
  if (enrolled.status !== 200) {
    throw new PerplEnrollmentError('enroll', enrolled.status, enrolled.text);
  }
  const info = JSON.parse(enrolled.text).api_key;
  return { credentials: { apiKey: info.api_key, secretKey }, info };
}
