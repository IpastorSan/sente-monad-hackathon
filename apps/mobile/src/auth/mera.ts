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
 * There is exactly one WebAuthn prompt per session: `signDigest` on a live
 * session signs locally from the derived key, so signing a transaction does not
 * re-prompt for a biometric.
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

import { deriveEvmKey, prfSaltFor, zeroize } from './derive';

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
 * signing method rejects with mera's `SESSION_ENDED`.
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
  /** Zeroes the session key. Idempotent. */
  end(): void;
  [Symbol.dispose](): void;
};

type OpenSessionInput = {
  prfOutput: Uint8Array;
  credential: StoredCredential;
  accountIndex: number;
};

/**
 * Turns a PRF output into a live session.
 *
 * The PRF output is the caller's to zero; the derived private key is zeroed
 * here as soon as mera's session has taken its own copy. On any failure the
 * half-built signing session is ended before the error propagates, so a throw
 * never leaves key material live.
 */
function openWalletSession({
  prfOutput,
  credential,
  accountIndex,
}: OpenSessionInput): WalletSession {
  const privateKey = deriveEvmKey(prfOutput, accountIndex);
  let signing: Secp256k1SigningSession | undefined;
  try {
    signing = createSecp256k1SigningSession({ privateKey });
    const account = toViemAccount(signing);
    const end = signing.end.bind(signing);
    return {
      account,
      address: account.address,
      credential,
      accountIndex,
      end,
      [Symbol.dispose]: end,
    };
  } catch (error) {
    signing?.end();
    throw error;
  } finally {
    zeroize(privateKey);
  }
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
 * Runs one creation ceremony (and, on authenticators that do not evaluate PRF
 * at creation time, one fallback assertion — so the user may see two prompts).
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
  try {
    return openWalletSession({
      prfOutput: created.prfOutput,
      credential: { credentialId: created.credentialId, transports: created.transports },
      accountIndex,
    });
  } finally {
    zeroize(created.prfOutput);
  }
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
 * Runs exactly one assertion ceremony.
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
  try {
    return openWalletSession({
      prfOutput: asserted.prfOutput,
      // An assertion does not report transports, so keep the stored hint only
      // when the platform answered with the credential we asked for.
      credential: {
        credentialId: asserted.credentialId,
        ...(credential?.credentialId === asserted.credentialId &&
        credential.transports !== undefined
          ? { transports: credential.transports }
          : {}),
      },
      accountIndex,
    });
  } finally {
    zeroize(asserted.prfOutput);
  }
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
export function describeAuthError(error: unknown): AuthErrorDescription {
  const detail = error instanceof Error ? error.message : String(error);
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
