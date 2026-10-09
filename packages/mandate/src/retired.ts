/**
 * Mandates that still name Kuru's RETIRED deployment (SEN-185).
 *
 * Kuru moved testnet to an account-id deployment with new books, new tokens
 * and a new AccountCore (packages/venues/src/kuru/constants.ts). A mandate is
 * stored and compiled by address, so every agent hired before the switch names
 * Set-C books and tokens, and its live Privy policy pins them: it cannot trade
 * Kuru at all until its owner amends it (CLAUDE.md gotcha 13).
 *
 * These helpers say so in words, and carry each retired entry to its successor
 * — cbBTC-USDC to WBTC-USDC, XAUt-USDC to XAUT-USDC, Set-C USDC to the current
 * USDC, the others to their same-named successor — so an amend can be built
 * from the stored mandate without the owner re-picking every market.
 */
import {
  kuruMarketSuccessor,
  kuruTokenSuccessor,
  retiredKuruMarket,
  retiredKuruToken,
} from '@sente/venues/kuru';
import { getAddress, isAddressEqual, type Address } from 'viem';

import type { Mandate } from './mandate.ts';

/** One retired address a mandate names, and what an amend replaces it with. */
export interface RetiredKuruReference {
  readonly kind: 'market' | 'token';
  readonly from: Address;
  readonly fromSymbol: string;
  readonly to: Address;
  readonly toSymbol: string;
}

/** Every retired Kuru book and token `mandate` names; `[]` for a current mandate. */
export function retiredKuruReferences(
  mandate: Pick<Mandate, 'kuru' | 'rollingCap'>,
): RetiredKuruReference[] {
  const refs: RetiredKuruReference[] = [];
  for (const market of mandate.kuru.markets) {
    const old = retiredKuruMarket(market);
    if (!old) continue;
    const next = kuruMarketSuccessor(market);
    refs.push({
      kind: 'market',
      from: getAddress(market),
      fromSymbol: old.symbol,
      to: next.address,
      toSymbol: next.symbol,
    });
  }
  const tokens = [
    ...Object.keys(mandate.kuru.maxDepositAtoms),
    ...(mandate.rollingCap ? [mandate.rollingCap.token] : []),
  ];
  for (const token of tokens) {
    const old = retiredKuruToken(token);
    if (!old || refs.some((r) => isAddressEqual(r.from, token as Address))) continue;
    const next = kuruTokenSuccessor(token);
    refs.push({
      kind: 'token',
      from: getAddress(token),
      fromSymbol: old.symbol,
      to: next.address,
      toSymbol: next.symbol,
    });
  }
  return refs;
}

/**
 * What the owner is told: one sentence that names the way out, then the moves
 * an amend would make. `''` for a mandate with nothing retired.
 */
export function retiredKuruMessage(refs: readonly RetiredKuruReference[]): string {
  if (refs.length === 0) return '';
  const markets = refs.filter((r) => r.kind === 'market');
  const moves = (markets.length > 0 ? markets : refs)
    .map((r) => (r.fromSymbol === r.toSymbol ? r.toSymbol : `${r.fromSymbol} → ${r.toSymbol}`))
    .join(', ');
  return (
    "This agent's mandate names markets Kuru retired — amend it to move to the new markets " +
    `(${moves}). Until then it cannot trade on Kuru.`
  );
}

/**
 * `mandate` with every retired Kuru book and token replaced by its successor.
 * Where a retired token and its successor are both capped, the successor's own
 * cap stands — the owner set that one for the current deployment. Everything
 * else is untouched, so the result is the same mandate on the new books.
 */
export function withCurrentKuru<M extends Pick<Mandate, 'kuru' | 'rollingCap'>>(mandate: M): M {
  const markets: Address[] = [];
  for (const market of mandate.kuru.markets) {
    const next = retiredKuruMarket(market) ? kuruMarketSuccessor(market).address : market;
    if (!markets.some((m) => isAddressEqual(m, next))) markets.push(next);
  }

  const current = Object.entries(mandate.kuru.maxDepositAtoms).filter(
    ([token]) => !retiredKuruToken(token),
  );
  const maxDepositAtoms: Record<Address, bigint> = Object.fromEntries(current);
  for (const [token, cap] of Object.entries(mandate.kuru.maxDepositAtoms)) {
    if (!retiredKuruToken(token)) continue;
    const next = kuruTokenSuccessor(token).address;
    if (!Object.keys(maxDepositAtoms).some((t) => isAddressEqual(t as Address, next))) {
      maxDepositAtoms[next] = cap;
    }
  }

  const rollingCap =
    mandate.rollingCap && retiredKuruToken(mandate.rollingCap.token)
      ? { ...mandate.rollingCap, token: kuruTokenSuccessor(mandate.rollingCap.token).address }
      : mandate.rollingCap;

  return {
    ...mandate,
    kuru: { ...mandate.kuru, markets, maxDepositAtoms },
    ...(rollingCap ? { rollingCap } : {}),
  };
}
