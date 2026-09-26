/**
 * What the Home tab shows about the user's agents (SEN-57): which ones make
 * the short list, what each one's status pill says, its figures, and the
 * newest event as one sentence.
 *
 * Plain node, no React Native, so `home.test.ts` pins every choice without a
 * device. The screen only lays these out.
 *
 * The latest move is built from the Ledger's own mapping (`toLedgerEntries`),
 * not from `detail` again: an event the Ledger does not show must not show up
 * on Home either, and a second parser is a second place for the two to drift.
 */
import { formatFixedAtoms } from './amounts.ts';
import type { ActivityEvent, Agent, AgentSummary } from './api.ts';
import {
  depositAmount,
  directionLabel,
  heldLabel,
  signedPnl,
  toLedgerEntries,
  venueLabel,
  type EventConsensus,
  type LedgerEntry,
} from './ledger.ts';
import { stoneFor, type LedgerStone } from './ledgerView.ts';
import { isTrading, relativeAge } from './usage.ts';

/** Home shows at most this many agents; "See all" has the rest. */
export const HOME_AGENT_LIMIT = 3;

/**
 * The short list: active agents before revoked ones, and the most recently
 * busy first within each, so the agent doing something right now is the one
 * on screen. `Array.prototype.sort` is stable, so ties keep the API's order.
 */
export function homeAgents(
  agents: readonly Agent[],
  summaries: ReadonlyMap<string, AgentSummary>,
  limit: number = HOME_AGENT_LIMIT,
): Agent[] {
  const lastAt = (agent: Agent) => summaries.get(agent.id)?.lastEvent?.at ?? 0;
  return [...agents]
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return lastAt(b) - lastAt(a);
    })
    .slice(0, limit);
}

export type AgentPill = { label: string; tone: 'live' | 'idle' | 'revoked' };

/**
 * The agent's status in two words. `live` breathes, and it only means "running
 * right now", so it needs a recent event to back it — an active mandate alone
 * is `Watching`. With no summary (an API that predates SEN-56) there is no
 * evidence either way, and the calmer claim wins.
 */
export function agentPill(
  agent: Pick<Agent, 'status'>,
  summary: Pick<AgentSummary, 'lastEvent'> | undefined,
  now: number,
): AgentPill {
  if (agent.status === 'revoked') return { label: 'Revoked', tone: 'revoked' };
  return isTrading(summary, now)
    ? { label: 'Trading', tone: 'live' }
    : { label: 'Watching', tone: 'idle' };
}

/**
 * The 24h P&L line under an agent's balance: `+18.22 today`, mint or berry.
 * `null` when there is no summary to read it from, so the row shows nothing
 * rather than a zero it does not know.
 */
export function pnlToday(
  summary: Pick<AgentSummary, 'pnl'> | undefined,
): { label: string; tone: 'up' | 'down' | null } | null {
  if (!summary) return null;
  const value = Number(summary.pnl.last24h);
  if (!Number.isFinite(value) || value === 0) return { label: 'Flat today', tone: null };
  return { label: `${signedPnl(summary.pnl.last24h)} today`, tone: value > 0 ? 'up' : 'down' };
}

/**
 * An agent's stablecoin balance as one figure — USDC and AUSD summed as one
 * quote unit, the same way the summaries sum P&L — to two places, truncated
 * like every balance in the app. `null` while the chain has not answered.
 */
export function stableBalance(
  balances: Readonly<Record<string, bigint>> | null,
  tokens: readonly { symbol: string; decimals: number }[],
): string | null {
  if (balances === null) return null;
  const decimals = Math.max(0, ...tokens.map((token) => token.decimals));
  const total = tokens.reduce(
    (sum, token) => sum + (balances[token.symbol] ?? 0n) * 10n ** BigInt(decimals - token.decimals),
    0n,
  );
  return formatFixedAtoms(total, decimals, { places: 2 });
}

/** Which stone a move gets: the Ledger's own (`ledgerView.stoneFor`). */
export type MoveStone = LedgerStone;

export type LatestMove = {
  agentId: string;
  at: number;
  stone: MoveStone;
  /** One line, the agent as its subject: `Range Hunter bought 180 MON-USDC`. */
  title: string;
  /** The line under it, or `null` when there is nothing worth a second line. */
  detail: string | null;
  /** Set when the event names a block, so the screen can draw the ramp. */
  block: { number: number; consensus: EventConsensus | null } | null;
};

/**
 * The newest event as a Home row, or `null` when the Ledger would not show it
 * (a run summary, a filled `order` whose `fill` says it better) — the section
 * is then left out rather than showing something half-read.
 */
export function latestMove(event: ActivityEvent): LatestMove | null {
  const [entry] = toLedgerEntries([event]);
  if (!entry) return null;
  return {
    agentId: event.agentId,
    at: entry.at,
    ...describe(entry, event.agentName),
    block: blockOf(entry),
  };
}

function describe(
  entry: LedgerEntry,
  name: string,
): { stone: MoveStone; title: string; detail: string | null } {
  switch (entry.kind) {
    case 'trade': {
      if (!entry.filled) {
        return {
          stone: 'trade',
          title: `${name}’s ${entry.market} order did not fill`,
          detail: entry.status,
        };
      }
      const verb =
        entry.direction === 'long' ? 'bought' : entry.direction === 'short' ? 'sold' : 'traded';
      const where = [
        entry.price !== null ? `at ${entry.price}` : null,
        entry.leverage !== null ? `${entry.leverage}×` : null,
        entry.venue !== null ? `on ${venueLabel(entry.venue)}` : null,
      ].filter((part): part is string => part !== null);
      return {
        stone: 'trade',
        title: `${name} ${verb} ${entry.size} ${entry.market}`,
        detail: where.length > 0 ? where.join(' ') : null,
      };
    }
    case 'thesis':
      return {
        stone: 'thesis',
        title: `${name} wrote a thesis`,
        detail:
          entry.direction !== null
            ? `${directionLabel(entry.direction)} · ${entry.market}`
            : entry.market,
      };
    case 'refusal':
      return {
        stone: 'refusal',
        title:
          entry.layer === 'enclave'
            ? `The enclave held ${name} to its mandate`
            : `Sente stopped an order from ${name}`,
        detail: entry.message || entry.code,
      };
    case 'verdict': {
      return {
        stone: stoneFor(entry),
        title:
          entry.market !== null ? `${name} closed ${entry.market}` : `${name} closed a position`,
        detail: `${signedPnl(entry.pnl)} · ${heldLabel(entry.held)}`,
      };
    }
    case 'deposit':
      return {
        stone: 'deposit',
        title: `${name} received ${depositAmount(entry)}${entry.asset !== null ? ` ${entry.asset}` : ''}`,
        detail: null,
      };
  }
}

function blockOf(entry: LedgerEntry): LatestMove['block'] {
  if (entry.kind === 'thesis' || entry.kind === 'refusal') return null;
  if (entry.blockNumber === null) return null;
  return { number: entry.blockNumber, consensus: entry.consensus };
}

/** `now`, `4m ago`, `3h ago`, `2d ago`. Coarse on purpose: it is a glance, not a record. */
export function sinceLabel(at: number, now: number): string {
  const age = relativeAge(at, now);
  return age === 'now' ? age : `${age} ago`;
}
