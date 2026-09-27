/**
 * What the agent position screen SAYS (SEN-117, plan U-11): one open position
 * of one agent, live, and the Ask sheet that is the only way to act on it.
 *
 * Pure, like `cockpit.ts`: no React, no React Native, so `position.test.ts`
 * pins every figure and sentence under plain node and the screen only lays
 * out. The position row itself comes from the cockpit's `positionRows`, so
 * the cockpit card and this screen always show the same P&L for it; the
 * levels come from `levels.ts`, the one reader of preset params.
 *
 * There is deliberately nothing here that closes a position. Funds given to an
 * agent are the agent's (brief, "Constraints"): the user asks, the agent runs
 * with those words as its instruction, and it may decline inside its mandate.
 */
import type { AgentPortfolioDto, AgentPresetRef, PositionDto } from './api.ts';
import { positionRows, type PositionRow } from './cockpit.ts';
import type { LedgerEntry, ThesisEntry } from './ledger.ts';
import { levelLabel, type AgentLevel } from './levels.ts';

export type Venue = 'kuru' | 'perpl';

/**
 * The route carries the symbol and, optionally, the venue. Symbols are unique
 * across venues (`MON-USDC` on Kuru, `MON-PERP` on Perpl), so the suffix
 * decides when the link did not say.
 */
export function venueFor(symbol: string, asked?: string): Venue {
  if (asked === 'kuru' || asked === 'perpl') return asked;
  return /-PERP$/u.test(symbol) ? 'perpl' : 'kuru';
}

export function quoteFor(venue: Venue): 'USDC' | 'AUSD' {
  return venue === 'perpl' ? 'AUSD' : 'USDC';
}

/** The cockpit's row, plus the perp facts only this screen shows. */
export type LivePosition = PositionRow & {
  /** `180` — base units. */
  size: string;
  leverage: number | null;
  /** Isolated margin, AUSD. */
  margin: string | null;
  fundingPaid: string | null;
};

/**
 * The agent's open position on `symbol`, or `null` when it holds none there
 * (closed since the link was drawn, or never opened).
 */
export function findPosition(
  portfolio: AgentPortfolioDto,
  entries: readonly LedgerEntry[],
  preset: AgentPresetRef | null | undefined,
  symbol: string,
): LivePosition | null {
  const row = positionRows(portfolio, entries, preset).find((each) => each.symbol === symbol);
  if (!row) return null;
  if (row.venue === 'perpl') {
    const perp = perpPosition(portfolio, symbol);
    return {
      ...row,
      size: perp?.size ?? '—',
      leverage: perp?.leverage ?? null,
      margin: perp?.margin ?? null,
      fundingPaid: perp?.fundingPaid ?? null,
    };
  }
  const holding = portfolio.holdings.find((each) => each.market === symbol);
  return {
    ...row,
    size: holding?.amount ?? '—',
    leverage: null,
    margin: null,
    fundingPaid: null,
  };
}

function perpPosition(portfolio: AgentPortfolioDto, symbol: string): PositionDto | undefined {
  const perpl = portfolio.perpl;
  return perpl.ok && perpl.status === 'ok'
    ? perpl.positions.find((position) => position.symbol === symbol)
    : undefined;
}

/** `180 MON · Kuru spot · USDC`, `400 MON · Perpl · AUSD`. */
export function sizeLine(position: Pick<LivePosition, 'size' | 'base' | 'venue'>): string {
  const venue = position.venue === 'kuru' ? 'Kuru spot' : 'Perpl';
  return `${position.size} ${position.base} · ${venue} · ${quoteFor(position.venue)}`;
}

/**
 * The line under the headline. A spot position moves with price, so it says
 * how far price has come since entry, in the position's favour. A perp's
 * leverage makes that misleading, so it says what the P&L is on the margin
 * actually at risk.
 */
export function moveLine(
  position: Pick<LivePosition, 'venue' | 'side' | 'entry' | 'mark' | 'pnl' | 'margin'>,
): { text: string; tone: 'up' | 'down' | null } | null {
  if (position.venue === 'perpl') {
    const pct = ratio(position.pnl, position.margin);
    return pct === null ? null : { text: `${signedPct(pct)} on margin`, tone: toneOf(pct) };
  }
  const entry = Number(position.entry);
  const mark = Number(position.mark);
  if (!(entry > 0) || !Number.isFinite(mark)) return null;
  const favour = position.side === 'long' ? 1 : -1;
  const pct = ((mark - entry) / entry) * 100 * favour;
  return { text: `${signedPct(pct)} since entry`, tone: toneOf(pct) };
}

function ratio(part: string | null, whole: string | null): number | null {
  const a = Number(part);
  const b = Number(whole);
  return part !== null && whole !== null && Number.isFinite(a) && b > 0 ? (a / b) * 100 : null;
}

function signedPct(pct: number): string {
  const fixed = Math.abs(pct).toFixed(2);
  if (fixed === '0.00') return '0.00%';
  return `${pct < 0 ? '−' : '+'}${fixed}%`;
}

function toneOf(pct: number): 'up' | 'down' | null {
  const rounded = Number(pct.toFixed(2));
  return rounded > 0 ? 'up' : rounded < 0 ? 'down' : null;
}

/**
 * `3.6% to stop`, `2.4% to target`: how far price has to travel from the mark
 * to reach each level, as a share of the mark. A level price has already
 * crossed reads `at stop` — the agent will see it at its next check.
 */
export function levelDistances(
  levels: readonly AgentLevel[],
  mark: string | null,
  side: 'long' | 'short',
): { role: AgentLevel['role']; text: string }[] {
  const at = Number(mark);
  if (mark === null || !(at > 0)) return [];
  const favour = side === 'long' ? 1 : -1;
  return levels.map((level) => {
    const price = Number(level.price);
    // Positive while the level is still ahead of price in its own direction.
    const ahead = level.role === 'target' ? (price - at) * favour : (at - price) * favour;
    const name = level.role === 'target' ? 'target' : 'stop';
    if (ahead <= 0) return { role: level.role, text: `at ${name}` };
    return { role: level.role, text: `${((ahead / at) * 100).toFixed(1)}% to ${name}` };
  });
}

/**
 * Room between the mark and Perpl's liquidation ESTIMATE (it excludes accrued
 * funding, so it is never shown without "est."): the distance as a share of
 * the mark, and how far the meter fills — the share of the way from entry to
 * liquidation that price has already travelled, 0 when it moved away.
 */
export function roomToLiq(
  entry: string | null,
  mark: string | null,
  liq: string | null,
): { room: string; fill: number } | null {
  const e = Number(entry);
  const m = Number(mark);
  const l = Number(liq);
  if (liq === null || mark === null || !(m > 0) || !(l > 0)) return null;
  const room = `${((Math.abs(l - m) / m) * 100).toFixed(1)}%`;
  const span = l - e;
  const travelled = entry !== null && Number.isFinite(e) && span !== 0 ? (m - e) / span : 0;
  return { room, fill: Math.round(Math.min(1, Math.max(0, travelled)) * 1000) / 1000 };
}

/**
 * The brief's "far levels" rule: a liquidation 30% or more from the mark would
 * squash the chart into a flat band if drawn to scale, so the chart scales to
 * price and pins it as an edge chip instead.
 */
export const FAR_LEVEL = 0.3;

export function fitsChart(mark: string | null, liq: string | null): boolean {
  const m = Number(mark);
  const l = Number(liq);
  if (liq === null || mark === null || !(m > 0) || !(l > 0)) return true;
  return Math.abs(l - m) / m < FAR_LEVEL;
}

/** The chart's lines: entry, the preset's levels, and the liquidation estimate. */
export type PositionChartLevel = {
  price: string;
  kind: 'entry' | 'tp' | 'sl' | 'liq';
  label: string;
};

export function chartLevels(
  entry: string | null,
  levels: readonly AgentLevel[],
  liq: string | null,
): PositionChartLevel[] {
  const lines: PositionChartLevel[] = [];
  if (entry !== null) lines.push({ price: entry, kind: 'entry', label: 'ENTRY' });
  for (const level of levels) {
    lines.push({
      price: level.price,
      kind: level.role === 'target' ? 'tp' : 'sl',
      label: levelLabel(level),
    });
  }
  if (liq !== null) lines.push({ price: liq, kind: 'liq', label: 'LIQ EST' });
  return lines;
}

/** Just the times the chart needs to place a stone. `KlineDto` fits. */
export type KlineTimes = { openTime: number; closeTime: number };

export type FillMarker = { index: number; who: 'agent'; label: string };

/**
 * The agent's fills on `symbol` as purple stones on the candle each landed
 * in, labelled with the signed size (`+120`, `−90`). A fill outside the
 * window the chart shows has no candle to sit on, so it is left out rather
 * than pinned to an edge where it would claim the wrong time.
 */
export function fillMarkers(
  entries: readonly LedgerEntry[],
  symbol: string,
  klines: readonly KlineTimes[],
): FillMarker[] {
  const first = klines[0];
  const last = klines[klines.length - 1];
  if (!first || !last) return [];
  const markers: FillMarker[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'trade' || !entry.filled || entry.market !== symbol) continue;
    if (entry.at < first.openTime || entry.at > last.closeTime) continue;
    let index = klines.length - 1;
    for (let i = 0; i < klines.length; i += 1) {
      if (entry.at <= klines[i]!.closeTime) {
        index = i;
        break;
      }
    }
    const sign = entry.direction === 'short' ? '−' : '+';
    markers.push({ index, who: 'agent', label: `${sign}${entry.size}` });
  }
  return markers;
}

/**
 * When the position was opened: the first fill in its direction after the
 * last fill against it (or after the last close). Trend Rider's trailing stop
 * ratchets from the best price since then.
 */
export function openedAt(
  entries: readonly LedgerEntry[],
  symbol: string,
  side: 'long' | 'short',
): number | null {
  let opened: number | null = null;
  for (const entry of entries) {
    if (entry.kind === 'verdict' && entry.market === symbol) opened = null;
    if (entry.kind !== 'trade' || !entry.filled || entry.market !== symbol) continue;
    if (entry.direction === side) opened ??= entry.at;
    // A spot sell only trims a long; a perp fill against the side closes it.
    else if (/-PERP$/u.test(symbol)) opened = null;
  }
  return opened;
}

/** The best price since `since`: the highest high for a long, the lowest low for a short. */
export function bestSince(
  klines: readonly (KlineTimes & { high: string; low: string })[],
  since: number | null,
  side: 'long' | 'short',
): string | null {
  if (since === null) return null;
  let best: number | null = null;
  let text: string | null = null;
  for (const kline of klines) {
    if (kline.closeTime < since) continue;
    const price = side === 'long' ? kline.high : kline.low;
    const value = Number(price);
    if (!Number.isFinite(value)) continue;
    if (best === null || (side === 'long' ? value > best : value < best)) {
      best = value;
      text = price;
    }
  }
  return text;
}

/** The agent's latest thesis on the market, in its words, and what would prove it wrong. */
export function latestThesis(entries: readonly LedgerEntry[], symbol: string): ThesisEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.kind === 'thesis' && entry.market === symbol && entry.thesis) return entry;
  }
  return null;
}

/**
 * What a check will do about the WATCHED levels, in one sentence. Orders need
 * no sentence here: they fill on the venue without a check, and the levels
 * note already says they rest there.
 */
export function watchLine(levels: readonly AgentLevel[]): string | null {
  const watched = levels.filter((level) => level.source === 'watched');
  if (watched.length === 0) return null;
  const prices = watched.map((level) => level.price).join(' or ');
  return `At each check it exits if price has reached ${prices}.`;
}

// ---------------------------------------------------------------------------
// Ask sheet

export type AskChip = { key: string; label: string; phrase: string };

/**
 * The suggestions under the composer. "Stop to break-even" only when the agent
 * has a stop to move; the two closes exclude each other (see `toggleChip`).
 */
export function askChips(
  position: Pick<LivePosition, 'entry'> | null,
  hasStop: boolean,
): AskChip[] {
  const chips: AskChip[] = [];
  if (position) {
    chips.push(
      { key: 'close-all', label: 'Close it all', phrase: 'close the whole position' },
      { key: 'close-half', label: 'Close half', phrase: 'close half of it' },
    );
    if (hasStop && position.entry !== null) {
      chips.push({
        key: 'break-even',
        label: 'Stop to break-even',
        phrase: `move the stop to break-even (${position.entry})`,
      });
    }
  }
  chips.push({ key: 'why', label: 'Why this entry?', phrase: 'tell me why you entered here' });
  return chips;
}

const EXCLUSIVE: readonly (readonly string[])[] = [['close-all', 'close-half']];

/** Toggles one chip, dropping any chip it excludes. Order follows the chips, not the taps. */
export function toggleChip(
  selected: readonly string[],
  key: string,
  chips: readonly AskChip[],
): string[] {
  if (selected.includes(key)) return selected.filter((each) => each !== key);
  const rivals = EXCLUSIVE.find((group) => group.includes(key)) ?? [];
  const next = new Set([...selected.filter((each) => !rivals.includes(each)), key]);
  return chips.map((chip) => chip.key).filter((each) => next.has(each));
}

/** `Close half of it and move the stop to break-even (0.9744)`. */
export function composeAsk(selected: readonly string[], chips: readonly AskChip[]): string {
  const phrases = chips.filter((chip) => selected.includes(chip.key)).map((chip) => chip.phrase);
  const sentence = phrases.join(' and ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * What the run is actually told. A run has no notion of "this screen", so the
 * position is named in the instruction; the words the user typed follow as
 * written.
 */
export function askInstruction(
  position: Pick<LivePosition, 'side' | 'size' | 'base' | 'entry'> | null,
  symbol: string,
  words: string,
): string {
  const ask = words.trim();
  if (!position) return `About ${symbol}: ${ask}`;
  const at = position.entry !== null ? ` at ${position.entry}` : '';
  return `About your ${position.side} ${symbol} position (${position.size} ${position.base}${at}): ${ask}`;
}

/** The entries a run has added since the ask went out: what "This run" shows. */
export function entriesSince(entries: readonly LedgerEntry[], afterSeq: number): LedgerEntry[] {
  return entries.filter((entry) => entry.seq > afterSeq);
}
