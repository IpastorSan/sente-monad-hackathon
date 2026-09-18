/**
 * React binding for the user's Privy wallet (SEN-40/41).
 *
 * The wallet is created on the server but OWNED by this phone: its owner is the
 * `device` P-256 key derived from the passkey (SEN-38), which exists only for
 * the lifetime of a session and is never stored anywhere. So the first thing a
 * signed-in app does is present that key — `POST /wallet/register` — and the
 * server answers with the wallet bound to it, address and balances included.
 *
 * REGISTERING ON EVERY SIGN-IN IS THE POINT, not a leftover. The route is
 * idempotent per user and refuses a different key outright
 * (`device_key_mismatch`), so calling it is how the phone asks "which wallet is
 * mine?" without the app having to persist an answer it could get wrong. Nothing
 * about the wallet is cached across launches: the passkey re-derives the device
 * key, the device key names the wallet, and a wiped app storage still lands on
 * the same address.
 *
 * It also means one round trip covers registration AND the first balance read,
 * which is what the home screen wants at sign-in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';

import { asError, SIGNED_OUT, WalletApi, type SessionAuth, type UserWallet } from './api';

export type UserWalletStatus =
  /** No device key — the passkey session is not open. */
  | 'idle'
  /** Presenting the device key to the API. */
  | 'registering'
  /** The wallet is known; `wallet` holds its address and balances. */
  | 'ready'
  /** Registration failed; `error` says why. */
  | 'error';

export type UseUserWallet = {
  readonly status: UserWalletStatus;
  readonly wallet: UserWallet | null;
  readonly address: Address | null;
  readonly error: Error | null;
  /** True while a `refresh()` is in flight, for a pull-to-refresh spinner. */
  readonly refreshing: boolean;
  /** Re-reads `GET /wallet`. Balances move without the app doing anything. */
  refresh: () => Promise<void>;
};

export type UseUserWalletOptions = {
  /** The API session (SEN-37). Both routes are behind `SessionAuthGuard`. */
  auth?: SessionAuth;
  /** Injectable for tests. */
  api?: WalletApi;
};

export function useUserWallet(
  devicePublicKey: string | null,
  { auth, api: injectedApi }: UseUserWalletOptions = {},
): UseUserWallet {
  const [status, setStatus] = useState<UserWalletStatus>('idle');
  const [wallet, setWallet] = useState<UserWallet | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The wallet is mirrored in a ref so `refresh` can ask "is there one yet?"
  // without taking `wallet` as a dependency. A `refresh` that changed identity
  // on every balance change would re-fire the screen's focus effect, which
  // calls `refresh`, which changes it again.
  const walletRef = useRef<UserWallet | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const api = useMemo(
    () => injectedApi ?? new WalletApi({ auth: auth ?? SIGNED_OUT }),
    [injectedApi, auth],
  );

  /** The one way to change the wallet: the ref and the state move together. */
  const remember = useCallback((next: UserWallet | null) => {
    walletRef.current = next;
    setWallet(next);
  }, []);

  useEffect(() => {
    if (devicePublicKey === null) {
      // Signed out. The wallet still exists on chain, but showing its balance
      // with no session behind it would be showing someone else's screen.
      remember(null);
      setError(null);
      setStatus('idle');
      return;
    }

    let cancelled = false;
    setStatus('registering');
    setError(null);

    void (async () => {
      try {
        const registered = await api.register(devicePublicKey);
        if (cancelled) return;
        remember(registered);
        setStatus('ready');
      } catch (caught) {
        if (cancelled) return;
        setError(asError(caught));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [devicePublicKey, api, remember]);

  const refresh = useCallback(async () => {
    // Before the wallet is known there is nothing to re-read: `GET /wallet`
    // would 404 with `account_not_registered` and overwrite the registration
    // error with a less useful one.
    if (walletRef.current === null) return;
    setRefreshing(true);
    try {
      const fresh = await api.account();
      if (!mountedRef.current) return;
      remember(fresh);
      setError(null);
    } catch (caught) {
      if (mountedRef.current) setError(asError(caught));
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [api, remember]);

  // Memoised because this value goes straight into the session context: a new
  // object on every render would re-render every screen that reads the session,
  // and a balance refresh flips `refreshing` twice on each visit to the home
  // screen.
  return useMemo(
    () => ({
      status,
      wallet,
      address: wallet?.address ?? null,
      error,
      refreshing,
      refresh,
    }),
    [status, wallet, error, refreshing, refresh],
  );
}
