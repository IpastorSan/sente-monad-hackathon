/**
 * Verdicts (SEN-22): settling a thesis against the fills it produced.
 *
 * `settle` is a pure function of the events an agent has already logged. It
 * answers one verdict per thesis, which is what the Agent Ledger's verdict row,
 * the leaderboard and the ERC-8004 reputation writes consume.
 *
 * Theses are grouped by run and by market, and inside a group every fill
 * belongs to the most recent `thesis` event before it, so an agent that changes
 * its mind on one market in one run gets a verdict per idea instead of one
 * muddle. A thesis with no fills is not settled at all: there is nothing to
 * pair it with, and `held` about a trade that never happened would be a claim,
 * not a verdict.
 *
 * Money is realised IN THE THESIS'S OWN DIRECTION. A long makes money when its
 * exits are above its entries and a short when they are below, and
 * `realisedPnl` is positive in both cases when the thesis was right. `held` is
 * therefore just the sign of that number — a thesis that ended exactly flat did
 * not hold — and a thesis whose position has not come back to zero is not
 * judged at all: `held` is the string `'open'`.
 *
 * The `invalidation` text stays verbatim on the `thesis` event and is NOT
 * evaluated here. Judging prose ("MON back under 3.00") would take prices this
 * log does not carry, and a verdict the agent can argue with is worse than no
 * verdict: the Ledger shows the text next to the number, and the number is the
 * fills.
 *
 * How that number is arrived at, per venue:
 *
 * - **Kuru (spot)** — FIFO cost basis over the thesis's own fills, in quote
 *   units, net of every fee they paid. A fill on the side the thesis opened
 *   with (`buy` for a long, `sell` for a short) queues a lot; a fill on the
 *   other side consumes the oldest lots first. Size with no lot left to match
 *   against — base the agent already held when the thesis was recorded — is
 *   left out of the arithmetic, because its cost is not in these events. Fees
 *   arrive in quote units (SEN-20); a fee the venue denominated in the base
 *   token is converted at that fill's own price.
 * - **Perpl** — the venue's own realised PnL off the `close` event: Perpl's
 *   settled price PnL (`dpnl`, mapped to `realizedPnl`) less its funding
 *   (`fnd`, mapped to `fundingPaid`), in AUSD. The venue has done the cost
 *   accounting already, so no fill fee is netted on top of it, and when the
 *   position's final frame never arrived (SEN-20) the fills are the fallback.
 *
 * A position counts as closed the same way on both venues: its net size back to
 * zero — the thesis's own fills netting out, which is all a spot venue has to
 * offer. Perpl adds the case where the thesis opened nothing of its own, the
 * position having been live when it was recorded: there a `close` event is the
 * venue's own word that it is flat, and its PnL is the verdict, because the
 * cost of that position is in a run this log is not settling.
 */
import type { AgentEvent } from './agent-event-log';

export type ThesisDirection = 'long' | 'short';
export type VerdictVenue = 'kuru' | 'perpl';

/** What Perpl quotes money in: its `dpnl` and `fnd` are AUSD, 6dp. */
const PERPL_PNL_ASSET = 'AUSD';

export interface Verdict {
  readonly agentId: string;
  /** The run the thesis was recorded in. Absent when its events carried none. */
  readonly runId?: string;
  readonly market: string;
  readonly venue: VerdictVenue;
  /** What the agent said it was doing, which is the direction the PnL is read in. */
  readonly direction: ThesisDirection;
  /** `seq` of the `thesis` event this settles — the Ledger's handle on it. */
  readonly thesisSeq: number;
  /**
   * Fill events the thesis produced, opening and closing fills together. A fill
   * the venue reported without a size or a price is counted here and still
   * cannot enter the arithmetic.
   */
  readonly fills: number;
  /**
   * Realised PnL in the thesis direction, in `pnlAsset`. Negative is a loss.
   * While the thesis is open this is what has been realised SO FAR — the exits
   * matched so far, less the fees already paid — with `held` still saying
   * nothing about it.
   */
  readonly realisedPnl: string;
  /** What `realisedPnl` and `costBasis` are denominated in: the market's quote, or AUSD. */
  readonly pnlAsset: string;
  /**
   * Entry notional of the fills that opened the position, fees excluded, in
   * `pnlAsset`. Kuru: the quote spent or received. Perpl: size x entry price,
   * the size of the bet rather than the margin behind it.
   */
  readonly costBasis: string;
  /** `true` when the thesis made money, `false` when it did not, `'open'` while it is live. */
  readonly held: boolean | 'open';
  /** Unix epoch ms of the event that closed it. Absent while `held` is `'open'`. */
  readonly closedAt?: number;
}

/** The kinds a verdict is read from: the thesis, the fills it produced, and the close. */
const SETTLED_KINDS = new Set(['thesis', 'fill', 'close']);

/**
 * One verdict per thesis that produced at least one fill, oldest thesis first.
 * Purely a function of `events`; `verdict` events in the input are ignored, so
 * settling a log that already contains verdicts is safe.
 */
export function settle(events: readonly AgentEvent[]): Verdict[] {
  const groups = new Map<string, AgentEvent[]>();
  for (const event of events) {
    if (!SETTLED_KINDS.has(event.kind)) continue;
    const market = marketOf(event);
    if (market === undefined) continue;
    // Run and market together: one run can hold several theses on one market,
    // and one market can be traded by several runs (and by several agents).
    const key = `${event.agentId}\u0000${event.runId ?? ''}\u0000${market}`;
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }

  const verdicts: Verdict[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.seq - b.seq);
    // A new thesis starts a new segment; fills and closes belong to the last
    // thesis recorded before them.
    let segment: AgentEvent[] = [];
    let thesis: AgentEvent | undefined;
    for (const event of group) {
      if (event.kind === 'thesis') {
        if (thesis) settleInto(verdicts, thesis, segment);
        thesis = event;
        segment = [];
        continue;
      }
      if (thesis) segment.push(event);
    }
    if (thesis) settleInto(verdicts, thesis, segment);
  }
  return verdicts.sort((a, b) => a.thesisSeq - b.thesisSeq);
}

function settleInto(verdicts: Verdict[], thesis: AgentEvent, events: readonly AgentEvent[]): void {
  const verdict = settleSegment(thesis, events);
  if (verdict) verdicts.push(verdict);
}

/** The market an event is about: the thesis names one, a fill names its symbol. */
function marketOf(event: AgentEvent): string | undefined {
  return stringOf(event.detail[event.kind === 'thesis' ? 'market' : 'symbol']);
}

/**
 * The events of ONE thesis, in order. `undefined` when the thesis never traded,
 * or when it does not say which way it was pointed — either way there is
 * nothing honest to settle.
 */
function settleSegment(thesis: AgentEvent, events: readonly AgentEvent[]): Verdict | undefined {
  const direction = thesis.detail['direction'];
  const market = stringOf(thesis.detail['market']);
  if (market === undefined) return undefined;
  if (direction !== 'long' && direction !== 'short') return undefined;
  const fills = events.filter((e) => e.kind === 'fill');
  if (fills.length === 0) return undefined;

  const venue = venueOf(events);
  const pnlAsset = pnlAssetOf(venue, market);
  const lots: Lot[] = [];
  let costBasis = scaled('0');
  let realised = scaled('0');
  let fees = scaled('0');
  let net = scaled('0');
  let closingFillAt: number | undefined;
  let close: AgentEvent | undefined;
  let openingFills = 0;

  for (const event of events) {
    if (event.kind === 'close') {
      // The close carries the closing fill again, plus the venue's PnL: it is
      // read for the second, never counted as a fill twice.
      close = event;
      continue;
    }
    const side = event.detail['side'];
    const size = decimalOf(event.detail['filledSize']);
    const price = decimalOf(event.detail['averageFillPrice']);
    if (size === undefined || price === undefined) continue;
    if (side !== 'buy' && side !== 'sell') continue;

    if (side === openingSide(direction)) {
      lots.push({ size, price });
      costBasis = addScaled(costBasis, mulScaled(size, price));
      net = addScaled(net, size);
      openingFills += 1;
    } else {
      realised = addScaled(realised, consume(lots, size, direction, price));
      net = subScaled(net, size);
      if (isZero(net)) closingFillAt = event.at;
    }

    const fee = decimalOf(event.detail['fee']);
    if (fee !== undefined && !isZero(fee)) {
      const feeAsset = stringOf(event.detail['feeAsset']);
      // Quote-unit fee as it arrives; anything else is read as base and priced
      // at the fill that paid it.
      fees = addScaled(
        fees,
        feeAsset !== undefined && feeAsset !== pnlAsset ? mulScaled(fee, price) : fee,
      );
    }
  }

  // Opened from the fills: the position is closed once nothing is left of it.
  // Opened elsewhere (a position the agent already held): the venue's own
  // close is the only word on the matter there is.
  const closed = openingFills > 0 ? isZero(net) : close !== undefined;
  const venuePnl = close ? venueRealised(close) : undefined;
  const realisedPnl = venuePnl ?? subScaled(realised, fees);

  return {
    agentId: thesis.agentId,
    ...(thesis.runId !== undefined ? { runId: thesis.runId } : {}),
    market,
    venue,
    direction,
    thesisSeq: thesis.seq,
    fills: fills.length,
    realisedPnl: decimalString(realisedPnl),
    pnlAsset,
    costBasis: decimalString(costBasis),
    held: closed ? compareScaled(realisedPnl, scaled('0')) > 0 : 'open',
    ...(closed ? { closedAt: close?.at ?? closingFillAt } : {}),
  };
}

/** Kuru has no short, so a "short" thesis is the reverse trade: sell first, buy back. */
function openingSide(direction: ThesisDirection): 'buy' | 'sell' {
  return direction === 'long' ? 'buy' : 'sell';
}

/**
 * The last venue the events declared, which is the one that filled them. A fill
 * carrying leverage is a Perpl fill even when the event lost its venue, because
 * leverage has no meaning on a spot venue; spot is what is left.
 */
function venueOf(events: readonly AgentEvent[]): VerdictVenue {
  let venue: VerdictVenue | undefined;
  let leveraged = false;
  for (const event of events) {
    const declared = event.detail['venue'];
    if (declared === 'kuru' || declared === 'perpl') venue = declared;
    if (typeof event.detail['leverage'] === 'number') leveraged = true;
  }
  return venue ?? (leveraged ? 'perpl' : 'kuru');
}

/** AUSD on Perpl; on Kuru the quote side of the market symbol (`MON-USDC` to USDC). */
function pnlAssetOf(venue: VerdictVenue, market: string): string {
  if (venue === 'perpl') return PERPL_PNL_ASSET;
  return market.split('-')[1] ?? market;
}

/**
 * Perpl's own settled PnL: `dpnl` less funding (Perpl's `fnd` arrives already
 * sign-flipped as `fundingPaid`, positive = paid). `undefined` when the close
 * carries neither, which happens when the position's final frame never arrived
 * (SEN-20) — the fills are then the only account of it there is.
 */
function venueRealised(close: AgentEvent): Scaled | undefined {
  const price = decimalOf(close.detail['realizedPnl']);
  const funding = decimalOf(close.detail['fundingPaid']);
  if (price === undefined && funding === undefined) return undefined;
  return subScaled(price ?? scaled('0'), funding ?? scaled('0'));
}

interface Lot {
  size: Scaled;
  readonly price: Scaled;
}

/**
 * Match a closing fill against the open lots, oldest first, and return the PnL
 * it realised. Size beyond the last lot — a close of base the thesis never
 * opened — realises nothing: this thesis has no cost for it.
 */
function consume(lots: Lot[], size: Scaled, direction: ThesisDirection, exit: Scaled): Scaled {
  let remaining = size;
  let realised = scaled('0');
  while (lots.length > 0 && !isZero(remaining)) {
    const lot = lots[0]!;
    const taken = compareScaled(lot.size, remaining) <= 0 ? lot.size : remaining;
    realised = addScaled(
      realised,
      mulScaled(
        taken,
        direction === 'long' ? subScaled(exit, lot.price) : subScaled(lot.price, exit),
      ),
    );
    lot.size = subScaled(lot.size, taken);
    remaining = subScaled(remaining, taken);
    if (isZero(lot.size)) lots.shift();
  }
  return realised;
}

/**
 * Exact SIGNED decimal arithmetic, local to this module: every other decimal
 * helper in the repo is exact only for non-negative strings, and both `dpnl`
 * and funding arrive signed. BigInt with a scale, never `Number`.
 */
interface Scaled {
  readonly units: bigint;
  readonly scale: number;
}

const SIGNED_DECIMAL = /^-?\d+(\.\d+)?$/;

function scaled(value: string): Scaled {
  const negative = value.startsWith('-');
  const magnitude = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = magnitude.split('.');
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

/** A decimal off an event, or `undefined` when it is not one. */
function decimalOf(value: unknown): Scaled | undefined {
  return typeof value === 'string' && SIGNED_DECIMAL.test(value) ? scaled(value) : undefined;
}

function rescaled(value: Scaled, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function addScaled(a: Scaled, b: Scaled): Scaled {
  const scale = Math.max(a.scale, b.scale);
  return { units: rescaled(a, scale) + rescaled(b, scale), scale };
}

function subScaled(a: Scaled, b: Scaled): Scaled {
  const scale = Math.max(a.scale, b.scale);
  return { units: rescaled(a, scale) - rescaled(b, scale), scale };
}

function mulScaled(a: Scaled, b: Scaled): Scaled {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

function compareScaled(a: Scaled, b: Scaled): number {
  const scale = Math.max(a.scale, b.scale);
  const left = rescaled(a, scale);
  const right = rescaled(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

function isZero(value: Scaled): boolean {
  return value.units === 0n;
}

/** Back to a decimal string, trailing zeros trimmed. */
function decimalString(value: Scaled): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
