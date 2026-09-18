/**
 * The leaderboard's numbers (SEN-26), as pure functions of what the indexer
 * reported and nothing else.
 *
 * Three definitions, and the whole point of this module is that they are
 * DEFINITIONS rather than whatever the code happens to do:
 *
 * | Metric    | Definition                                                    |
 * | --------- | ------------------------------------------------------------- |
 * | `n`       | settled trades — the fills that closed a position            |
 * | win rate  | `wins / n`                                                    |
 * | ROI       | realised PnL / capital deployed                               |
 *
 * `n` is the indexer's `wins + losses`: it counts each *reducing* fill by the
 * sign of the delta it produced (`docs/indexer.md` §pnl), which is exactly "a
 * trade whose result is known". A win rate without it is a lie, so every row
 * carries both and `MIN_RANKED_TRADES` decides whether the rate is shown as a
 * rank or as a note.
 *
 * ROI is the one number here that is not a direct read: the indexer stores
 * **flows** (`AccountBalance.net` = deposited − withdrawn) and **balances**
 * separately, and only the flow is capital. Money the agent put into the venue
 * and has not taken back out is what was at risk; a balance that has since
 * grown is the result of the bet, not the size of it, and storing it as the
 * denominator would make every winning agent's ROI shrink the more it won.
 *
 * Every sum is exact: decimals are BigInt with a scale, never `Number`. A
 * ratio is the one place a float appears, and only after the digit has been
 * decided in integers (`ratioOf`, `winRateOf`).
 *
 * Mixed units, stated plainly: Kuru's PnL is USDC and Perpl's is AUSD, both
 * 6-decimal stables on Monad testnet, and the indexer's own `*Usd` field names
 * treat them as one unit. This module sums them the same way, and the API
 * returns a note saying so.
 *
 * **Two unit domains arrive here and exactly one leaves** (SEN-32). The
 * indexer's `*Usd` fields are `BigDecimal!` — human units already — while
 * every `AccountBalance` amount is `BigInt!` RAW TOKEN ATOMS. Summing a raw
 * `net` into the same total as `realizedPnlUsd` put 25 USDC on the board as
 * "25,000,000.00" and made every ROI round to 0%. `capitalOfAccount` is
 * therefore the seam: it divides each atom count by its token's decimals
 * (exactly, by giving the BigInt a scale — no division, no float) before a
 * single addition happens, so everything downstream is in quote units.
 */
import { KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { PERPL_COLLATERAL_DECIMALS, PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';

import type { IndexerAccount } from './indexer';

/**
 * Settled trades an agent needs before its win rate is ranked at all. Below
 * this the row is still returned — hiding it would hide the work — but under
 * a "too few trades" heading, never in the order.
 */
export const MIN_RANKED_TRADES = 3;

/**
 * The published definitions, as one string, returned by the API and printed
 * verbatim under the table. One source, so the UI cannot paraphrase it.
 */
export const FORMULA =
  'n = settled trades (wins + losses) · win rate = wins ÷ n · ROI = realised PnL ÷ capital deployed';

/**
 * What counts as capital, BY ADDRESS: the stablecoin quote each venue settles
 * in — Kuru's testnet USDC and Perpl's AUSD collateral — mapped to the decimals
 * its raw atoms are denominated in. Lowercase, because the indexer keys token
 * addresses lowercase (`schema.graphql`).
 *
 * An allowlist rather than "any 6-decimal token" (SEN-32): Kuru lists XAUt, a
 * 6-decimal token that is tokenised gold, not a dollar. Counting a gold balance
 * as USD capital would silently deflate that agent's ROI by whatever gold
 * trades at. MON (18) is gas an agent spends, not collateral it risks, and is
 * excluded for its own reason. A venue that adds a stable quote must be added
 * here or its capital reads as zero — loud in the ROI column, and the right way
 * round: a missing denominator shows as `null`, never as a wrong number.
 */
export const CAPITAL_TOKENS: ReadonlyMap<string, number> = new Map([
  [KURU_TESTNET_TOKENS.USDC.address.toLowerCase(), KURU_TESTNET_TOKENS.USDC.decimals],
  [PERPL_TESTNET_CONTRACTS.collateral.toLowerCase(), PERPL_COLLATERAL_DECIMALS],
]);

export interface LeaderboardMetrics {
  /** Settled trades: `wins + losses`, the denominator of the win rate. */
  readonly n: number;
  readonly wins: number;
  readonly losses: number;
  /** Every fill the indexer attributed to the agent, entries included. */
  readonly fills: number;
  /** Exact decimal string, quote units, signed. */
  readonly realisedPnlUsd: string;
  /**
   * Exact decimal string, quote units: stablecoin net-deposited into the
   * venues, rescaled out of the raw atoms the indexer stores. Trailing zeros
   * are trimmed, so 25 USDC is `'25'`; the screen's `amountLabel` is what
   * prints it as `25.00`.
   */
  readonly capitalDeployedUsd: string;
  /** `wins / n`, 4dp. `null` when nothing has settled: 0/0 is not a rate. */
  readonly winRate: number | null;
  /** `realisedPnlUsd / capitalDeployedUsd`, 4dp. `null` when no capital was deployed. */
  readonly roi: number | null;
}

/** One agent's metrics, summed over every venue account its wallet owns. */
export function metricsOf(accounts: readonly IndexerAccount[]): LeaderboardMetrics {
  let wins = 0;
  let losses = 0;
  let fills = 0;
  let realised = scaled('0');
  let capital = scaled('0');

  for (const account of accounts) {
    wins += account.winningTradeCount;
    losses += account.losingTradeCount;
    fills += account.totalTradeCount;
    realised = add(realised, scaled(account.realizedPnlUsd));
    capital = add(capital, capitalOfAccount(account));
  }

  // A negative net means the agent took more out of the venue than it put in —
  // an artefact of a partial sync, not a negative bet. Clamping keeps a sign
  // flip out of every ROI on the board; `roi` then reads "no capital deployed".
  const deployed = capital.units < 0n ? ZERO : capital;
  const n = wins + losses;

  return {
    n,
    wins,
    losses,
    fills,
    realisedPnlUsd: decimalString(realised),
    capitalDeployedUsd: decimalString(deployed),
    winRate: winRateOf(wins, n),
    roi: ratioOf(realised, deployed),
  };
}

/**
 * Capital deployed on one venue account: the net stablecoin flow, converted
 * from raw atoms into quote units. Balances the venue reports
 * (`freeRaw`/`reservedRaw`) are deliberately not used; see the module doc.
 *
 * The token's decimals come from `CAPITAL_TOKENS`, not from the row's own
 * `decimals`: the allowlist already decided this address is a dollar, and the
 * scale of a known token is a fact about the token, not a field to be trusted
 * from a response.
 */
function capitalOfAccount(account: IndexerAccount): Scaled {
  let capital = scaled('0');
  for (const balance of account.balances) {
    const decimals = CAPITAL_TOKENS.get(balance.token.toLowerCase());
    if (decimals === undefined) continue;
    capital = add(capital, atoms(balance.net, decimals));
  }
  return capital;
}

// ---------------------------------------------------------------------------
// Ranking. The n < MIN_RANKED_TRADES rule and the order are the same rule, so
// they live together.

/** What `compareRows` needs. Both the ranked and the unranked lists use it. */
export interface Rankable {
  readonly n: number;
  readonly winRate: number | null;
  readonly roi: number | null;
  readonly name: string;
}

/** `true` when the row has enough settled trades to be ranked at all. */
export function isRankable(row: Rankable): boolean {
  return row.n >= MIN_RANKED_TRADES;
}

/**
 * ROI first, and a row with no ROI (no capital deployed, so nothing to divide
 * by) sorts below every row that has one. Then win rate, then `n` — a bigger
 * sample outranks a smaller one at the same rate — then name, so the order is
 * total and never depends on the order the store happened to return.
 */
export function compareRows(a: Rankable, b: Rankable): number {
  return (
    descending(a.roi, b.roi) ||
    descending(a.winRate, b.winRate) ||
    b.n - a.n ||
    a.name.localeCompare(b.name)
  );
}

/** Higher first; `null` is last of all. */
function descending(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

// ---------------------------------------------------------------------------
// Exact signed decimals: BigInt with a scale. A LOCAL copy on purpose — the
// same shape `events/verdict.ts` uses and for the same reason (every other
// decimal helper in the repo is exact only for non-negative values, and a
// loss, a withdrawal and a negative net are all signed). Neither module
// exports it, so neither can be changed out from under the other.

interface Scaled {
  readonly units: bigint;
  readonly scale: number;
}

const ZERO: Scaled = { units: 0n, scale: 0 };
const DECIMAL = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;

/** `wins / n`, rounded half up at 4dp, decided in integers. */
function winRateOf(wins: number, n: number): number | null {
  if (n <= 0) return null;
  const parts = (BigInt(wins) * 20_000n + BigInt(n)) / (BigInt(n) * 2n);
  return Number(parts) / 10_000;
}

/** `numerator / denominator`, rounded half up at `places`, decided in integers. */
function ratioOf(numerator: Scaled, denominator: Scaled, places = 4): number | null {
  if (denominator.units === 0n) return null;
  const factor = 10n ** BigInt(places);
  const top = numerator.units * 10n ** BigInt(denominator.scale) * factor;
  const bottom = denominator.units * 10n ** BigInt(numerator.scale);
  const negative = top < 0n !== bottom < 0n;
  const magnitude = top < 0n ? -top : top;
  const divisor = bottom < 0n ? -bottom : bottom;
  // Half up: (2a + b) / 2b truncates to the nearest, ties going away from zero.
  const parts = (magnitude * 2n + divisor) / (divisor * 2n);
  return (negative ? -1 : 1) * (Number(parts) / 10 ** places);
}

/** A decimal the indexer is expected to have sent. Throws rather than counting it as 0. */
function scaled(value: string): Scaled {
  if (!DECIMAL.test(value)) {
    throw new Error(`leaderboard: not a decimal: ${JSON.stringify(value)}`);
  }
  const negative = value.startsWith('-');
  const magnitude = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = magnitude.split('.');
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

/**
 * Raw token atoms (`BigInt!` on the wire) as a quote-unit decimal: `value /
 * 10^decimals`, and exact because the division is only a change of scale.
 * Throws rather than counting an unparseable balance as 0, like `scaled`.
 */
function atoms(value: string, decimals: number): Scaled {
  if (!INTEGER.test(value)) {
    throw new Error(`leaderboard: not an integer amount of atoms: ${JSON.stringify(value)}`);
  }
  return { units: BigInt(value), scale: decimals };
}

function rescaled(value: Scaled, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function add(a: Scaled, b: Scaled): Scaled {
  const scale = Math.max(a.scale, b.scale);
  return { units: rescaled(a, scale) + rescaled(b, scale), scale };
}

/** Back to a decimal string, trailing zeros trimmed. */
function decimalString(value: Scaled): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
