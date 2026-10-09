/**
 * `GET /leaderboard` on the wire (SEN-26).
 *
 * Every field here is API surface: the mobile app prints them and the
 * definitions they carry are the point of the feature. `n` travels beside
 * every rate, `formula` is the exact string the app shows under the table, and
 * `source` says whether the numbers exist at all.
 *
 * Money crosses as decimal strings, exactly as it arrived from the indexer —
 * no float is ever formatted into a dollar figure here.
 */

/** Where the rows came from, and — when they did not — why not. */
export type LeaderboardSourceKind = 'ok' | 'unconfigured' | 'unreachable';

export interface LeaderboardSourceDto {
  readonly kind: LeaderboardSourceKind;
  /**
   * One plain sentence for the reader, set whenever `kind` is not `ok`. It
   * never contains the indexer's URL, which may carry a token.
   */
  readonly message?: string;
}

/**
 * The SEN-22 reading of the same agent, per thesis rather than per fill. A
 * thesis settles only when its own fills close it, so this denominator is NOT
 * `n` and the two are never divided into one another.
 */
export interface LeaderboardThesesDto {
  /** Theses with a settled verdict (a boolean `held`). */
  readonly settled: number;
  readonly held: number;
  /** Theses whose position has not come back to zero. */
  readonly open: number;
  /**
   * Present, and `true`, only when the event log has dropped some of the
   * agent's oldest events (SEN-159): the counts above then cover only the
   * theses still held, and a thesis whose opening fills were dropped may read
   * as settled or open wrongly. The indexer's `n` is unaffected.
   */
  readonly partial?: true;
}

/**
 * The agent's Perpl record, read from its own event log (SEN-171). The indexer
 * does not cover Perpl (see `LeaderboardCoverageDto`), so none of the row's
 * indexer figures — `n`, `winRate`, `realisedPnlUsd`, `roi` — include it, and
 * this block never feeds the ranking. Like `theses`, it is per thesis, not per
 * fill, and is never divided by `n`.
 */
export interface LeaderboardPerplDto {
  /** Where these figures come from: the agent's own trail, not the chain. */
  readonly source: 'agent-event-log';
  /** Perpl theses with a settled verdict. */
  readonly settled: number;
  readonly held: number;
  /** Perpl theses whose position has not come back to zero. */
  readonly open: number;
  /**
   * Exact decimal string, AUSD: the summed realised PnL of the settled Perpl
   * theses, net of fees and funding (`events/verdict.ts`). `'0'` when none has
   * settled — a fact about the log, which `settled` qualifies.
   */
  readonly realisedPnl: string;
  /** Present, and `true`, when the event log has dropped some of the agent's oldest events. */
  readonly partial?: true;
}

/** A venue the indexer does not cover, and why. */
export interface LeaderboardUnindexedVenueDto {
  readonly venue: string;
  /** One plain sentence for the reader. */
  readonly reason: string;
}

/**
 * Which venues the indexer's figures cover. `n`, win rate, realised PnL, ROI
 * and the ranking come from `indexed` venues only; a venue in `notIndexed` is
 * absent from them, never counted as zero.
 */
export interface LeaderboardCoverageDto {
  /** `kuru` today. */
  readonly indexed: string[];
  readonly notIndexed: LeaderboardUnindexedVenueDto[];
}

export interface LeaderboardRowDto {
  /** 1-based position among the ranked rows; `null` for an unranked one. */
  readonly rank: number | null;
  readonly agentId: string;
  readonly name: string;
  /** An OpenRouter model id, as `AGENT_MODELS` has it. */
  readonly model: string;
  /** One line: the venues, their markets, and the largest single order. */
  readonly mandate: string;
  /** The agent's own EOA, EIP-55 as the store holds it. */
  readonly address: string;
  /**
   * The indexer's venue enum (`KURU`, the only venue it covers since SEN-171)
   * for each account it holds for this wallet.
   */
  readonly venues: string[];
  /** `false` when the indexer holds no account for this address yet. */
  readonly indexed: boolean;
  /** Settled trades: `wins + losses`. The denominator of `winRate`. */
  readonly n: number;
  readonly wins: number;
  readonly losses: number;
  /** Every indexed fill, entries included — the sample behind `n`. */
  readonly fills: number;
  /** `wins / n`, 4dp. `null` when `n` is 0. */
  readonly winRate: number | null;
  /** Exact decimal string, quote units, signed. */
  readonly realisedPnlUsd: string;
  /** Exact decimal string: stablecoin net-deposited into the venues. */
  readonly capitalDeployedUsd: string;
  /** `realisedPnlUsd / capitalDeployedUsd`, 4dp. `null` with no capital to divide by. */
  readonly roi: number | null;
  readonly theses: LeaderboardThesesDto;
  /**
   * The agent's Perpl record from its own trail; `null` when its mandate does
   * not allow Perpl and its log holds no Perpl thesis.
   */
  readonly perpl: LeaderboardPerplDto | null;
}

export interface LeaderboardResponseDto {
  /**
   * Rows with at least `minTrades` settled trades, best first. These are
   * ranked; nothing else is.
   */
  readonly ranked: LeaderboardRowDto[];
  /**
   * Rows below `minTrades`, in the same order the ranking uses. Shown, never
   * ranked: at `n < 3` a win rate is noise, and a board that orders noise
   * teaches its readers to trust it.
   */
  readonly tooFewTrades: LeaderboardRowDto[];
  /** The published definitions, verbatim. Printed under the table. */
  readonly formula: string;
  /** Everything a reader needs in order not to misread the numbers above. */
  readonly notes: string[];
  /** The settled-trade count a row needs to be ranked: `MIN_RANKED_TRADES`. */
  readonly minTrades: number;
  readonly source: LeaderboardSourceDto;
  /** Which venues the indexer's figures cover, and why the rest are not. */
  readonly coverage: LeaderboardCoverageDto;
  /** ISO 8601. The indexer is read live on every request, so this is also the age. */
  readonly generatedAt: string;
}
