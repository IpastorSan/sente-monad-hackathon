/**
 * What each agent's own wallet holds, read from the chain (SEN-58). The agents
 * list shows a balance per card, and the API has no balances for agent wallets,
 * so this reads them the way the agent screen always has (`readBalances`).
 *
 * A failed read leaves that agent out of the map rather than showing zero: a
 * card with no balance is honest, and `0.00` for a wallet we could not read
 * would be a confident lie about money.
 */
import { useEffect, useState } from 'react';
import type { Address } from 'viem';

import { readBalances } from './balances';
import { FUNDING_TOKENS } from './fund';
import type { Holding } from './usage';

/** `readBalances`' symbol map as holdings, in `FUNDING_TOKENS` order. */
export function toHoldings(balances: Record<string, bigint>): Holding[] {
  return FUNDING_TOKENS.map((token) => ({
    symbol: token.symbol,
    atoms: balances[token.symbol] ?? 0n,
    decimals: token.decimals,
  }));
}

/**
 * Holdings by agent id. Re-reads whenever `agents` is a new array — which the
 * overview hook hands over on every focus and every pull-to-refresh.
 */
export function useWalletHoldings(
  agents: readonly { id: string; address: Address }[] | null,
): ReadonlyMap<string, Holding[]> {
  const [holdings, setHoldings] = useState<ReadonlyMap<string, Holding[]>>(new Map());

  useEffect(() => {
    if (!agents) return;
    let cancelled = false;
    void Promise.allSettled(
      agents.map(
        async (agent) => [agent.id, toHoldings(await readBalances(agent.address))] as const,
      ),
    ).then((results) => {
      if (cancelled) return;
      setHoldings(
        new Map(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [agents]);

  return holdings;
}
