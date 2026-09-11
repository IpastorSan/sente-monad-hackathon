/**
 * One passkey session and one smart account for the whole app.
 *
 * `useAccount` owns exactly one live `WalletSession` per component that calls
 * it, so two screens calling it would mean two sessions, two sign-ins and two
 * copies of the key. It lives here instead, once, above the router; screens
 * read it through `useSession`.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { AgentsApi } from '@/agents/api';
import { useAccount, type UseAccount } from '@/auth';
import { useSmartAccount, type UseSmartAccount } from '@/wallet';

export type Session = {
  readonly auth: UseAccount;
  readonly smart: UseSmartAccount;
  /** `null` until signed in: agents are scoped to the owner address. */
  readonly agents: AgentsApi | null;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const auth = useAccount();
  const smart = useSmartAccount(auth.account);
  // Same placeholder identity `useSmartAccount` gives `WalletApi`: the owner
  // address. The two must agree, or agents and wallet land on different users.
  const agents = useMemo(
    () => (auth.address ? new AgentsApi({ userId: auth.address }) : null),
    [auth.address],
  );
  const session = useMemo(() => ({ auth, smart, agents }), [auth, smart, agents]);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('useSession must be used inside <SessionProvider>');
  return session;
}
