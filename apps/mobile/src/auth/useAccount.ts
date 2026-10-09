/**
 * React binding for the passkey wallet.
 *
 * Owns exactly one live `WalletSession` at a time and is responsible for its
 * lifetime: replacing a session ends the old one, signing out ends the current
 * one, and unmounting ends whatever is live. Key material never outlives the
 * component in plaintext.
 *
 * On web, the first frame also tries to reopen a session this tab sealed
 * before a reload (SEN-176, `restoreWallet`); signing out and forgetting the
 * passkey destroy that sealed copy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, LocalAccount } from 'viem';

import { clearCredential, loadCredential, saveCredential } from './credentialStore';
import type { AuthorizationPayload } from './deviceKey';
import type { PerplTradeKey } from './perplKey';
import {
  createWallet,
  describeAuthError,
  forgetSealedSession,
  restoreWallet,
  signIn as signInWithPasskey,
  type AuthErrorDescription,
  type StoredCredential,
  type WalletSession,
} from './mera';

export type AccountStatus =
  /** Reading the stored hint and, on web, any session sealed before a reload. */
  | 'restoring'
  /** No live session. `hasCredential` says whether a passkey is known here. */
  | 'signedOut'
  /** A WebAuthn ceremony is in flight; the system sheet is up. */
  | 'busy'
  /** A session is live and `account` can sign. */
  | 'ready';

export type UseAccount = {
  readonly status: AccountStatus;
  /** viem account, or `null` unless `status === 'ready'`. */
  readonly account: LocalAccount<'mera'> | null;
  readonly address: Address | null;
  /**
   * The session's device key as base64 SPKI DER, or `null` unless
   * `status === 'ready'`. What `POST /wallet/register` sends so Privy will name
   * this phone the owner of the user's wallet (SEN-40/41).
   */
  readonly devicePublicKey: string | null;
  /**
   * Signs a Privy authorization payload with the session's device key, or
   * `null` unless `status === 'ready'` — nullable for the same reason `account`
   * is: without a session there is no key, and there is nothing sensible to
   * return. Handed out as-is, so it stays stable for the session's lifetime and
   * refuses to sign once the session has ended.
   */
  readonly signPrivyAuthorization: ((payload: AuthorizationPayload) => string) | null;
  /**
   * Derives the Perpl trade key for a wallet (`WalletSession.perplTradeKey`),
   * or `null` unless `status === 'ready'`. The caller zeroes what it returns.
   */
  readonly perplTradeKey: ((wallet: Address) => PerplTradeKey) | null;
  /** Whether a credential hint is stored. Only affects the sign-in prompt. */
  readonly hasCredential: boolean;
  readonly error: AuthErrorDescription | null;
  /** Registers a new passkey and opens a session. */
  createPasskey: (userName: string) => Promise<void>;
  /** Asserts an existing passkey and opens a session. */
  signIn: () => Promise<void>;
  /** Ends the session, keeping the stored hint. Destroys a sealed copy (web). */
  signOut: () => void;
  /**
   * Ends the session and deletes the stored hint — the stateless test. Signing
   * in afterwards must reach the same address.
   */
  forget: () => Promise<void>;
};

export function useAccount(): UseAccount {
  const [status, setStatus] = useState<AccountStatus>('restoring');
  const [session, setSession] = useState<WalletSession | null>(null);
  const [storedCredential, setStoredCredential] = useState<StoredCredential | null>(null);
  const [error, setError] = useState<AuthErrorDescription | null>(null);

  // The session is also held in a ref so unmount can end it without making the
  // cleanup depend on state (which would end it on every change).
  const sessionRef = useRef<WalletSession | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current?.end();
      sessionRef.current = null;
    };
  }, []);

  /** Installs a session, ending whatever it replaces. */
  const adopt = useCallback((next: WalletSession | null) => {
    const previous = sessionRef.current;
    if (previous !== next) previous?.end();
    sessionRef.current = next;
    setSession(next);
    setStatus(next === null ? 'signedOut' : 'ready');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const credential = await loadCredential();
      // Web only: a session this tab sealed before a reload, if it is still
      // valid and belongs to this hint. Never throws; `null` on Android.
      const restored = await restoreWallet(credential);
      if (cancelled) {
        restored?.end();
        return;
      }
      setStoredCredential(credential);
      if (restored !== null) adopt(restored);
      else setStatus('signedOut');
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  const run = useCallback(
    async (open: () => Promise<WalletSession>) => {
      setError(null);
      setStatus('busy');
      let opened: WalletSession | null = null;
      try {
        opened = await open();
        if (!mountedRef.current) {
          // Unmounted mid-ceremony: nothing will ever use this key.
          opened.end();
          return;
        }
        await saveCredential(opened.credential);
        setStoredCredential(opened.credential);
        adopt(opened);
        opened = null;
      } catch (caught) {
        opened?.end();
        if (!mountedRef.current) return;
        setError(describeAuthError(caught));
        setStatus(sessionRef.current === null ? 'signedOut' : 'ready');
      }
    },
    [adopt],
  );

  const createPasskey = useCallback(
    (userName: string) => run(() => createWallet({ userName })),
    [run],
  );

  const signIn = useCallback(
    () =>
      run(() =>
        signInWithPasskey(storedCredential !== null ? { credential: storedCredential } : {}),
      ),
    [run, storedCredential],
  );

  const signOut = useCallback(() => {
    setError(null);
    adopt(null);
    void forgetSealedSession();
  }, [adopt]);

  const forget = useCallback(async () => {
    setError(null);
    adopt(null);
    await forgetSealedSession();
    await clearCredential();
    if (mountedRef.current) setStoredCredential(null);
  }, [adopt]);

  return {
    status,
    account: session?.account ?? null,
    address: session?.address ?? null,
    devicePublicKey: session?.devicePublicKey ?? null,
    signPrivyAuthorization: session?.signPrivyAuthorization ?? null,
    perplTradeKey: session?.perplTradeKey ?? null,
    hasCredential: storedCredential !== null,
    error,
    createPasskey,
    signIn,
    signOut,
    forget,
  };
}
