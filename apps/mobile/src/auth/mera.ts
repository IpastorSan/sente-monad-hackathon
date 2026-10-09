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
 * **One prompt for both keys (SEN-176).** WebAuthn's PRF extension evaluates
 * two salts in one ceremony, and our mera patch exposes that, so sign-in asks
 * for both in the same assertion (`./ceremony`). A provider that ignores the
 * second salt gets the old second assertion, pinned to the credential the first
 * one chose; the outputs are the same bytes either way. Everything after
 * sign-in is prompt-free: `signDigest` and `signPrivyAuthorization` both sign
 * locally from the derived keys.
 *
 * On web, a signed-in tab also survives a reload: the session's two secrets
 * are sealed under a non-extractable key for the life of the tab
 * (`./sessionSeal.web.ts`, `docs/web.md`). On Android that is a no-op.
 *
 * The same ceremonies run on Android and in a browser; only the WebAuthn
 * transport differs, and `./webauthnClient` picks it per platform (SEN-165).
 */
import { createSecp256k1SigningSession, type Secp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { isAddressEqual, type Address, type LocalAccount } from 'viem';

import {
  assertKeyMaterial,
  createKeyMaterial,
  type SessionKeyMaterial,
  type StoredCredential,
} from './ceremony';
import { RP_ID } from './constants';
import { deriveDeviceKey, zeroize } from './derive';
import {
  devicePublicKeySpki,
  signPrivyAuthorization as signWithDeviceKey,
  type AuthorizationPayload,
} from './deviceKey';
import { clearSealedSession, sealSession, unsealSession } from './sessionSeal';
import { webAuthnClient } from './webauthnClient';

// The error classifier lives in a React-Native-free module so node can test it;
// re-exported so every existing import of it from here holds.
export { describeAuthError, type AuthErrorDescription } from './authError';

// PERMANENT (CLAUDE.md). Defined in the React-Native-free `./constants` so a
// node test can pin it (SEN-138); re-exported so every existing import holds.
export { RP_ID };

// Defined next to the ceremonies, which are React-Native-free; re-exported so
// every existing import of it from here holds.
export type { StoredCredential };

/** Name the authenticator shows in its UI. Cosmetic; safe to change. */
export const RP_NAME = 'Sente';

const RELYING_PARTY = { id: RP_ID, name: RP_NAME } as const;

/**
 * WebAuthn timeout. Generous, because the ceremony includes the user picking a
 * provider and passing a biometric check, and a timeout here reads to the user
 * as "the app is broken".
 */
const PASSKEY_TIMEOUT_MS = 120_000;

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
  /** Already-derived secp256k1 key. Borrowed — the caller wipes it. */
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
 * live for the session, gone at sign-out, never written anywhere in plaintext
 * (on web, its PRF output is sealed for the tab's lifetime — see `openAndSeal`).
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
 * A fresh sign-in's last step: opens the session, seals the material for a
 * reload (web; a no-op on Android, and a failure there only costs a prompt
 * after the next reload), and wipes both secrets on every path.
 */
async function openAndSeal(material: SessionKeyMaterial): Promise<WalletSession> {
  try {
    const session = openWalletSession(material);
    await sealSession({ ...material, address: session.address });
    return session;
  } finally {
    zeroize(material.privateKey, material.devicePrfOutput);
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
 * Asks for both salts in the creation ceremony itself: one prompt on a
 * provider that evaluates PRF at creation, two on one that only evaluates it
 * at assertion time (mera's fallback assertion then asks for both salts), and
 * two on one that ignores the second salt (the device salt then gets its own
 * pinned assertion).
 *
 * @throws MeraError `PRF_UNAVAILABLE` when the chosen provider has no PRF —
 * see {@link describeAuthError}, which explains this one in user-facing terms.
 */
export async function createWallet({
  userName,
  displayName,
  accountIndex = 0,
}: CreateWalletOptions): Promise<WalletSession> {
  const material = await createKeyMaterial({
    rp: RELYING_PARTY,
    user: { name: userName, displayName: displayName ?? userName },
    accountIndex,
    timeout: PASSKEY_TIMEOUT_MS,
    webAuthnClient,
  });
  return openAndSeal(material);
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
 * One assertion for both salts, free to pick any discoverable credential
 * (which is what makes the account recoverable on a wiped install). A provider
 * that does not evaluate the second salt gets a second assertion, pinned to
 * whichever credential the first one picked.
 */
export async function signIn({
  credential,
  accountIndex = 0,
}: SignInOptions = {}): Promise<WalletSession> {
  const material = await assertKeyMaterial({
    ...(credential !== undefined ? { credential } : {}),
    accountIndex,
    timeout: PASSKEY_TIMEOUT_MS,
    webAuthnClient,
  });
  return openAndSeal(material);
}

/**
 * Reopens a session sealed by an earlier sign-in in this browser tab, with no
 * ceremony. `null` (and the seal cleared) when there is none, or when it does
 * not belong to `hint`: a different credential than the stored hint, or a
 * rebuilt address that is not the one sealed with it. Always `null` on Android.
 *
 * The session is rebuilt by the same `openWalletSession` sign-in uses, from
 * the same two secrets sign-in would have derived, so it is the same session.
 */
export async function restoreWallet(hint: StoredCredential | null): Promise<WalletSession | null> {
  const sealed = await unsealSession();
  if (sealed === null) return null;
  let session: WalletSession | undefined;
  try {
    if (hint?.credentialId !== sealed.credential.credentialId) {
      throw new Error('sealed session belongs to another passkey');
    }
    session = openWalletSession(sealed);
    if (!isAddressEqual(session.address, sealed.address as Address)) {
      throw new Error('sealed session rebuilt a different address');
    }
    return session;
  } catch {
    session?.end();
    await clearSealedSession();
    return null;
  } finally {
    zeroize(sealed.privateKey, sealed.devicePrfOutput);
  }
}

/** Forgets the sealed copy of the session (sign-out, "forget this passkey"). */
export { clearSealedSession as forgetSealedSession };

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
