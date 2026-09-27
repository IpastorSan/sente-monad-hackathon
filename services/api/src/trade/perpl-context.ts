/**
 * Perpl's live `/v1/pub/context` for user onboarding (SEN-99): the Exchange,
 * the collateral token and the account-opening minimum, which differs 10x
 * between testnet and mainnet and so is read, never hard-coded
 * (`perpl/onboarding.ts`).
 *
 * Cached briefly: `GET /trade/perpl/account` is polled by the app, and those
 * values change only with a redeploy of the venue.
 */

import { PERPL_NETWORKS, PerplRest, type PerplContext } from '@sente/venues/perpl';

export const PERPL_CONTEXT = Symbol('PERPL_CONTEXT');

/** Resolves the current context; rejects when Perpl cannot be reached. */
export type PerplContextSource = () => Promise<PerplContext>;

export const PERPL_CONTEXT_TTL_MS = 60_000;

export function cachedPerplContext(
  fetchContext: PerplContextSource = () => new PerplRest(PERPL_NETWORKS.testnet).context(),
  ttlMs = PERPL_CONTEXT_TTL_MS,
  now: () => number = Date.now,
): PerplContextSource {
  let held: { at: number; context: Promise<PerplContext> } | undefined;
  return () => {
    const at = now();
    if (!held || at - held.at >= ttlMs) {
      const context = fetchContext();
      // A failed read is not cached: the next caller asks Perpl again.
      context.catch(() => {
        if (held?.context === context) held = undefined;
      });
      held = { at, context };
    }
    return held.context;
  };
}
