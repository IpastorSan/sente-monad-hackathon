/**
 * The Perpl trader every screen should use: `createPerplTrader` on this
 * platform's network (SEN-175). Android goes to Perpl directly; the web build
 * goes through Sente's proxy, because Perpl refuses a browser on sente.lol.
 *
 * The import below is extensionless on purpose: that is what lets Metro pick
 * `perplNetwork.web.ts` for the web bundle. `perplTrader.ts` cannot do it
 * itself, because node's test runner resolves only explicit `.ts` specifiers.
 */
import { PERPL_NETWORK } from '@/trade/perplNetwork';

import { createPerplTrader, type PerplTrader, type PerplTraderOptions } from './perplTrader.ts';

export function createAppPerplTrader(
  options: Omit<PerplTraderOptions, 'restUrl' | 'wsUrl' | 'chainId'>,
): PerplTrader {
  return createPerplTrader({ ...options, ...PERPL_NETWORK });
}
