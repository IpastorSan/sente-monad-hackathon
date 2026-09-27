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
 * The log also FORGETS (SEN-129): it keeps the newest 10k events per agent, so
 * once an agent passes that its oldest buys are gone and FIFO would match its
 * sells against the wrong lots — a wrong number with nothing to say so. The
 * caller passes the log's `truncation`, and a truncated history yields
 * `complete: false` and no figures from `reconcileHolding`.
 *
 * Fees follow THE fee rule, written once in `events/verdict.ts`'s header
 * ("The fee rule (SEN-128)") and applied through its `feeInQuote`: a fee is
 * realised on the fill that paid it, in full, base fees priced at that fill.
 * This ledger used to fold buy fees into lots, ignore base fees and pro-rate a
 * sell's fee over its matched part, so the portfolio and the verdict card
 * disagreed about the same fills; they must not.
 *
 * Arithmetic is exact bigint fixed point, never `Number`. Sizes and prices are
 * 18 dp (Kuru's `ratioToDecimal` scale, and no token has more decimals), so a
 * size x price product is exact at 36 dp; money is carried at 36 dp and only
 * rounded (towards zero) to 18 dp when it is written out.
 */
import type { Decimal } from '@sente/venues';

import type { AgentEvent, AgentEventTruncation } from '../events/agent-event-log';
import { addScaled, feeInQuote, type Scaled, subScaled } from '../events/verdict';

export interface CostBasis {
  readonly market: string;
  /** Base still held from the logged buys, after FIFO sells. */
  readonly openSize: Decimal;
  /** `costQuote / openSize`, 18 dp: the fee-exclusive entry. `null` when nothing is open. */
  readonly avgPrice: Decimal | null;
  /** Quote paid for `openSize` at its fills, fees EXCLUDED: they are in `realisedPnl` already. */
  readonly costQuote: Decimal;
  /**
   * Quote realised by the sells that matched a lot, less every fee paid on
   * every fill (the fee rule in `events/verdict.ts`). Signed.
   */
  readonly realisedPnl: Decimal;
  /** Sold size with no logged lot behind it: base whose cost this log never saw. */
  readonly unmatchedSellSize: Decimal;
  /** Kuru fills on this market that were read, parsable or not. */
  readonly fills: number;
  /**
   * `false` when the log had dropped some of the agent's oldest events: then
   * every figure above may be off by the dropped fills, and none may be shown.
   */
  readonly complete: boolean;
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
/** Money is size x price: 36 dp. */
const MONEY_SCALE = SCALE * 2n;
const UNSIGNED_DECIMAL = /^\d+(\.\d{1,18})?$/;

interface Lot {
  /** Base, 18 dp. */
  size: bigint;
  /** Fill price, 18 dp. Fees are not in the lot: they were realised when paid. */
  readonly price: bigint;
}

/**
 * `truncation` is the log's answer for the agent the events are from. It is
 * required, not defaulted, so no caller can forget that the list may not be
 * the whole history.
 */
export function fifoCostBasis(
  events: readonly AgentEvent[],
  market: string,
  truncation: AgentEventTruncation,
): CostBasis {
  // The quote side of the symbol (`MON-USDC` -> USDC), read exactly as
  // `verdict.ts#pnlAssetOf` reads it, since the fee rule is keyed on it.
  const quote = market.split('-')[1] ?? market;
  const lots: Lot[] = [];
  // 36 dp money; a fee off `feeInQuote` can carry more, so this stays Scaled
  // and is only cut to 18 dp when written out.
  let realised: Scaled = { units: 0n, scale: Number(MONEY_SCALE) };
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
    if (size === undefined || price === undefined) continue;
    if (side !== 'buy' && side !== 'sell') continue;

    // The whole fee, on the fill that paid it, whatever the fill matched
    // (SEN-128): a buy's fee does not wait for its lot to close, and an
    // over-sell's fee is not pro-rated down to its matched part.
    const fee = feeInQuote(event.detail, { units: price, scale: Number(SCALE) }, quote);
    if (fee !== undefined) realised = subScaled(realised, fee);
    if (size === 0n) continue;

    if (side === 'buy') {
      lots.push({ size, price });
      continue;
    }

    let remaining = size;
    let matchedCost = 0n;
    while (lots.length > 0 && remaining > 0n) {
      const lot = lots[0]!;
      const taken = lot.size <= remaining ? lot.size : remaining;
      matchedCost += taken * lot.price;
      lot.size -= taken;
      remaining -= taken;
      if (lot.size === 0n) lots.shift();
    }
    // Only the matched part realises a price PnL: the rest has no cost in this log.
    unmatched += remaining;
    realised = addScaled(realised, {
      units: (size - remaining) * price - matchedCost,
      scale: Number(MONEY_SCALE),
    });
  }

  const openSize = lots.reduce((sum, lot) => sum + lot.size, 0n);
  const cost = lots.reduce((sum, lot) => sum + lot.size * lot.price, 0n);
  return {
    market,
    openSize: fixedString(openSize),
    avgPrice: openSize === 0n ? null : fixedString(cost / openSize),
    costQuote: moneyString(cost),
    realisedPnl: fixedString(truncatedTo(realised, SCALE)),
    unmatchedSellSize: fixedString(unmatched),
    fills,
    // Any dropped event could have been a fill on this market: they are not
    // there to check, so ANY eviction makes the basis unknown.
    complete: truncation.evicted === 0,
  };
}

/**
 * Set the log's cost basis against the base actually held. The log can only
 * answer for up to `openSize`; anything held beyond it is `uncoveredSize` and
 * makes the result incomplete. Holding LESS than the log says (a withdrawal,
 * a sell recorded nowhere) is still complete: every unit held is explained, at
 * the log's average entry.
 *
 * A basis from a truncated log explains nothing (SEN-129): every unit held is
 * uncovered and there is no entry or unrealised PnL, rather than figures from
 * lots that FIFO may have matched wrongly.
 */
export function reconcileHolding(
  basis: CostBasis,
  heldSize: Decimal,
  mark: Decimal | null,
): HoldingReconciliation {
  const held = requireFixed(heldSize, 'heldSize');
  if (!basis.complete) {
    return {
      coveredSize: '0',
      uncoveredSize: fixedString(held),
      avgPrice: null,
      unrealizedPnl: null,
      complete: false,
    };
  }
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

/** `value` as units at `scale` dp, truncated towards zero like `moneyString`. */
function truncatedTo(value: Scaled, scale: bigint): bigint {
  const shift = BigInt(value.scale) - scale;
  return shift >= 0n ? value.units / 10n ** shift : value.units * 10n ** -shift;
}

function fixedString(units: bigint): Decimal {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / ONE;
  const fraction = (abs % ONE).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  const text = fraction ? `${whole}.${fraction}` : `${whole}`;
  return negative && text !== '0' ? `-${text}` : text;
}
