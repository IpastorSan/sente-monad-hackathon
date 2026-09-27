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
import { hashTypedData, hexToBytes, type Address, type Hex } from 'viem';

import { newSecretKey, publicKeyOf, type PerplCredentials } from './signing.ts';
import type { ApiKeyInfo, ApiKeyPayloadResponse, PerplTypedData } from './wire.ts';

/** `scope_mask` bits. Trade implies read; withdrawals are never possible via a key. */
export const SCOPE = { read: 1, trade: 2, all: 3 } as const;

/** Perpl's typed data in the shape viem signs and hashes: numeric chainId, bigint uints. */
export interface PerplEip712 {
  readonly domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
    salt: Hex;
  };
  readonly types: Record<string, { name: string; type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

/**
 * Perpl returns `chainId` and `time` as hex STRINGS. viem needs numbers/bigints
 * for integer fields and computes the domain type itself, so `EIP712Domain` is
 * dropped from `types` — keeping it would be harmless only by accident.
 */
export function toViemTypedData(typedData: PerplTypedData): PerplEip712 {
  const types = Object.fromEntries(
    Object.entries(typedData.types).filter(([name]) => name !== 'EIP712Domain'),
  );
  const fields = typedData.types[typedData.primaryType] ?? [];
  const message: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(typedData.message)) {
    const type = fields.find((field) => field.name === name)?.type ?? 'string';
    message[name] = /^u?int\d*$/.test(type) ? BigInt(value) : value;
  }
  return {
    domain: {
      name: typedData.domain.name,
      version: typedData.domain.version,
      chainId: Number(BigInt(typedData.domain.chainId)),
      verifyingContract: typedData.domain.verifyingContract as Address,
      salt: typedData.domain.salt as Hex,
    },
    types,
    primaryType: typedData.primaryType,
    message,
  };
}

/** The wallet side of enrollment. A viem `LocalAccount` satisfies it. */
export interface EnrollmentSigner {
  readonly address: Address;
  signTypedData(typedData: PerplEip712): Promise<Hex>;
}

export interface EnrollOptions {
  /** e.g. `https://testnet.perpl.xyz/api`. */
  readonly restUrl: string;
  readonly chainId: number;
  /** The EOA that owns the Perpl account. NOT a smart account — see above. */
  readonly signer: EnrollmentSigner;
  readonly label: string;
  readonly scope?: number;
  /** Supply to enroll a known key; otherwise a fresh one is generated. */
  readonly secretKey?: Uint8Array;
  readonly fetchImpl?: typeof fetch;
}

export interface EnrolledKey {
  /** Persist `secretKey` somewhere safe: the token alone cannot sign. */
  readonly credentials: PerplCredentials;
  readonly info: ApiKeyInfo;
}

const ENROLL_HINTS: Readonly<Record<number, string>> = {
  400:
    'Perpl rejected the wallet signature. It verifies with ecrecover only — an ERC-1271 ' +
    'smart-account signature fails here exactly like a malformed one.',
  404: 'This address has no Perpl account yet. Run onboarding from it first.',
  409: 'This public key is already registered (revoked keys cannot be reused).',
  423: 'The account already has the maximum of 16 active keys.',
};

export class PerplEnrollmentError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(step: 'payload' | 'enroll', status: number, body: string) {
    const hint = step === 'enroll' ? ENROLL_HINTS[status] : undefined;
    super(`Perpl ${step} failed with ${status}${hint ? `: ${hint}` : ''} (${body.slice(0, 200)})`);
    this.name = 'PerplEnrollmentError';
    this.status = status;
    this.body = body;
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  // Deliberately no Origin header — see the module comment.
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function endpoint(restUrl: string, path: string): string {
  return `${restUrl.replace(/\/+$/, '')}/v1/api-key/${path}`;
}

function fetchOrGlobal(fetchImpl: typeof fetch | undefined): typeof fetch {
  return fetchImpl ?? ((input, init) => fetch(input, init));
}

export interface EnrollPayloadRequest {
  /** e.g. `https://testnet.perpl.xyz/api`. */
  readonly restUrl: string;
  readonly chainId: number;
  /** The EOA that owns the Perpl account. NOT a smart account — see above. */
  readonly address: Address;
  /** The new API key's Ed25519 public key, `0x`-prefixed hex. */
  readonly publicKeyHex: Hex;
  /** `scope_mask`, see `SCOPE`. */
  readonly scope: number;
  readonly label: string;
  readonly fetchImpl?: typeof fetch;
}

export interface EnrollPayload {
  /** Perpl's typed data verbatim: `/enroll` wants it back unchanged, alongside `mac`. */
  readonly typed_data: PerplTypedData;
  readonly mac: string;
  /**
   * What the wallet signs. Pass exactly this to the signer — its `types` are what
   * a Privy policy pins (CLAUDE.md gotcha 13).
   */
  readonly typedData: PerplEip712;
  /** The EIP-712 digest the API key's proof-of-possession signs. */
  readonly digest: Hex;
}

/**
 * Step one of enrollment: fetch the payload to sign. Split from `submitEnrollment`
 * (SEN-91) so a caller whose wallet signs somewhere else — a Privy agent wallet —
 * can carry `typedData` to that signer between the two HTTP calls.
 */
export async function requestEnrollPayload(o: EnrollPayloadRequest): Promise<EnrollPayload> {
  const payload = await postJson(fetchOrGlobal(o.fetchImpl), endpoint(o.restUrl, 'payload'), {
    chain_id: o.chainId,
    address: o.address,
    public_key: o.publicKeyHex,
    scope_mask: o.scope,
    label: o.label,
  });
  if (payload.status !== 200)
    throw new PerplEnrollmentError('payload', payload.status, payload.text);
  const { typed_data, mac } = JSON.parse(payload.text) as ApiKeyPayloadResponse;

  const typedData = toViemTypedData(typed_data);
  // Sign only what we asked for: the server fills `signer` from our request.
  // Checked here rather than at signing so no caller of the split API skips it.
  if (String(typedData.message['signer']).toLowerCase() !== o.address.toLowerCase()) {
    throw new Error(`Perpl payload names signer ${String(typedData.message['signer'])}`);
  }
  const digest = hashTypedData(typedData as Parameters<typeof hashTypedData>[0]);
  return { typed_data, mac, typedData, digest };
}

export interface EnrollSubmission {
  readonly restUrl: string;
  readonly chainId: number;
  readonly address: Address;
  /** Both straight from `requestEnrollPayload`. */
  readonly typed_data: PerplTypedData;
  readonly mac: string;
  /** The wallet's secp256k1 signature over `typedData`. */
  readonly signature: Hex;
  /** The API key's Ed25519 signature over `digest`. */
  readonly popSignature: Hex;
  readonly fetchImpl?: typeof fetch;
}

/** Step two of enrollment (SEN-91): register the key with both signatures. */
export async function submitEnrollment(o: EnrollSubmission): Promise<ApiKeyInfo> {
  const enrolled = await postJson(fetchOrGlobal(o.fetchImpl), endpoint(o.restUrl, 'enroll'), {
    chain_id: o.chainId,
    address: o.address,
    typed_data: o.typed_data,
    mac: o.mac,
    signature: o.signature,
    pop_signature: o.popSignature,
  });
  if (enrolled.status !== 200) {
    throw new PerplEnrollmentError('enroll', enrolled.status, enrolled.text);
  }
  return (JSON.parse(enrolled.text) as { api_key: ApiKeyInfo }).api_key;
}

/** Both steps, signing locally with `signer` and a fresh (or given) API key. */
export async function enrollApiKey(options: EnrollOptions): Promise<EnrolledKey> {
  const { restUrl, chainId, fetchImpl } = options;
  const secretKey = options.secretKey ?? newSecretKey();
  const address = options.signer.address;

  const { typed_data, mac, typedData, digest } = await requestEnrollPayload({
    restUrl,
    chainId,
    address,
    publicKeyHex: `0x${bytesToHex(publicKeyOf(secretKey))}`,
    scope: options.scope ?? SCOPE.all,
    label: options.label,
    fetchImpl,
  });
  const signature = await options.signer.signTypedData(typedData);
  const popSignature: Hex = `0x${bytesToHex(ed.sign(hexToBytes(digest), secretKey))}`;

  const info = await submitEnrollment({
    restUrl,
    chainId,
    address,
    typed_data,
    mac,
    signature,
    popSignature,
    fetchImpl,
  });
  return { credentials: { apiKey: info.api_key, secretKey }, info };
}
