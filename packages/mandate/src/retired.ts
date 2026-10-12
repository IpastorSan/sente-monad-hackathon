/**
 * Mandates that still name the Kuru deployment Sente does NOT trade
 * (SEN-185, SEN-189).
 *
 * Kuru has run two testnet deployments with different books, tokens and
 * AccountCores (packages/venues/src/kuru/constants.ts), and `KURU_DEPLOYMENT`
 * picks the one Sente trades. A mandate is stored and compiled by address, so
 * an agent hired on the other one names its books and tokens, and its live
 * Privy policy pins them: it cannot trade Kuru at all until its owner amends
 * it (CLAUDE.md gotcha 13).
 *
 * These helpers say so in words, and carry each retired entry to its
 * counterpart — cbBTC-USDC ↔ WBTC-USDC, XAUt-USDC ↔ XAUT-USDC, one USDC to the
 * other, the rest to their same-named counterpart — so an amend can be built
 * from the stored mandate without the owner re-picking every market. An entry
 * with no counterpart (Set D's USDT-USDC while Set C is active) is dropped.
 */
import {
  KURU_RETIRED_DEPLOYMENT,
  kuruMarketSuccessor,
  kuruTokenSuccessor,
  retiredKuruMarket,
  retiredKuruToken,
} from '@sente/venues/kuru';
import { getAddress, isAddressEqual, type Address } from 'viem';

import type { Mandate } from './mandate.ts';

/**
 * One retired address a mandate names, and what an amend replaces it with:
 * `to`/`toSymbol` are `null` when the active deployment has no counterpart and
 * the amend drops it.
 */
export interface RetiredKuruReference {
  readonly kind: 'market' | 'token';
  readonly from: Address;
  readonly fromSymbol: string;
  readonly to: Address | null;
  readonly toSymbol: string | null;
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
      to: next?.address ?? null,
      toSymbol: next?.symbol ?? null,
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
      to: next?.address ?? null,
      toSymbol: next?.symbol ?? null,
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
    .map((r) =>
      r.toSymbol === null
        ? `${r.fromSymbol} dropped`
        : r.fromSymbol === r.toSymbol
          ? r.toSymbol
          : `${r.fromSymbol} → ${r.toSymbol}`,
    )
    .join(', ');
  // Set C really was retired by Kuru; Set D, when Set C is active, is only
  // the deployment Sente stopped trading.
  const named =
    KURU_RETIRED_DEPLOYMENT.id === 'set-c'
      ? 'markets Kuru retired — amend it to move to the new markets'
      : 'Kuru markets Sente does not trade now — amend it to move to the ones it does';
  return `This agent's mandate names ${named} (${moves}). Until then it cannot trade on Kuru.`;
}

/**
 * `mandate` with every retired Kuru book and token replaced by its successor,
 * or dropped when it has none. Where a retired token and its successor are
 * both capped, the successor's own cap stands — the owner set that one for the
 * active deployment. Everything else is untouched, so the result is the same
 * mandate on the active books.
 */
export function withCurrentKuru<M extends Pick<Mandate, 'kuru' | 'rollingCap'>>(mandate: M): M {
  const markets: Address[] = [];
  for (const market of mandate.kuru.markets) {
    const next = retiredKuruMarket(market) ? kuruMarketSuccessor(market)?.address : market;
    if (next && !markets.some((m) => isAddressEqual(m, next))) markets.push(next);
  }

  const current = Object.entries(mandate.kuru.maxDepositAtoms).filter(
    ([token]) => !retiredKuruToken(token),
  );
  const maxDepositAtoms: Record<Address, bigint> = Object.fromEntries(current);
  for (const [token, cap] of Object.entries(mandate.kuru.maxDepositAtoms)) {
    if (!retiredKuruToken(token)) continue;
    const next = kuruTokenSuccessor(token)?.address;
    if (!next) continue;
    if (!Object.keys(maxDepositAtoms).some((t) => isAddressEqual(t as Address, next))) {
      maxDepositAtoms[next] = cap;
    }
  }

  // A rolling cap on a token with no counterpart has nothing left to cap: drop it.
  const rollingNext =
    mandate.rollingCap && retiredKuruToken(mandate.rollingCap.token)
      ? kuruTokenSuccessor(mandate.rollingCap.token)
      : undefined;
  const rollingCap =
    rollingNext === undefined
      ? mandate.rollingCap
      : rollingNext && mandate.rollingCap
        ? { ...mandate.rollingCap, token: rollingNext.address }
        : undefined;

  const { rollingCap: _dropped, ...rest } = mandate;
  void _dropped;
  return {
    ...rest,
    kuru: { ...mandate.kuru, markets, maxDepositAtoms },
    ...(rollingCap ? { rollingCap } : {}),
  } as unknown as M;
}
