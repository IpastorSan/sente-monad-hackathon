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
 * Everything above dust in the wallet (gas MON aside), the Kuru account and
 * the Perpl account, plus every open Perpl position. `null` when the
 * portfolio is not loaded or a section failed: then only the server knows.
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
    add('perpl', perpl.balances);
    for (const p of perpl.positions ?? [])
      left.push({ where: 'perpl', asset: p.symbol, amount: p.size });
  }
  return left;
}
