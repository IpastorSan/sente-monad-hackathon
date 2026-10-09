/**
 * What a Perpl enrollment payload must look like before the server hands it to
 * the phone (SEN-100, plan M-T18, "Architecture §3", D4).
 *
 * The phone's verifier (M-T16) is the security boundary: it checks the same
 * things and its device key signs nothing that fails them. This is the
 * server's copy of the same rules, so a drifted payload is refused here with a
 * reason the app can show ("Perpl changed its sign-up format"), instead of
 * reaching the phone only to be refused there, or — if a phone verifier ever
 * regressed — signed. It FAILS CLOSED (D4, CLAUDE.md gotcha 13): any field
 * this does not expect refuses the whole enrollment.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PINNED BY PROBE P5 (SEN-82, 2026-10-09). {@link PERPL_ENROLL_FIELDS} and
 * the `publicKey` encoding are what Perpl's live `/v1/api-key/payload` served
 * for a trade- and a read-scoped key, recorded verbatim in
 * `docs/user-trading.md` §P5 and pinned in `perpl-enroll-format.spec.ts`.
 * Each is the ONE spelling Perpl used; any other is drift and refuses (D4).
 * If Perpl changes one, re-record it, change it HERE, and mirror it in the
 * phone's `verifyPerpl.ts`.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Erasable syntax only (gotcha 10), so a live probe can load it.
 */
import { PERPL_API_KEY_TYPED_DATA, SCOPE, type PerplTypedData } from '@sente/venues/perpl';
import { hexToBytes, isAddressEqual, type Address, type Hex } from 'viem';

export type EnrollRole = 'trade' | 'read';

/**
 * The values P5 recorded (see the header).
 *
 * - `scopeMask`: what we ASK for. No mask can withdraw (`enroll.ts`).
 * - `scopeField`: what the message then says. Perpl writes the EFFECTIVE
 *   scope: trade implies read, so a request for mask 2 comes back `'3'`; read
 *   alone (mask 1) comes back `'1'`.
 * - `empty`: how Perpl spells "not set" for the fields we never ask it to
 *   fill. Not uniform: the numeric ones are `'0'`, the text ones `''`. A
 *   builder id or a non-zero builder fee would let a third party skim every
 *   order placed with the key (threat model, "Builder-fee skim").
 */
export const PERPL_ENROLL_FIELDS = {
  scopeMask: { trade: SCOPE.trade, read: SCOPE.read } satisfies Record<EnrollRole, number>,
  scopeField: { trade: '3', read: '1' } satisfies Record<EnrollRole, string>,
  empty: {
    expiresAt: '0',
    ipCidrs: '',
    origin: '',
    builderId: '0',
    maxBuilderFeePer100K: '0',
  } satisfies Record<string, string>,
} as const;

/** How far Perpl's `time` may sit from our clock. Plan §3: ±5 minutes. */
export const ENROLL_TIME_SKEW_MS = 5 * 60 * 1000;

/** The domain struct Perpl serves: the standard four plus `salt`. */
const EIP712_DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface EnrollExpectation {
  readonly role: EnrollRole;
  readonly chainId: number;
  readonly signer: Address;
  /** The key being enrolled, `0x` + 64 hex. */
  readonly publicKeyHex: Hex;
  readonly label: string;
  readonly now: Date;
}

/** Undefined when the payload is exactly what we asked for; otherwise why not. */
export function enrollPayloadProblem(
  typed: PerplTypedData,
  expected: EnrollExpectation,
): string | undefined {
  const { domain, message } = typed;
  if (domain.name !== PERPL_API_KEY_TYPED_DATA.domain.name) return `domain.name ${domain.name}`;
  if (domain.version !== PERPL_API_KEY_TYPED_DATA.domain.version) {
    return `domain.version ${domain.version}`;
  }
  if (!sameUint(domain.chainId, expected.chainId)) return `domain.chainId ${domain.chainId}`;
  if (domain.verifyingContract.toLowerCase() !== ZERO_ADDRESS) {
    return `domain.verifyingContract ${domain.verifyingContract}`;
  }
  // `domain.salt` is deliberately NOT compared: it drifts day to day
  // (`docs/agents.md` Run 2) and names nothing a signature could be steered to.
  if (typed.primaryType !== PERPL_API_KEY_TYPED_DATA.primaryType) {
    return `primaryType ${typed.primaryType}`;
  }
  if (!sameTypes(typed.types)) return 'the typed-data struct changed';

  const fields = PERPL_ENROLL_FIELDS;
  if (!isAddress(message['signer']) || !isAddressEqual(message['signer'], expected.signer)) {
    return `signer ${message['signer']}`;
  }
  if (message['statement'] !== PERPL_API_KEY_TYPED_DATA.statement) return 'statement';
  if (!publicKeyMatches(message['publicKey'], expected.publicKeyHex)) {
    return `publicKey ${message['publicKey']}`;
  }
  if (message['scope'] !== fields.scopeField[expected.role]) return `scope ${message['scope']}`;
  if (message['label'] !== expected.label) return `label ${message['label']}`;
  for (const [name, empty] of Object.entries(fields.empty)) {
    if (message[name] !== empty) return `${name} ${message[name]}`;
  }
  const time = uintMs(message['time']);
  if (time === undefined || Math.abs(time - expected.now.getTime()) > ENROLL_TIME_SKEW_MS) {
    return `time ${message['time']}`;
  }
  return undefined;
}

/** `types` exactly: the 5-field domain and the 11-field struct, same order, nothing else. */
function sameTypes(types: PerplTypedData['types']): boolean {
  const expected: Record<string, readonly { name: string; type: string }[]> = {
    EIP712Domain: EIP712_DOMAIN,
    ...PERPL_API_KEY_TYPED_DATA.types,
  };
  const names = Object.keys(types);
  if (names.length !== Object.keys(expected).length) return false;
  return names.every((name) => {
    const want = expected[name];
    const got = types[name];
    return (
      want !== undefined &&
      got !== undefined &&
      got.length === want.length &&
      got.every(
        (field, i) =>
          Object.keys(field).length === 2 &&
          field.name === want[i]!.name &&
          field.type === want[i]!.type,
      )
    );
  });
}

/**
 * The message's `publicKey` against the key we enrolled. Perpl echoes the
 * `0x` hex we send as `public_key` back as the same 32 bytes in unpadded
 * base64url, 43 characters (P5); that is the only spelling accepted.
 */
export function perplPublicKeyField(publicKeyHex: Hex): string {
  return Buffer.from(hexToBytes(publicKeyHex)).toString('base64url');
}

function publicKeyMatches(field: string | undefined, publicKeyHex: Hex): boolean {
  return field !== undefined && field === perplPublicKeyField(publicKeyHex);
}

function isAddress(value: string | undefined): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Perpl writes integers as hex strings (`0x279f`); decimal is accepted too. */
function sameUint(value: string, expected: number): boolean {
  try {
    return BigInt(value) === BigInt(expected);
  } catch {
    return false;
  }
}

/** Perpl's `time` is milliseconds since the epoch (`0x1a08c959a61` is 2026-09-10). */
function uintMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  try {
    return Number(BigInt(value));
  } catch {
    return undefined;
  }
}
