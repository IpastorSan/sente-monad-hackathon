/**
 * React binding for the passkey wallet.
 *
 * Owns exactly one live `WalletSession` at a time and is responsible for its
 * lifetime: replacing a session ends the old one, signing out ends the current
 * one, and unmounting ends whatever is live. Key material never outlives the
 * component.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, LocalAccount } from 'viem';

import { clearCredential, loadCredential, saveCredential } from './credentialStore';
import {
  createWallet,
  describeAuthError,
  signIn as signInWithPasskey,
  type AuthErrorDescription,
  type StoredCredential,
  type WalletSession,
} from './mera';

export type AccountStatus =
  /** Reading the stored credential hint. First frame only. */
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
  /** Whether a credential hint is stored. Only affects the sign-in prompt. */
  readonly hasCredential: boolean;
  readonly error: AuthErrorDescription | null;
  /** Registers a new passkey and opens a session. */
  createPasskey: (userName: string) => Promise<void>;
  /** Asserts an existing passkey and opens a session. */
  signIn: () => Promise<void>;
  /** Ends the session, keeping the stored hint. */
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

  useEffect(() => {
    let cancelled = false;
    void loadCredential().then((credential) => {
      if (cancelled) return;
      setStoredCredential(credential);
      setStatus('signedOut');
    });
    return () => {
      cancelled = true;
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
  }, [adopt]);

  const forget = useCallback(async () => {
    setError(null);
    adopt(null);
    await clearCredential();
    if (mountedRef.current) setStoredCredential(null);
  }, [adopt]);

  return {
    status,
    account: session?.account ?? null,
    address: session?.address ?? null,
    hasCredential: storedCredential !== null,
    error,
    createPasskey,
    signIn,
    signOut,
    forget,
  };
}
