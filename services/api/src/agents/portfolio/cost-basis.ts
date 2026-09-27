/**
 * Spot cost basis from the agent event log (SEN-66, plan B-T8).
 *
 * A pure function of the `fill` events the gate recorded: FIFO over the
 * agent's Kuru fills on one market, across every run and thesis. Unlike
 * `settle()` in `events/verdict.ts` this is not per thesis: the portfolio asks
 * what the base the agent HOLDS cost, and that is the whole history of the
 * market, not one idea's slice of it.
 *
 * The log is a PARTIAL account of a holding (plan finding #4): the gate records
 * a fill only at placement, so a resting limit that fills later never shows up,
 * and base the user funded the account with has no cost here at all.
 * `reconcileHolding` therefore sets the log against what the chain says is held
 * and reports how much of it the log explains, rather than pretending to know.
 *
 * Arithmetic is exact bigint fixed point, never `Number`. Sizes and prices are
 * 18 dp (Kuru's `ratioToDecimal` scale, and no token has more decimals), so a
 * size x price product is exact at 36 dp; money is carried at 36 dp and only
 * rounded (towards zero) to 18 dp when it is written out.
 */
import type { Decimal } from '@sente/venues';

import type { AgentEvent } from '../events/agent-event-log';

export interface CostBasis {
  readonly market: string;
  /** Base still held from the logged buys, after FIFO sells. */
  readonly openSize: Decimal;
  /** `costQuote / openSize`, 18 dp; `null` when nothing is open. */
  readonly avgPrice: Decimal | null;
  /** Quote paid for `openSize`, quote-denominated buy fees included. */
  readonly costQuote: Decimal;
  /** Quote realised by the sells that matched a lot, net of quote-denominated sell fees. Signed. */
  readonly realisedPnl: Decimal;
  /** Sold size with no logged lot behind it: base whose cost this log never saw. */
  readonly unmatchedSellSize: Decimal;
  /** Kuru fills on this market that were read, parsable or not. */
  readonly fills: number;
}

export interface HoldingReconciliation {
  /** The part of the held base the log's open lots account for. */
  readonly coveredSize: Decimal;
  /** Held base the log cannot explain: user deposits, fills recorded nowhere. */
  readonly uncoveredSize: Decimal;
  /** Average entry of the covered part; `null` when nothing is covered. */
  readonly avgPrice: Decimal | null;
  /** `(mark - avgPrice) x coveredSize`, signed; `null` without a mark or a covered size. */
  readonly unrealizedPnl: Decimal | null;
  /** `true` only when the log explains every unit held. */
  readonly complete: boolean;
}

const SCALE = 18n;
const ONE = 10n ** SCALE;
const UNSIGNED_DECIMAL = /^\d+(\.\d{1,18})?$/;

interface Lot {
  /** Base, 18 dp. */
  size: bigint;
  /** Quote paid for `size`, fee included, 36 dp. */
  cost: bigint;
}

export function fifoCostBasis(events: readonly AgentEvent[], market: string): CostBasis {
  // The quote side of the symbol (`MON-USDC` -> USDC), the same reading
  // `verdict.ts` uses: a fee is only money in this ledger when it is in quote.
  const quote = market.split('-')[1];
  const lots: Lot[] = [];
  let realised = 0n;
  let unmatched = 0n;
  let fills = 0;

  const ordered = events
    .filter(
      (e) => e.kind === 'fill' && e.detail['venue'] === 'kuru' && e.detail['symbol'] === market,
    )
    .sort((a, b) => a.seq - b.seq);

  for (const event of ordered) {
    fills += 1;
    const side = event.detail['side'];
    const size = fixedOf(event.detail['filledSize']);
    const price = fixedOf(event.detail['averageFillPrice']);
    if (size === undefined || price === undefined || size === 0n) continue;
    if (side !== 'buy' && side !== 'sell') continue;

    const fee = fixedOf(event.detail['fee']);
    // A fee in base (or an unnamed asset) is not quote spent, and pricing it
    // would be a guess about which way the venue took it; only quote fees count.
    const quoteFee =
      fee !== undefined && quote !== undefined && event.detail['feeAsset'] === quote
        ? fee * ONE
        : 0n;

    if (side === 'buy') {
      lots.push({ size, cost: size * price + quoteFee });
      continue;
    }

    let remaining = size;
    let matchedCost = 0n;
    while (lots.length > 0 && remaining > 0n) {
      const lot = lots[0]!;
      const taken = lot.size <= remaining ? lot.size : remaining;
      // A whole lot leaves with its exact cost; a partial one pro rata, so the
      // rounding stays in the lot that is still open instead of piling up.
      const cost = taken === lot.size ? lot.cost : (lot.cost * taken) / lot.size;
      matchedCost += cost;
      lot.size -= taken;
      lot.cost -= cost;
      remaining -= taken;
      if (lot.size === 0n) lots.shift();
    }
    const matched = size - remaining;
    unmatched += remaining;
    // Only the matched part realises anything: the rest has no cost in this
    // log. The quote fee is split the same way, so an unmatched sell does not
    // charge its whole fee to lots it never touched.
    const matchedFee = matched === size ? quoteFee : (quoteFee * matched) / size;
    realised += matched * price - matchedCost - matchedFee;
  }

  const openSize = lots.reduce((sum, lot) => sum + lot.size, 0n);
  const cost = lots.reduce((sum, lot) => sum + lot.cost, 0n);
  return {
    market,
    openSize: fixedString(openSize),
    avgPrice: openSize === 0n ? null : fixedString(cost / openSize),
    costQuote: moneyString(cost),
    realisedPnl: moneyString(realised),
    unmatchedSellSize: fixedString(unmatched),
    fills,
  };
}

/**
 * Set the log's cost basis against the base actually held. The log can only
 * answer for up to `openSize`; anything held beyond it is `uncoveredSize` and
 * makes the result incomplete. Holding LESS than the log says (a withdrawal,
 * a sell recorded nowhere) is still complete: every unit held is explained, at
 * the log's average entry.
 */
export function reconcileHolding(
  basis: CostBasis,
  heldSize: Decimal,
  mark: Decimal | null,
): HoldingReconciliation {
  const held = requireFixed(heldSize, 'heldSize');
  const open = requireFixed(basis.openSize, 'openSize');
  const covered = held < open ? held : open;
  const uncovered = held - covered;
  const avg =
    covered > 0n && basis.avgPrice !== null ? requireFixed(basis.avgPrice, 'avgPrice') : undefined;
  const markPrice = mark === null ? undefined : requireFixed(mark, 'mark');
  return {
    coveredSize: fixedString(covered),
    uncoveredSize: fixedString(uncovered),
    avgPrice: avg === undefined ? null : fixedString(avg),
    unrealizedPnl:
      avg === undefined || markPrice === undefined
        ? null
        : moneyString((markPrice - avg) * covered),
    complete: uncovered === 0n,
  };
}

/** A non-negative decimal of at most 18 dp as 18-dp units; `undefined` otherwise. */
function fixedOf(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !UNSIGNED_DECIMAL.test(value)) return undefined;
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(Number(SCALE), '0'));
}

function requireFixed(value: Decimal, name: string): bigint {
  const fixed = fixedOf(value);
  if (fixed === undefined)
    throw new RangeError(`reconcileHolding: ${name} "${value}" is not a decimal`);
  return fixed;
}

/** Money is size x price, so it carries 36 dp until it is written out here. */
function moneyString(units: bigint): Decimal {
  // BigInt division truncates towards zero, which is the rounding promised above.
  return fixedString(units / ONE);
}

function fixedString(units: bigint): Decimal {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / ONE;
  const fraction = (abs % ONE).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  const text = fraction ? `${whole}.${fraction}` : `${whole}`;
  return negative && text !== '0' ? `-${text}` : text;
}
