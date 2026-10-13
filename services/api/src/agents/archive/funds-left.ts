// What an agent still holds, read off the same portfolio the agent page shows
// (SEN-197). Archiving is refused while anything here is above dust: an agent
// put away with money in it is money its owner stops seeing.

import type { AgentPortfolioDto, BalanceDto } from '../../venues/dto/markets.dto';

/**
 * Below this, a balance is dust and does not block an archive. In token units:
 * a cent of a stablecoin, less than a return transaction is worth.
 */
export const ARCHIVE_DUST = 0.01;

export type FundsSection = 'wallet' | 'kuru' | 'perpl';

/** One thing the agent still holds. */
export interface FundsLeft {
  where: FundsSection;
  asset: string;
  /** Decimal string in token units; for a Perpl position, its size. */
  amount: string;
}

export interface FundsCheck {
  left: FundsLeft[];
  /** Sections that could not be read just now, so the answer is not known. */
  unreadable: FundsSection[];
}

/**
 * Everything above dust in the agent's wallet and Kuru account, plus every
 * open Perpl position whatever its size. The wallet's native MON is left out:
 * it is the gas the drip sent, a return does not send it home (only ERC-20s
 * are returnable), and every revoked agent keeps some.
 *
 * Perpl collateral is left out too (SEN-203): Sente has no Perpl withdraw, so
 * a return cannot move it and refusing on it would make an agent that ever
 * funded Perpl impossible to archive. It stays in the agent's Perpl account,
 * which the app says. An open position still blocks: it is live risk.
 */
export function fundsLeft(portfolio: AgentPortfolioDto): FundsCheck {
  const left: FundsLeft[] = [];
  const unreadable: FundsSection[] = [];
  const balances = (where: FundsSection, list: readonly BalanceDto[]): void => {
    for (const balance of list) {
      if (Number(balance.total) >= ARCHIVE_DUST) {
        left.push({ where, asset: balance.asset, amount: balance.total });
      }
    }
  };

  const { wallet, kuru, perpl } = portfolio;
  if (wallet.ok)
    balances(
      'wallet',
      wallet.balances.filter((b) => b.asset !== 'MON'),
    );
  else unreadable.push('wallet');

  if (kuru.ok) balances('kuru', kuru.balances);
  else unreadable.push('kuru');

  if (!perpl.ok) unreadable.push('perpl');
  else if (perpl.status === 'ok' || perpl.status === 'not_enrolled') {
    for (const position of perpl.positions ?? []) {
      left.push({ where: 'perpl', asset: position.symbol, amount: position.size });
    }
  }
  return { left, unreadable };
}

/** `12.5 USDC in the wallet, 0.1 BTC in Perpl` — for a refusal's message. */
export function describeFundsLeft(left: readonly FundsLeft[]): string {
  const place: Record<FundsSection, string> = {
    wallet: 'the wallet',
    kuru: 'Kuru',
    perpl: 'Perpl',
  };
  return left.map((f) => `${f.amount} ${f.asset} in ${place[f.where]}`).join(', ');
}
