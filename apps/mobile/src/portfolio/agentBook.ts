/**
 * The Portfolio's "Agents" section (SEN-215), sorted into the three things
 * the owner could not tell apart in the old "With your agents" box:
 *
 * - **balances**: one row per agent, with its status in words and what it
 *   holds as ONE dollar figure (`valuation.ts`, the same prices as the
 *   headline), naming any coin nothing prices instead of adding it;
 * - **open**: every open position an agent holds right now;
 * - **closed**: every round trip an agent has closed, from the verdicts in
 *   its event log (`settledTrades`, what the cockpit's best trades read),
 *   newest first.
 *
 * A revoked agent is listed only while it still holds something, so money
 * never leaves the total without a row saying where it is, and an emptied
 * revoked agent does not crowd the list.
 *
 * Pure, no React Native: `agentBook.test.ts` pins it under plain node.
 */
import type { Agent, AgentPortfolioDto } from '../agents/api.ts';
import { settledTrades } from '../agents/cockpit.ts';
import type { LedgerEntry } from '../agents/ledger.ts';
import { formatDuration } from '../agents/usage.ts';
import type { TickerDto } from '../markets/api.ts';
import { addAmounts, signedAmountsText, type AssetAmount } from '../ui/assetAmounts.ts';
import { signedFigure } from '../ui/money.ts';
import type { Direction } from '../ui/tradingFormat.ts';

import { valuation, type Valuation } from './valuation.ts';
import {
  agentHoldingAmounts,
  baseOf,
  isPositive,
  mulDecimal,
  ratio,
  shortDate,
  sumOf,
  type AllocationPart,
} from './view.ts';

export type AgentBookInput = {
  agent: Pick<Agent, 'id' | 'name' | 'status' | 'revokedAt'> & {
    mandate: Pick<Agent['mandate'], 'expiresAt'>;
  };
  /** `null` when the route is missing or the read failed. */
  portfolio: AgentPortfolioDto | null;
  /** Its most recent events as Ledger entries; `null` while unread. */
  entries: readonly LedgerEntry[] | null;
};

/** Where an agent stands, in the words its row prints. */
export type AgentStatus =
  | 'active'
  | 'active · trading'
  | 'active · idle'
  | 'revoked · ready to return'
  | 'expired'
  | 'expired · ready to return';

export type AgentBalanceRow = {
  key: string;
  agentId: string;
  name: string;
  status: AgentStatus;
  /** Revoked or expired: drawn quieter. */
  over: boolean;
  /** What it holds, valued; `null` when its holdings could not be read. */
  value: Valuation | null;
};

export type AgentPositionRow = {
  key: string;
  agentId: string;
  agentName: string;
  symbol: string;
  base: string;
  side: 'long' | 'short';
  /** Perps only. */
  leverage: number | null;
  /** `Trend desk · entry 62,000`. */
  caption: string;
  value: string | null;
  unit: 'USDC' | 'AUSD';
  pnl: string | null;
  pct: number | null;
};

export type AgentClosedRow = {
  key: string;
  agentId: string;
  /** `WETH` for a spot trip, `BTC-PERP` for a perp. */
  title: string;
  direction: 'long' | 'short' | null;
  /** `+1.23 USDC`: realised, signed, in the asset it was settled in. */
  pnl: string;
  tone: Direction;
  /** `Trend desk · closed Oct 12 · held 2h 10m`. */
  caption: string;
  at: number;
};

export type AgentBook = {
  balances: AgentBalanceRow[];
  open: AgentPositionRow[];
  closed: AgentClosedRow[];
  /**
   * Everything the agents hold, per asset and in dollars at the headline's
   * prices: the allocation bar's "With agents". `null` with no agent read.
   */
  total: AllocationPart | null;
  /** Some agent's event log is still being read: closed trades may be missing. */
  closedPending: boolean;
};

export function agentBook(
  inputs: readonly AgentBookInput[],
  tickers: readonly TickerDto[],
  now: number,
): AgentBook {
  const balances: AgentBalanceRow[] = [];
  const open: AgentPositionRow[] = [];
  const closed: AgentClosedRow[] = [];
  const held: AssetAmount[][] = [];
  let read = 0;
  let closedPending = false;

  for (const { agent, portfolio, entries } of inputs) {
    const revoked = agent.status === 'revoked';
    const expired = !revoked && agent.mandate.expiresAt * 1000 <= now;
    const amounts = portfolio === null ? null : agentHoldingAmounts(portfolio);
    const positions = portfolio === null ? [] : agentPositions(agent, portfolio);
    if (amounts !== null) {
      read += 1;
      held.push(amounts);
    }
    const holds = amounts !== null && amounts.length > 0;
    const listed = !revoked || holds;
    if (listed) {
      balances.push({
        key: `agent:${agent.id}`,
        agentId: agent.id,
        name: agent.name,
        status: revoked
          ? 'revoked · ready to return'
          : expired
            ? holds
              ? 'expired · ready to return'
              : 'expired'
            : amounts === null
              ? 'active'
              : positions.length > 0
                ? 'active · trading'
                : 'active · idle',
        over: revoked || expired,
        value: amounts === null ? null : valuation(amounts, tickers),
      });
    }
    open.push(...positions);
    if (entries === null) closedPending = true;
    else closed.push(...closedRows(agent, entries));
  }

  closed.sort((a, b) => b.at - a.at);
  const amounts = addAmounts(...held);
  return {
    balances,
    open,
    closed,
    total: read > 0 ? { usd: valuation(amounts, tickers).usd, amounts } : null,
    closedPending,
  };
}

/**
 * Its Perpl positions (value = margin + unrealised P&L, in AUSD) and every Kuru
 * holding its event log explains (value at the mark, in USDC) — the same
 * "explained holdings only" rule the cockpit's `positionRows` follows, so the
 * wallet's gas MON is not an agent "position".
 */
function agentPositions(
  agent: AgentBookInput['agent'],
  portfolio: AgentPortfolioDto,
): AgentPositionRow[] {
  const rows: AgentPositionRow[] = [];
  const perpl = portfolio.perpl;
  if (perpl.ok && perpl.status === 'ok') {
    for (const p of perpl.positions) {
      rows.push({
        key: `${agent.id}:perpl:${p.symbol}:${p.side}`,
        agentId: agent.id,
        agentName: agent.name,
        symbol: p.symbol,
        base: baseOf(p.symbol),
        side: p.side,
        leverage: p.leverage,
        caption: `${agent.name} · entry ${p.entryPrice}`,
        value: sumOf([p.margin, p.unrealizedPnl]),
        unit: 'AUSD',
        pnl: p.unrealizedPnl,
        pct: ratio(p.unrealizedPnl, p.margin),
      });
    }
  }
  for (const h of portfolio.holdings) {
    if (!isPositive(h.costBasis.coveredSize)) continue;
    const { avgPrice, unrealizedPnl } = h.costBasis;
    const cost = avgPrice !== null ? mulDecimal(h.costBasis.coveredSize, avgPrice) : null;
    rows.push({
      key: `${agent.id}:kuru:${h.market}`,
      agentId: agent.id,
      agentName: agent.name,
      symbol: h.asset,
      base: h.asset,
      side: 'long',
      leverage: null,
      caption: avgPrice !== null ? `${agent.name} · entry ${avgPrice}` : agent.name,
      value: h.value,
      unit: 'USDC',
      pnl: unrealizedPnl,
      pct: unrealizedPnl !== null && cost !== null ? ratio(unrealizedPnl, cost) : null,
    });
  }
  return rows;
}

function closedRows(
  agent: AgentBookInput['agent'],
  entries: readonly LedgerEntry[],
): AgentClosedRow[] {
  return settledTrades(entries).map((trade) => {
    const market = trade.market ?? '—';
    const perp = /perp/iu.test(market);
    // A verdict that did not name its asset is in its venue's quote (SEN-210).
    const asset = trade.asset ?? (perp ? 'AUSD' : 'USDC');
    const parts = [
      agent.name,
      `closed ${shortDate(trade.at)}`,
      trade.holdMs !== null ? `held ${formatDuration(trade.holdMs)}` : null,
    ];
    return {
      key: `${agent.id}:${trade.seq}`,
      agentId: agent.id,
      title: perp ? market : baseOf(market),
      direction: trade.direction,
      pnl: signedAmountsText([{ asset, amount: trade.pnl }]),
      tone: signedFigure(trade.pnl, 2)?.tone ?? 'flat',
      caption: parts.filter((part) => part !== null).join(' · '),
      at: trade.at,
    };
  });
}
