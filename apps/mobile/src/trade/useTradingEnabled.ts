/**
 * Whether to offer manual trading at all (SEN-102, plan §5 "Feature flag"),
 * and perps on Perpl among it (SEN-120, `capabilities().venues.perpl`).
 *
 * The build flag is checked first so a build without it never even asks the
 * API; the capabilities read is once per signed-in client, not polled, because
 * the server flag only changes with a redeploy. Until the answer arrives — or
 * if it fails — trading reads as off: hiding a working feature for a moment is
 * better than offering one the server will refuse.
 */
import { useEffect, useState } from 'react';

import { MONAD_NETWORK } from '@/chain';
import { useSession } from '@/session';

import { isPerpsEnabled, isTradingEnabled } from './api';
import type { TradeCapabilities } from './types';

const BUILD_FLAG = process.env.EXPO_PUBLIC_USER_TRADING;

export type TradingCapabilities = {
  /** Manual trading (Kuru spot) is on for this build, this API and this network. */
  readonly trading: boolean;
  /** …and the API also trades perps for users (`USER_TRADING_PERPL`). */
  readonly perps: boolean;
};

export function useTradingCapabilities(): TradingCapabilities {
  const { trade } = useSession();
  const [capabilities, setCapabilities] = useState<TradeCapabilities | null>(null);

  useEffect(() => {
    setCapabilities(null);
    if (trade === null || BUILD_FLAG !== '1') return;
    let live = true;
    trade.capabilities().then(
      (answer) => {
        if (live) setCapabilities(answer);
      },
      () => {
        // Off on failure (see above); the next sign-in asks again.
      },
    );
    return () => {
      live = false;
    };
  }, [trade]);

  const input = { buildFlag: BUILD_FLAG, capabilities, network: MONAD_NETWORK };
  return { trading: isTradingEnabled(input), perps: isPerpsEnabled(input) };
}

export function useTradingEnabled(): boolean {
  return useTradingCapabilities().trading;
}
