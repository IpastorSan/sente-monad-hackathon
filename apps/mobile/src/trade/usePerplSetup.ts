/**
 * Where the user's own Perpl setup stands (SEN-120): no account, account but
 * no trading key, or ready — from `/trade/perpl/account` and the token this
 * phone kept (`perplApiKeys`). Asked only while perps are on; re-read on
 * focus, because the setup screen changes it from elsewhere.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useSession } from '@/session';

import { perplApiKeyOf, perplReady, perplSetupNeeds, type PerplSetupNeeds } from './flow';
import { perplApiKeys } from './perplApiKeys';
import type { PerplAccount } from './types';

export type PerplSetup =
  /** Perps are off, or there is no wallet yet: nothing to ask. */
  | { readonly kind: 'off' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'needed'; readonly needs: PerplSetupNeeds; readonly account: PerplAccount }
  | { readonly kind: 'ready'; readonly apiKey: string; readonly account: PerplAccount };

export function usePerplSetup(perps: boolean): PerplSetup & { refresh: () => void } {
  const { trade, wallet } = useSession();
  const address = wallet.wallet?.address ?? null;
  const [state, setState] = useState<PerplSetup>({ kind: 'off' });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  // Only the first read shows a spinner; a re-read keeps what is on screen.
  const shownRef = useRef(false);

  useEffect(() => {
    if (!perps || trade === null || address === null) {
      shownRef.current = false;
      setState({ kind: 'off' });
      return;
    }
    let live = true;
    if (!shownRef.current) setState({ kind: 'loading' });
    void (async () => {
      try {
        const [account, stored] = await Promise.all([
          trade.perplAccount(),
          perplApiKeys.load(address),
        ]);
        if (!live) return;
        const apiKey = perplApiKeyOf(account, stored);
        // Keep the server's token here too, so a server that loses it later
        // does not cost an enrollment (and two of 16 key slots).
        if (account.apiKey && account.apiKey !== stored) {
          void perplApiKeys.save(address, account.apiKey).catch(() => undefined);
        }
        const needs = perplSetupNeeds(account, stored);
        shownRef.current = true;
        setState(
          perplReady(needs) && apiKey !== null
            ? { kind: 'ready', apiKey, account }
            : { kind: 'needed', needs, account },
        );
      } catch (error) {
        if (!live) return;
        shownRef.current = true;
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      live = false;
    };
  }, [perps, trade, address, tick]);

  // The mount already reads; every later focus re-reads.
  const focusedRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedRef.current) refresh();
      focusedRef.current = true;
    }, [refresh]),
  );

  return { ...state, refresh };
}
