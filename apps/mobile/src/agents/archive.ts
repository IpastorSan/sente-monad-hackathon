/**
 * Archiving a stopped agent (SEN-197): what it still holds, read off the
 * portfolio the agent page already loaded. Mirrors the API's own check
 * (`services/api/src/agents/archive/funds-left.ts`), which is the one that
 * decides; this one only lets the sheet say "Return funds first" before
 * asking. Plain node, no React.
 */
import type { AgentFundsLeft, AgentPortfolioDto, BalanceDto } from './api.ts';

/** Below this a balance is dust, as on the server. */
export const ARCHIVE_DUST = 0.01;

/**
 * Everything above dust in the wallet (gas MON aside) and the Kuru account,
 * plus every open Perpl position. Perpl collateral does not count: Sente has
 * no Perpl withdraw, so it stays in the agent's Perpl account (SEN-203; see
 * {@link perplCollateralOf}). `null` when the portfolio is not loaded or a
 * section failed: then only the server knows.
 */
export function fundsLeftOf(
  portfolio: AgentPortfolioDto | null | undefined,
): AgentFundsLeft[] | null {
  if (!portfolio || !portfolio.wallet.ok || !portfolio.kuru.ok || !portfolio.perpl.ok) return null;
  const left: AgentFundsLeft[] = [];
  const add = (where: AgentFundsLeft['where'], balances: readonly BalanceDto[]) => {
    for (const b of balances) {
      if (Number(b.total) >= ARCHIVE_DUST) left.push({ where, asset: b.asset, amount: b.total });
    }
  };
  const spendable = portfolio.wallet.balances.filter((b) => b.asset !== 'MON');
  add('wallet', spendable);
  add('kuru', portfolio.kuru.balances);
  const perpl = portfolio.perpl;
  if (perpl.status === 'ok' || perpl.status === 'not_enrolled') {
    for (const p of perpl.positions ?? [])
      left.push({ where: 'perpl', asset: p.symbol, amount: p.size });
  }
  return left;
}

/**
 * Collateral above dust in the agent's Perpl account: what stays there when
 * it is archived, since no return can withdraw it. Empty when there is none
 * or the section is not readable.
 */
export function perplCollateralOf(
  portfolio: AgentPortfolioDto | null | undefined,
): AgentFundsLeft[] {
  const perpl = portfolio?.perpl;
  if (!perpl?.ok || (perpl.status !== 'ok' && perpl.status !== 'not_enrolled')) return [];
  return perpl.balances
    .filter((b) => Number(b.total) >= ARCHIVE_DUST)
    .map((b) => ({ where: 'perpl' as const, asset: b.asset, amount: b.total }));
}
