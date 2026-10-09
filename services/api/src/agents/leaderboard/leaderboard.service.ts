/**
 * The leaderboard (SEN-26): who is actually making money, on evidence.
 *
 * Three sources, joined on the agent's own wallet address:
 *
 * 1. **The indexer** (SEN-25) — `Account` rollups per Kuru account. This is
 *    the authority on settled performance: `wins + losses` is `n`, and
 *    `realizedPnlUsd` is in the quote units the chain produced. It covers
 *    Kuru only (SEN-171): Perpl's event volume does not fit the Envio plan it
 *    runs on, so `LEADERBOARD_COVERAGE` names Perpl as not indexed and why.
 * 2. **The event log** (SEN-22) — the agent's own theses, settled. A separate
 *    reading with its own denominator: per thesis, not per fill. It is also
 *    where a row's Perpl figures come from, in their own block (`perpl`),
 *    since the indexer has none.
 * 3. **The agent store** — name, model and what the mandate allows, so a row
 *    is attributable to a person and to a limit.
 *
 * Two rules the plan asks for, and where each is enforced:
 *
 * - **`n` beside every win rate**: `metricsOf` returns the pair together and
 *   the DTO has no field for one without the other.
 * - **`n < 3` is not ranked**: `isRankable` splits the response into `ranked`
 *   and `tooFewTrades`. The unranked rows are returned, not hidden — the work
 *   is real, it is the ORDER that would be a lie.
 *
 * Read-only. It never writes to the indexer, the log or the store.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AGENT_EVENTS, type AgentEventLog } from '../events/agent-event-log';
import { addScaled, decimalOf, decimalString, settle, type Verdict } from '../events/verdict';
import { AGENT_STORE, type AgentRecord, type AgentStore } from '../store/agent-store';
import {
  INDEXER_STATS,
  IndexerQueryError,
  IndexerUnconfiguredError,
  type IndexerAccount,
  type IndexerStats,
} from './indexer';
import type {
  LeaderboardCoverageDto,
  LeaderboardPerplDto,
  LeaderboardResponseDto,
  LeaderboardRowDto,
  LeaderboardSourceDto,
  LeaderboardThesesDto,
} from './leaderboard.dto';
import { summariseMandate } from './mandate-summary';
import { FORMULA, MIN_RANKED_TRADES, compareRows, isRankable, metricsOf } from './metrics';

/**
 * Why Perpl is not in the indexer's figures (SEN-171), measured on 2026-10-09.
 * One sentence, shown to the reader both as a note and on `coverage`.
 */
export const PERPL_NOT_INDEXED_REASON =
  'Perpl is not indexed: its exchange emits about 216,000 events an hour, and the Envio plan ' +
  'the indexer runs on stops at 100,000 events in total. So n, win rate, realised PnL and ROI ' +
  'are Kuru only, and an agent’s Perpl record is shown separately, from its own trail.';

/** What the indexer's figures cover. One constant, so the wire and the notes agree. */
export const LEADERBOARD_COVERAGE: LeaderboardCoverageDto = {
  indexed: ['kuru'],
  notIndexed: [{ venue: 'perpl', reason: PERPL_NOT_INDEXED_REASON }],
};

/**
 * The definitions, as lines under the table. Kept as an ordered constant so
 * the wire response, the screen and `docs/leaderboard.md` cannot drift.
 */
export const LEADERBOARD_NOTES: readonly string[] = [
  'n counts settled Kuru trades: the fills that closed a position (the indexer’s wins + losses). An ' +
    'agent needs at least 3 of them to be ranked; below that a win rate is noise, so the row is ' +
    'shown under “too few trades” instead of ordered.',
  'ROI is realised PnL ÷ capital deployed, where capital deployed is the USDC net-deposited ' +
    'into Kuru, converted from raw token units to dollars. MON is gas, never capital, and XAUt — ' +
    'a 6dp token that is gold, not a dollar — is not capital either. Fees are not netted out of ' +
    'realised PnL.',
  'Theses held is a separate reading, from the agent’s own trail: a thesis settles only when its ' +
    'own fills close it, whichever run the close lands in. It is counted per thesis and is never ' +
    'divided by n. A thesis’s own PnL IS net of fees, on Kuru and on Perpl alike — the opposite ' +
    'of realised PnL above, which is the indexer’s gross figure.',
  PERPL_NOT_INDEXED_REASON + ' Its PnL is AUSD and is never added to the Kuru USDC figure.',
  'Monad testnet samples are thin. A win rate over four trades is a fact about four trades.',
];

/** Row facts, before the SEN-22 reading and the order are attached. */
type RowFacts = Omit<LeaderboardRowDto, 'rank' | 'theses' | 'perpl'>;

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_EVENTS) private readonly events: AgentEventLog,
    @Inject(INDEXER_STATS) private readonly indexer: IndexerStats,
  ) {}

  /**
   * Every active agent, ranked. Revoked agents are left out on purpose: their
   * mandate is empty, so they cannot trade again, and a board is a statement
   * about who is competing.
   */
  async leaderboard(): Promise<LeaderboardResponseDto> {
    const agents = await this.store.listActive();

    let accounts: IndexerAccount[];
    try {
      accounts = await this.indexer.accountsFor(agents.map((agent) => agent.address));
    } catch (error) {
      this.logger.warn(`no leaderboard: ${error instanceof Error ? error.message : String(error)}`);
      return this.empty(sourceOf(error));
    }

    const byAddress = indexAccounts(accounts);
    const rows: Omit<LeaderboardRowDto, 'rank'>[] = [];
    for (const agent of agents) {
      rows.push({
        ...factsOf(agent, byAddress.get(agent.address.toLowerCase()) ?? []),
        ...(await this.trailOf(agent)),
      });
    }

    const ranked = rows
      .filter((row) => isRankable(row))
      .sort(compareRows)
      .map((row, index) => ({ ...row, rank: index + 1 }));
    // Same order, no rank: the unranked list is not a second table, it is the
    // part of the first one that has nothing to rank yet.
    const tooFewTrades = rows
      .filter((row) => !isRankable(row))
      .sort(compareRows)
      .map((row) => ({ ...row, rank: null }));

    return {
      ranked,
      tooFewTrades,
      formula: FORMULA,
      notes: [...LEADERBOARD_NOTES],
      minTrades: MIN_RANKED_TRADES,
      source: { kind: 'ok' },
      coverage: LEADERBOARD_COVERAGE,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * The SEN-22 reading, and the Perpl record cut from the same verdicts.
   * `settle` is a pure function of the events already in the log, so a restart
   * empties this and leaves the indexer's numbers standing — which is why `n`
   * does not come from here. Past the log's cap it is partial too, and says so
   * (SEN-159).
   */
  private async trailOf(
    agent: AgentRecord,
  ): Promise<{ theses: LeaderboardThesesDto; perpl: LeaderboardPerplDto | null }> {
    const [events, truncation] = await Promise.all([
      this.events.list(agent.id),
      this.events.truncation(agent.id),
    ]);
    const verdicts = settle(events);
    const partial = truncation.evicted > 0 ? { partial: true as const } : {};
    const perplVerdicts = verdicts.filter((verdict) => verdict.venue === 'perpl');
    const tradesPerpl = agent.mandate.venues.includes('perpl') || perplVerdicts.length > 0;
    return {
      theses: { ...tally(verdicts), ...partial },
      perpl: tradesPerpl
        ? {
            source: 'agent-event-log',
            ...tally(perplVerdicts),
            realisedPnl: settledPnl(perplVerdicts),
            ...partial,
          }
        : null,
    };
  }

  /**
   * An empty board that says why. Rows are NOT shown with zeros: "0 trades"
   * and "we could not read the indexer" are different claims, and only one of
   * them is about the agent.
   */
  private empty(source: LeaderboardSourceDto): LeaderboardResponseDto {
    return {
      ranked: [],
      tooFewTrades: [],
      formula: FORMULA,
      notes: [...LEADERBOARD_NOTES, ...(source.message === undefined ? [] : [source.message])],
      minTrades: MIN_RANKED_TRADES,
      source,
      coverage: LEADERBOARD_COVERAGE,
      generatedAt: new Date().toISOString(),
    };
  }
}

/** Settled, held and still-open counts over a set of verdicts. */
function tally(verdicts: readonly Verdict[]): { settled: number; held: number; open: number } {
  let settled = 0;
  let held = 0;
  let open = 0;
  for (const verdict of verdicts) {
    if (verdict.held === 'open') {
      open += 1;
      continue;
    }
    settled += 1;
    if (verdict.held) held += 1;
  }
  return { settled, held, open };
}

/**
 * The summed realised PnL of the settled verdicts, exact. An open thesis's
 * partial figure is left out: `held` has not judged it, so neither does this.
 */
function settledPnl(verdicts: readonly Verdict[]): string {
  let total = { units: 0n, scale: 0 };
  for (const verdict of verdicts) {
    if (verdict.held === 'open') continue;
    const pnl = decimalOf(verdict.realisedPnl);
    if (pnl !== undefined) total = addScaled(total, pnl);
  }
  return decimalString(total);
}

/** Name, mandate and the metrics of whatever the indexer holds for this wallet. */
function factsOf(agent: AgentRecord, accounts: readonly IndexerAccount[]): RowFacts {
  const metrics = metricsOf(accounts);
  return {
    agentId: agent.id,
    name: agent.name,
    model: agent.model,
    mandate: summariseMandate(agent.mandate),
    address: agent.address,
    venues: [...new Set(accounts.map((account) => account.venue))].sort(),
    indexed: accounts.length > 0,
    n: metrics.n,
    wins: metrics.wins,
    losses: metrics.losses,
    fills: metrics.fills,
    winRate: metrics.winRate,
    realisedPnlUsd: metrics.realisedPnlUsd,
    capitalDeployedUsd: metrics.capitalDeployedUsd,
    roi: metrics.roi,
  };
}

/** Accounts grouped by lowercase address. An account with no address cannot be matched. */
function indexAccounts(accounts: readonly IndexerAccount[]): Map<string, IndexerAccount[]> {
  const byAddress = new Map<string, IndexerAccount[]>();
  for (const account of accounts) {
    if (account.address === null) continue;
    const key = account.address.toLowerCase();
    const found = byAddress.get(key);
    if (found) found.push(account);
    else byAddress.set(key, [account]);
  }
  return byAddress;
}

/**
 * The two ways a board can fail to exist, as the reader sees them. The
 * unconfigured one is a deployment fact; the unreachable one is a fault, and
 * it is logged in full (by the caller) rather than echoed into the response.
 */
function sourceOf(error: unknown): LeaderboardSourceDto {
  if (error instanceof IndexerUnconfiguredError) {
    return {
      kind: 'unconfigured',
      message:
        'No indexer is configured (ENVIO_GRAPHQL_URL is unset), so no fills are indexed and ' +
        'nothing can be ranked. See docs/leaderboard.md.',
    };
  }
  if (error instanceof IndexerQueryError) {
    return {
      kind: 'unreachable',
      message:
        `The indexer could not be read (${error.message}), so no rows are shown rather than ` +
        'rows we cannot verify.',
    };
  }
  throw error;
}
