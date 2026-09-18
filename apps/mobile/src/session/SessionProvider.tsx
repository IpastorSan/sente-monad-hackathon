/**
 * One passkey session, one wallet and one smart account for the whole app.
 *
 * `useAccount` owns exactly one live `WalletSession` per component that calls
 * it, so two screens calling it would mean two sessions, two sign-ins and two
 * copies of the key. It lives here instead, once, above the router; screens
 * read it through `useSession`.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { AgentsApi } from '@/agents/api';
import { useAccount, type UseAccount } from '@/auth';
import { useSmartAccount, useUserWallet, type UseSmartAccount, type UseUserWallet } from '@/wallet';
import type { SessionAuth } from '@/wallet/api';

import { useSessionAuth } from './auth';

export type Session = {
  readonly auth: UseAccount;
  /**
   * The user's account: the Privy wallet owned by this phone's device key
   * (SEN-40). Registered on sign-in, and the one the home screen shows.
   */
  readonly wallet: UseUserWallet;
  /** The older Kernel smart account, until SEN-45 retires it. */
  readonly smart: UseSmartAccount;
  /**
   * The API session: a bearer token the passkey account signed for (SEN-37).
   * Held in memory only, and shared by every API client so they cannot end up
   * authenticated as two different users.
   */
  readonly api: SessionAuth;
  /** `null` until signed in: agents are scoped to the owner address. */
  readonly agents: AgentsApi | null;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const auth = useAccount();
  // One token source for the whole app: `useSessionAuth` signs in as soon as
  // there is a key to sign with, and re-signs in when a request comes back 401.
  const api = useSessionAuth(auth.account);
  // Present the device key as soon as there is one: registration is idempotent
  // and answers with the wallet's address and balances, so the home screen has
  // something to show one round trip after sign-in.
  const wallet = useUserWallet(auth.devicePublicKey, { auth: api });
  const smart = useSmartAccount(auth.account, { auth: api });
  const agents = useMemo(
    () => (auth.address ? new AgentsApi({ auth: api }) : null),
    [auth.address, api],
  );
  const session = useMemo(
    () => ({ auth, wallet, smart, api, agents }),
    [auth, wallet, smart, api, agents],
  );
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('useSession must be used inside <SessionProvider>');
  return session;
}
