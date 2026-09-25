/**
 * Passkey sign-in and the wallet session it produces.
 *
 * Mera is a client-side library, not a smart-account system: it runs a WebAuthn
 * ceremony with the PRF extension, and everything downstream of the 32 bytes
 * that come back is ordinary BIP-39/BIP-44/secp256k1 (see `./derive`). There is
 * no on-chain component, no server, and no P256 precompile involved — the
 * account this produces is a plain EOA that happens to have no seed phrase
 * because nobody ever needs to hold one.
 *
 * A session carries two keys, because they are two key domains: the secp256k1
 * EOA under the `wallet` salt, and the P-256 **device key** under the `device`
 * salt, which is what owns the user's Privy wallet and its agents' mandate
 * policies (SEN-38). One passkey, many keys.
 *
 * **Cost of the second key: one more WebAuthn prompt at sign-in.** mera returns
 * the *first* PRF output for *one* salt per ceremony, so a second salt needs a
 * second assertion. It is targeted at the credential the first ceremony chose,
 * and refused if the platform answers with a different one — a device key from
 * another passkey would silently own the wrong wallet. Everything after
 * sign-in is still prompt-free: `signDigest` and `signPrivyAuthorization` both
 * sign locally from the derived keys, so neither a transaction nor a Privy
 * approval re-prompts for a biometric.
 */
import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  isMeraError,
  type MeraErrorCode,
  type PasskeyCredentialMetadata,
  type PasskeyCredentialTransport,
  type Secp256k1SigningSession,
} from '@category-labs/mera';
import { reactNativeWebAuthnClient } from '@category-labs/mera/react-native-webauthn-client';
import { toViemAccount } from '@category-labs/mera/viem';
import type { Address, LocalAccount } from 'viem';

import { deriveDeviceKey, deriveEvmKey, prfSaltFor, zeroize } from './derive';
import {
  devicePublicKeySpki,
  signPrivyAuthorization as signWithDeviceKey,
  type AuthorizationPayload,
} from './deviceKey';

/**
 * The WebAuthn relying-party ID. PERMANENT — see CLAUDE.md.
 *
 * This is not configurable and must never be read from the environment. It is
 * an input to the PRF, and therefore to every user's wallet address: change it
 * and every existing account becomes unreachable rather than migrated.
 */
export const RP_ID = 'sente.lol';

/** Name the authenticator shows in its UI. Cosmetic; safe to change. */
export const RP_NAME = 'Sente';

const RELYING_PARTY = { id: RP_ID, name: RP_NAME } as const;

/**
 * WebAuthn timeout. Generous, because the ceremony includes the user picking a
 * provider and passing a biometric check, and a timeout here reads to the user
 * as "the app is broken".
 */
const PASSKEY_TIMEOUT_MS = 120_000;

/** Stored hints for re-asserting a known credential. Not secrets — see below. */
export type StoredCredential = {
  readonly credentialId: string;
  readonly transports?: readonly PasskeyCredentialTransport[];
};

/**
 * A live wallet session.
 *
 * `account` signs without prompting until `end()` is called, after which every
 * signing method rejects: mera's own with `SESSION_ENDED`, and
 * `signPrivyAuthorization` with a plain `Error`.
 */
export type WalletSession = {
  /** viem local account backed by the session key. Ready for `writeContract` etc. */
  readonly account: LocalAccount<'mera'>;
  /** EIP-55 checksummed address of `account`. */
  readonly address: Address;
  /** Credential that produced this session, for persisting as a sign-in hint. */
  readonly credential: StoredCredential;
  /** BIP-44 address index this session derived. */
  readonly accountIndex: number;
  /**
   * The device key's public half as base64 SPKI DER — the shape Privy's
   * `key_quorums.public_keys[]` takes. Safe to send to the server; it is what
   * `POST /wallet/register` names as the owner of the user's Privy wallet.
   */
  readonly devicePublicKey: string;
  /**
   * Signs a Privy authorization payload with the device key, returning the
   * base64 DER signature for one `privy-authorization-signature` element.
   *
   * Build the payload from the request being approved — see the header of
   * `./deviceKey`; signing one the server composed hands the server back the
   * authority this key exists to withhold.
   *
   * A property rather than a method, and closed over the session rather than
   * over `this`, so it can be passed around on its own and still refuse to sign
   * once the session has ended.
   *
   * @throws Error once the session has ended.
   */
  readonly signPrivyAuthorization: (payload: AuthorizationPayload) => string;
  /** Zeroes both session keys. Idempotent. */
  end(): void;
  [Symbol.dispose](): void;
};

type OpenSessionInput = {
  /** Already-derived secp256k1 key. Borrowed — `openSession` wipes it. */
  privateKey: Uint8Array;
  /** PRF output for `prfSaltFor('device')` — a different salt, a different key. */
  devicePrfOutput: Uint8Array;
  credential: StoredCredential;
  accountIndex: number;
};

/**
 * Assembles a live session from key material the caller already holds.
 *
 * Neither input is this function's to wipe. mera's signing session takes its
 * own copy of `privateKey`; the device key is derived here and kept, because
 * nothing else copies it, so the session holds those 32 bytes and wipes them in
 * `end()`. That is the whole of the device key's lifetime: derived at sign-in,
 * live for the session, gone at sign-out, never written anywhere.
 *
 * On any failure the half-built signing session is ended and the device key
 * wiped before the error propagates, so a throw never leaves key material live.
 */
function openWalletSession({
  privateKey,
  devicePrfOutput,
  credential,
  accountIndex,
}: OpenSessionInput): WalletSession {
  const deviceKey = deriveDeviceKey(devicePrfOutput);
  let signing: Secp256k1SigningSession | undefined;
  try {
    signing = createSecp256k1SigningSession({ privateKey });
    const account = toViemAccount(signing);
    const endSigning = signing.end.bind(signing);
    const devicePublicKey = devicePublicKeySpki(deviceKey);
    let live = true;
    // Idempotent on both halves: mera's `end` is, and zeroing zeroed bytes is.
    const end = (): void => {
      live = false;
      zeroize(deviceKey);
      endSigning();
    };
    return {
      account,
      address: account.address,
      credential,
      accountIndex,
      devicePublicKey,
      signPrivyAuthorization: (payload) => {
        // Without this the signature would be attempted with a zeroed key,
        // which is not a valid scalar — a confusing throw from inside noble
        // instead of the same "session ended" mera reports for the EOA.
        if (!live) throw new Error('wallet session ended — sign in again to sign');
        return signWithDeviceKey(deviceKey, payload);
      },
      end,
      [Symbol.dispose]: end,
    };
  } catch (error) {
    signing?.end();
    zeroize(deviceKey);
    throw error;
  }
}

/**
 * Everything between a completed wallet ceremony and a live session, shared by
 * both entry points.
 *
 * Takes ownership of `prfOutput` and wipes all three secrets on every path.
 * The order matters: the wallet PRF output is wiped as soon as the EOA key is
 * derived, *before* the device assertion, because that assertion is a second
 * biometric prompt that can take the full {@link PASSKEY_TIMEOUT_MS} — and of
 * everything in this file it is the one secret that derives every BIP-44 index
 * rather than a single key.
 */
async function openSession({
  prfOutput,
  credential,
  accountIndex,
}: {
  prfOutput: Uint8Array;
  credential: StoredCredential;
  accountIndex: number;
}): Promise<WalletSession> {
  let privateKey: Uint8Array | undefined;
  let devicePrfOutput: Uint8Array | undefined;
  try {
    privateKey = deriveEvmKey(prfOutput, accountIndex);
    zeroize(prfOutput);
    devicePrfOutput = await deviceKeyPrfOutput(credential);
    return openWalletSession({ privateKey, devicePrfOutput, credential, accountIndex });
  } finally {
    zeroize(prfOutput, privateKey, devicePrfOutput);
  }
}

/**
 * Runs the second assertion, the one that evaluates the `device` salt.
 *
 * Restricted to the credential the wallet ceremony used: WebAuthn would
 * otherwise be free to offer any discoverable passkey for `sente.lol`, and a
 * device key derived from a *different* passkey than the wallet would register
 * an owner the user cannot reproduce the next time they sign in with that
 * wallet.
 */
async function deviceKeyPrfOutput(credential: StoredCredential): Promise<Uint8Array> {
  const asserted = await getPasskeyPrfOutput({
    rpId: RP_ID,
    credential: toCredentialMetadata(credential),
    prfSalt: prfSaltFor('device'),
    timeout: PASSKEY_TIMEOUT_MS,
    webAuthnClient: reactNativeWebAuthnClient,
  });
  if (asserted.credentialId !== credential.credentialId) {
    zeroize(asserted.prfOutput);
    throw new Error(
      'the device-key assertion answered with a different passkey than the wallet ceremony',
    );
  }
  return asserted.prfOutput;
}

/** Inputs shared by both ceremonies. */
type CeremonyOptions = {
  /** BIP-44 address index. Defaults to 0; a later issue may expose more. */
  accountIndex?: number;
};

export type CreateWalletOptions = CeremonyOptions & {
  /** Account name stored with the passkey and shown by the provider. */
  userName: string;
  /** Human-readable name for the authenticator UI. Defaults to `userName`. */
  displayName?: string;
};

/**
 * Registers a new passkey and opens the wallet session it derives.
 *
 * Runs one creation ceremony for the `wallet` salt and one assertion for the
 * `device` salt — two prompts, and three on an authenticator that does not
 * evaluate PRF at creation time and needs mera's fallback assertion.
 *
 * @throws MeraError `PRF_UNAVAILABLE` when the chosen provider has no PRF —
 * see {@link describeAuthError}, which explains this one in user-facing terms.
 */
export async function createWallet({
  userName,
  displayName,
  accountIndex = 0,
}: CreateWalletOptions): Promise<WalletSession> {
  const created = await createPasskeyWithPrfOutput({
    rp: RELYING_PARTY,
    user: { name: userName, displayName: displayName ?? userName },
    prfSalt: prfSaltFor('wallet'),
    timeout: PASSKEY_TIMEOUT_MS,
    webAuthnClient: reactNativeWebAuthnClient,
  });
  return openSession({
    prfOutput: created.prfOutput,
    credential: { credentialId: created.credentialId, transports: created.transports },
    accountIndex,
  });
}

export type SignInOptions = CeremonyOptions & {
  /**
   * Credential hint from secure storage. Optional by design: with it omitted,
   * WebAuthn offers any discoverable credential for `sente.lol`, which is what
   * makes the account recoverable on a wiped install or a new device.
   */
  credential?: StoredCredential;
};

/**
 * Asserts an existing passkey and opens the wallet session it derives.
 *
 * Runs two assertion ceremonies, one per salt: the first is free to pick any
 * discoverable credential (which is what makes the account recoverable on a
 * wiped install), the second is pinned to whichever one it picked.
 */
export async function signIn({
  credential,
  accountIndex = 0,
}: SignInOptions = {}): Promise<WalletSession> {
  const asserted = await getPasskeyPrfOutput({
    rpId: RP_ID,
    ...(credential !== undefined ? { credential: toCredentialMetadata(credential) } : {}),
    prfSalt: prfSaltFor('wallet'),
    timeout: PASSKEY_TIMEOUT_MS,
    webAuthnClient: reactNativeWebAuthnClient,
  });
  return openSession({
    prfOutput: asserted.prfOutput,
    // An assertion does not report transports, so keep the stored hint only
    // when the platform answered with the credential we asked for.
    credential: {
      credentialId: asserted.credentialId,
      ...(credential?.credentialId === asserted.credentialId && credential.transports !== undefined
        ? { transports: credential.transports }
        : {}),
    },
    accountIndex,
  });
}

function toCredentialMetadata(credential: StoredCredential): PasskeyCredentialMetadata {
  return {
    credentialId: credential.credentialId,
    ...(credential.transports !== undefined ? { transports: credential.transports } : {}),
  };
}

/**
 * Opens a session, runs `use`, and ends the session in a `finally`.
 *
 * The right shape for a one-shot signature. The hook holds a long-lived session
 * instead, and ends it on sign-out and unmount.
 */
export async function withWalletSession<T>(
  open: () => Promise<WalletSession>,
  use: (session: WalletSession) => Promise<T>,
): Promise<T> {
  const session = await open();
  try {
    return await use(session);
  } finally {
    session.end();
  }
}

/** A failure classified for display. `code` is `null` for non-mera errors. */
export type AuthErrorDescription = {
  readonly code: MeraErrorCode | null;
  readonly title: string;
  readonly detail: string;
};

/**
 * Turns an error into something worth putting on screen.
 *
 * `PRF_UNAVAILABLE` is the one that matters in practice and the one that looks
 * like a bug in our code when it is not: Chrome's own local passkey store on
 * Android does not implement the PRF extension, so a passkey saved there
 * produces no key material. Google Password Manager does. The user has to pick
 * the right provider in the system sheet, and nothing but this message tells
 * them so.
 */
/**
 * One link of the chain as text. A native module does not reject with an Error:
 * `react-native-passkey` rejects with a plain object, and `String(obj)` is
 * "[object Object]", which is how a real reason becomes a shrug. Prefer the
 * fields a native rejection actually carries, and fall back to JSON so nothing
 * is silently dropped.
 */
function describeOne(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const bag = value as Record<string, unknown>;
    const named = ['message', 'error', 'code', 'name', 'reason']
      .map((key) => (typeof bag[key] === 'string' ? (bag[key] as string) : undefined))
      .filter((part): part is string => part !== undefined && part.length > 0);
    if (named.length > 0) return [...new Set(named)].join(': ');
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

/**
 * The platform's own words, which are the only ones that identify the real
 * failure. mera wraps a native WebAuthn rejection as `PASSKEY_OPERATION_FAILED`
 * with the original on `cause`, and reading only `message` leaves the user (and
 * us) staring at "Passkey creation failed" while the reason sits one field away.
 * Walks the chain, because a cause can itself have one. Bounded, so a cycle or a
 * deep chain cannot hang the screen.
 */
function causeChain(error: unknown, depth = 4): string[] {
  const seen = new Set<unknown>();
  const out: string[] = [];
  let current: unknown = error;
  while (current !== null && current !== undefined && out.length < depth && !seen.has(current)) {
    seen.add(current);
    const message = describeOne(current);
    if (message.length > 0 && !out.includes(message)) out.push(message);
    current = current instanceof Error ? (current.cause as unknown) : undefined;
  }
  return out;
}

export function describeAuthError(error: unknown): AuthErrorDescription {
  const chain = causeChain(error);
  const detail = chain.join(' — ') || (error instanceof Error ? error.message : String(error));
  if (!isMeraError(error)) {
    return { code: null, title: 'Something went wrong', detail };
  }
  switch (error.code) {
    case 'PRF_UNAVAILABLE':
      return {
        code: error.code,
        title: 'This passkey cannot hold a wallet',
        detail:
          'The passkey provider did not return PRF key material. Save the passkey to ' +
          'Google Password Manager rather than Chrome, then try again — a Chrome-local ' +
          'passkey has no PRF extension and cannot derive a wallet.',
      };
    case 'PASSKEY_OPERATION_FAILED':
      return {
        code: error.code,
        title: 'Passkey ceremony failed',
        detail: `${detail} (cancelled, unavailable, or sente.lol is not associated with this build — check assetlinks.json)`,
      };
    case 'CRYPTO_UNAVAILABLE':
      return {
        code: error.code,
        title: 'Crypto unavailable',
        detail: `${detail} — the polyfill in src/polyfills.ts did not install; check the first import of index.ts.`,
      };
    case 'SESSION_ENDED':
      return { code: error.code, title: 'Session ended', detail: 'Sign in again to sign.' };
    default:
      return { code: error.code, title: error.code, detail };
  }
}
