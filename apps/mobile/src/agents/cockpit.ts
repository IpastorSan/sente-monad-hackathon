/**
 * What the agent cockpit SAYS (SEN-115): the Overview's stats, equity series
 * and open-position rows, History's best trades and day groups, the Mandate
 * card's sentence and proof, and the cadence control's words.
 *
 * Pure, like `ledgerView.ts`: no React, no React Native, so `cockpit.test.ts`
 * pins every string under plain `node --test` and the screen only lays out.
 *
 * Every figure comes from something the API already reports — the event log's
 * verdicts, the summary, the portfolio route — and a figure with nothing
 * behind it is a dash, never a guess. Two consequences worth stating:
 *
 * - The equity chart is CUMULATIVE REALISED P&L from verdicts, not wallet
 *   value: there is no equity history on the wire, and a line that mixed
 *   realised money with today's balance would draw a curve nobody earned.
 * - Stop and target are the agent's preset params applied to the entry, read
 *   from `levels.ts` (SEN-117), which also says which of them rest on the
 *   venue and which are only watched. An agent with no preset, or a preset
 *   without both a stop and a target, gets no track at all.
 */
import { groupThousands } from './amounts.ts';
import type {
  Agent,
  AgentPortfolioDto,
  AgentPresetRef,
  AgentScheduleStatusDto,
  AgentSummary,
} from './api.ts';
import type { LedgerEntry, VerdictEntry } from './ledger.ts';
import { levelsNote, presetLevels, stopAndTarget, type StopTarget } from './levels.ts';
import { PNL_LABEL_PLACES, pnlLabel } from './leaderboard.ts';
import { outcome, sumDecimals } from './ledgerView.ts';
import { formatNotional, marketFor, tokenFor } from './mandate.ts';
import { formatDuration, pnlTone } from './usage.ts';
import { signedFigure } from '../ui/money.ts';
import { formatPct } from '../ui/tradingFormat.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type Tone = 'up' | 'down' | null;

// ---------------------------------------------------------------------------
// Tabs

export type CockpitTab = 'overview' | 'history' | 'mandate';

export const COCKPIT_TABS: readonly { value: CockpitTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'history', label: 'History' },
  { value: 'mandate', label: 'Mandate' },
];

/** A deep link's `?tab=` read back as a tab; anything else opens Overview. */
export function tabFrom(param: string | undefined): CockpitTab {
  return COCKPIT_TABS.some((tab) => tab.value === param) ? (param as CockpitTab) : 'overview';
}

// ---------------------------------------------------------------------------
// Dates

/** `Sep 21`, in UTC like every other date in the app, so it reads the same everywhere. */
export function shortDate(at: number): string {
  const iso = new Date(at).toISOString();
  return `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? iso.slice(5, 7)} ${Number(iso.slice(8, 10))}`;
}

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Settled trades

/** One closed position, as the cockpit reads it. */
export type SettledTrade = {
  seq: number;
  /** When it closed. */
  at: number;
  market: string | null;
  direction: VerdictEntry['direction'];
  /** Exact decimal string, as the verdict carried it. */
  pnl: string;
  tone: Tone;
  /** From its first fill to the close; `null` when no fill on that market explains it. */
  holdMs: number | null;
};

/**
 * The verdicts that carry a P&L, oldest first, each with how long it was held.
 *
 * Only SEN-22's `verdict`, never the venue's `close` before it: both carry a
 * P&L for the same trade, and counting both would double every Perpl trade —
 * the rule `ledgerStats` and `GET /agents/summaries` follow too.
 *
 * The hold is read off the log: the first fill on the same market after the
 * previous verdict there. Fill symbols and verdict markets are both the
 * venue's symbol, so they compare as strings; a verdict with no such fill in
 * the page gets no hold rather than a wrong one.
 */
export function settledTrades(entries: readonly LedgerEntry[]): SettledTrade[] {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  const openedAt = new Map<string, number>();
  const trades: SettledTrade[] = [];
  for (const entry of ordered) {
    if (entry.kind === 'trade' && entry.filled) {
      if (!openedAt.has(entry.market)) openedAt.set(entry.market, entry.at);
      continue;
    }
    if (entry.kind !== 'verdict' || entry.origin !== 'verdict' || entry.pnl === null) continue;
    const opened = entry.market !== null ? openedAt.get(entry.market) : undefined;
    if (entry.market !== null) openedAt.delete(entry.market);
    trades.push({
      seq: entry.seq,
      at: entry.at,
      market: entry.market,
      direction: entry.direction,
      pnl: entry.pnl,
      tone: outcome(entry),
      holdMs: opened !== undefined && entry.at >= opened ? entry.at - opened : null,
    });
  }
  return trades;
}

/**
 * ` since Sep 3` when the server's log has dropped the agent's oldest events,
 * else nothing (SEN-159). Every count read off the summary carries it, so a
 * truncated agent's counts never pass for its whole history.
 */
export function countsSince(summary: Pick<AgentSummary, 'countsPartial'> | undefined): string {
  const since = summary?.countsPartial?.since;
  return since === undefined ? '' : ` since ${shortDate(since)}`;
}

// ---------------------------------------------------------------------------
// Overview: stats

export type CockpitStats = {
  /** `6 of 9`, or a dash before anything settled. */
  won: string;
  avgHold: string;
  held: string;
  liveSince: string;
};

/**
 * The four chips under the chart. Held comes from the summary when there is
 * one (it counts the whole log), else from the entries on hand; the won and
 * hold figures can only come from the entries, which are the latest page.
 */
export function cockpitStats(
  trades: readonly SettledTrade[],
  entries: readonly LedgerEntry[],
  summary: Pick<AgentSummary, 'held' | 'countsPartial'> | undefined,
  createdAt: string,
): CockpitStats {
  const won = trades.filter((trade) => trade.tone === 'up').length;
  const holds = trades.map((trade) => trade.holdMs).filter((ms): ms is number => ms !== null);
  const avg = holds.length > 0 ? holds.reduce((sum, ms) => sum + ms, 0) / holds.length : null;
  const held = summary?.held ?? entries.filter((entry) => entry.kind === 'refusal').length;
  const since = Date.parse(createdAt);
  return {
    won: trades.length > 0 ? `${won} of ${trades.length}` : '—',
    avgHold: avg !== null ? formatDuration(avg) : '—',
    held: `${groupThousands(String(held))}${countsSince(summary)}`,
    liveSince: Number.isFinite(since) ? shortDate(since) : '—',
  };
}

// ---------------------------------------------------------------------------
// Overview: the P&L headline and the equity series

/**
 * `+42.18` split for `BigNumber`: the sign as a prefix, the magnitude as the
 * value, already rounded to the cent `BigNumber` shows. SEN-136: the sign used
 * to come from the exact figure, so `-0.001` printed `−0.00` in berry, and
 * `1e-7` reached `BigNumber` unparsed and printed `—`.
 */
export function signedParts(pnl: string | null | undefined): {
  sign: '+' | '−' | '';
  magnitude: string;
  tone: Tone;
} {
  const figure = signedFigure(pnl ?? '0', PNL_LABEL_PLACES);
  if (figure === null) return { sign: '', magnitude: (pnl ?? '').trim() || '0', tone: null };
  return { sign: figure.sign, magnitude: figure.plain, tone: figure.tone };
}

/**
 * What the P&L headline is in. The summary adds USDC and AUSD as one unit, so
 * an agent on both venues gets "≈ $" and no currency, never one of the two.
 */
export function pnlUnit(venues: readonly string[]): { unit: string; approx: boolean } {
  const unit = quoteUnit(venues);
  return unit === 'quote units' ? { unit: '', approx: true } : { unit, approx: false };
}

export type EquityRange = '1D' | '1W' | 'All';
export const EQUITY_RANGES: readonly EquityRange[] = ['1D', '1W', 'All'];

export type EquitySeries = {
  /** Cumulative realised P&L, oldest first, as exact decimal strings. */
  points: string[];
  /** When each point was reached, epoch ms. */
  ats: number[];
};

/**
 * Cumulative realised P&L over `range`, starting from where it stood when the
 * window opened (zero at the hire for All), with a step at each settled trade.
 * `null` when the window holds no trade: a flat line would claim a history of
 * doing nothing where the log may simply not reach back that far.
 */
export function equitySeries(
  trades: readonly SettledTrade[],
  range: EquityRange,
  now: number,
  since: number,
): EquitySeries | null {
  const from = range === '1D' ? now - DAY : range === '1W' ? now - 7 * DAY : since;
  const before = trades.filter((trade) => trade.at < from).map((trade) => trade.pnl);
  const inside = trades.filter((trade) => trade.at >= from);
  if (inside.length === 0) return null;
  let running = sumDecimals(before) ?? '0';
  const points = [running];
  const ats = [Math.min(from, inside[0]?.at ?? from)];
  for (const trade of inside) {
    running = sumDecimals([running, trade.pnl]) ?? running;
    points.push(running);
    ats.push(trade.at);
  }
  return { points, ats };
}

/**
 * Realised P&L over the window the range pills pick (SEN-177): the summary's
 * all-time and 24 h figures for All and 1D, and the curve's own change for
 * 1W. `null` when there is no figure to give (no summary); a week with no
 * settled trade is a zero, not a missing figure.
 */
export function windowPnl(
  range: EquityRange,
  summary: Pick<AgentSummary, 'pnl'> | undefined,
  series: EquitySeries | null,
): string | null {
  if (!summary) return null;
  if (range === 'All') return summary.pnl.allTime;
  if (range === '1D') return summary.pnl.last24h;
  const first = series?.points[0];
  const last = series?.points.at(-1);
  if (first === undefined || last === undefined) return '0';
  const negated = first.startsWith('-') ? first.slice(1) : `-${first.replace(/^\+/, '')}`;
  return sumDecimals([last, negated]) ?? '0';
}

/** What the window is called next to its P&L. */
export const WINDOW_LABEL: Record<EquityRange, string> = {
  All: 'all time',
  '1W': 'past week',
  '1D': 'past 24 h',
};

// ---------------------------------------------------------------------------
// Overview: open positions

/**
 * Stop and target as the track's pair. The name predates SEN-117: not every
 * one is watched now (Range Trader's and Mean Reverter's targets rest on the
 * venue), and `PositionRow.levelsNote` says which is which.
 */
export type WatchedLevels = StopTarget;

/**
 * The preset's stop and target applied to the entry, `null` unless it has
 * both. A thin wrapper: `levels.ts` is the one reader of preset params, so
 * the cockpit and the position screen cannot drift apart.
 */
export function watchedLevels(
  preset: (Pick<AgentPresetRef, 'id' | 'params'> & { customized?: boolean }) | null | undefined,
  entry: string,
  side: 'long' | 'short',
): WatchedLevels | null {
  return stopAndTarget(presetLevels(preset, { entry, side }));
}

/** The track's pair and the sentence qualifying it, from the same levels. */
function levelsOf(
  preset: AgentPresetRef | null | undefined,
  entry: string | null,
  side: 'long' | 'short',
  venue: 'kuru' | 'perpl',
): Pick<PositionRow, 'levels' | 'levelsNote'> {
  if (entry === null) return { levels: null, levelsNote: null };
  const levels = presetLevels(preset, { entry, side });
  const pair = stopAndTarget(levels);
  // The note qualifies the track, so it appears only where the track does.
  return { levels: pair, levelsNote: pair ? levelsNote(levels, venue) : null };
}

/**
 * Where the entry tick and the price dot sit on the stop → target track, as
 * 0..1 from the stop end. Works for a short too (its target is below its
 * stop): the fraction is progress toward the target either way.
 */
export function trackLayout(
  levels: WatchedLevels,
  entry: string,
  mark: string,
): { entry: number; mark: number } | null {
  const stop = Number(levels.stop);
  const span = Number(levels.target) - stop;
  if (!Number.isFinite(span) || span === 0) return null;
  const at = (price: string): number | null => {
    const value = Number(price);
    if (!Number.isFinite(value)) return null;
    // Three places is a tenth of a pixel on any phone, and keeps float noise out.
    return Math.round(Math.min(1, Math.max(0, (value - stop) / span)) * 1000) / 1000;
  };
  const e = at(entry);
  const m = at(mark);
  return e === null || m === null ? null : { entry: e, mark: m };
}

export type PositionRow = {
  key: string;
  venue: 'kuru' | 'perpl';
  /** The glyph's asset: `MON`. */
  base: string;
  symbol: string;
  side: 'long' | 'short';
  /** `180 MON @ 0.9744 · Kuru`. */
  detail: string;
  /** `+1.22`, or `null` when nothing prices it. */
  pnl: string | null;
  /** `+0.70%` of the cost, or `null`. */
  pct: string | null;
  tone: Tone;
  entry: string | null;
  mark: string | null;
  /** Perpl's own estimate, excluding funding. */
  liq: string | null;
  levels: WatchedLevels | null;
  /** Which of those levels rest on the venue and which are only watched; `null` with no track. */
  levelsNote: string | null;
  /** The agent's latest thesis on this market, in its own words. */
  thesis: string | null;
};

/**
 * The portfolio's open positions as rows: Perpl positions when the agent's
 * Perpl section is readable, and every Kuru holding the event log explains
 * (`coveredSize > 0`). A holding nothing explains is not a position the agent
 * took — the wallet's MON is mostly gas — so it stays out of this list.
 */
export function positionRows(
  portfolio: AgentPortfolioDto,
  entries: readonly LedgerEntry[],
  preset: AgentPresetRef | null | undefined,
): PositionRow[] {
  const thesisFor = (market: string): string | null => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry?.kind === 'thesis' && entry.market === market && entry.thesis) return entry.thesis;
    }
    return null;
  };

  const rows: PositionRow[] = [];
  const perpl = portfolio.perpl;
  if (perpl.ok && perpl.status === 'ok') {
    for (const position of perpl.positions) {
      const base = baseOf(position.symbol);
      const cost = Number(position.size) * Number(position.entryPrice);
      rows.push({
        key: `perpl:${position.symbol}:${position.side}`,
        venue: 'perpl',
        base,
        symbol: position.symbol,
        side: position.side,
        detail: `${position.size} ${base} @ ${position.entryPrice} · Perpl ${position.leverage}×`,
        pnl: pnlLabel(position.unrealizedPnl),
        pct: percentOf(position.unrealizedPnl, cost),
        tone: pnlTone(position.unrealizedPnl, PNL_LABEL_PLACES),
        entry: position.entryPrice,
        mark: position.markPrice,
        liq: position.liquidationPriceEst,
        ...levelsOf(preset, position.entryPrice, position.side, 'perpl'),
        thesis: thesisFor(position.symbol),
      });
    }
  }
  for (const holding of portfolio.holdings) {
    const covered = Number(holding.costBasis.coveredSize);
    if (!(covered > 0)) continue;
    const { avgPrice, unrealizedPnl } = holding.costBasis;
    rows.push({
      key: `kuru:${holding.market}`,
      venue: 'kuru',
      base: holding.asset,
      symbol: holding.market,
      side: 'long',
      detail: `${holding.amount} ${holding.asset}${avgPrice !== null ? ` @ ${avgPrice}` : ''} · Kuru`,
      pnl: unrealizedPnl !== null ? pnlLabel(unrealizedPnl) : null,
      pct:
        unrealizedPnl !== null && avgPrice !== null
          ? percentOf(unrealizedPnl, covered * Number(avgPrice))
          : null,
      tone: pnlTone(unrealizedPnl, PNL_LABEL_PLACES),
      entry: avgPrice,
      mark: holding.markPrice,
      liq: null,
      ...levelsOf(preset, avgPrice, 'long', 'kuru'),
      thesis: thesisFor(holding.market),
    });
  }
  return rows;
}

function baseOf(symbol: string): string {
  return symbol.split(/[-/]/u)[0] || symbol;
}

/** `+0.70%` — a display ratio, so a float is fine for the division. */
function percentOf(pnl: string, cost: number): string | null {
  const value = Number(pnl);
  if (!Number.isFinite(value) || !Number.isFinite(cost) || cost <= 0) return null;
  // `formatPct` rounds the ratio on its digits, like every signed figure (SEN-136).
  return formatPct((value / cost) * 100);
}

// ---------------------------------------------------------------------------
// History

export type BestTrade = {
  seq: number;
  /** `Trade #1 · MON long` — ranked by P&L, best first. */
  title: string;
  pnl: string;
  /** `held 2h 14m · Sep 27`, or the date alone. */
  caption: string;
};

/** The winners, best first, at most `limit`. A loss is never a "best trade". */
export function bestTrades(trades: readonly SettledTrade[], limit = 3): BestTrade[] {
  return trades
    .filter((trade) => trade.tone === 'up')
    .sort((a, b) => Number(b.pnl) - Number(a.pnl) || b.at - a.at)
    .slice(0, limit)
    .map((trade, index) => {
      const what = [trade.market !== null ? baseOf(trade.market) : null, trade.direction]
        .filter((part): part is string => part !== null)
        .join(' ');
      return {
        seq: trade.seq,
        title: `Trade #${index + 1}${what ? ` · ${what}` : ''}`,
        pnl: pnlLabel(trade.pnl),
        caption: [
          trade.holdMs !== null ? `held ${formatDuration(trade.holdMs)}` : null,
          shortDate(trade.at),
        ]
          .filter((part): part is string => part !== null)
          .join(' · '),
      };
    });
}

export type HistoryDay = {
  key: string;
  /** `Today · Sep 27` or `Sep 26`. */
  label: string;
  /** The day's realised total from its verdicts, or `null` when none settled. */
  pnl: string | null;
  tone: Tone;
  /** Newest first. */
  entries: LedgerEntry[];
};

/** The spine grouped by UTC day, newest day first, each with its realised total. */
export function historyDays(entries: readonly LedgerEntry[], now: number): HistoryDay[] {
  const newest = [...entries].sort((a, b) => b.seq - a.seq);
  const days: HistoryDay[] = [];
  for (const entry of newest) {
    const key = dayKey(entry.at);
    let day = days[days.length - 1];
    if (day?.key !== key) {
      day = {
        key,
        label: key === dayKey(now) ? `Today · ${shortDate(entry.at)}` : shortDate(entry.at),
        pnl: null,
        tone: null,
        entries: [],
      };
      days.push(day);
    }
    day.entries.push(entry);
  }
  for (const day of days) {
    const pnls = day.entries
      .filter((entry): entry is VerdictEntry => entry.kind === 'verdict')
      .filter((entry) => entry.origin === 'verdict' && entry.pnl !== null)
      .map((entry) => entry.pnl as string);
    const total = sumDecimals(pnls);
    if (total !== null) {
      day.pnl = pnlLabel(total);
      day.tone = pnlTone(total, PNL_LABEL_PLACES);
    }
  }
  return days;
}

// ---------------------------------------------------------------------------
// Mandate card

/** The rules as one sentence; `strong` parts are the limits, set in bold. */
export type RulePart = { text: string; strong: boolean };

/**
 * `Range Hunter may trade MON-USDC on Kuru spot, up to 250 USDC an order and
 * 400 USDC a day, with no leverage, until Oct 5. Its funds can only go back to
 * you.` — the mandate's limits in the order a person asks about them. Every
 * figure is the mandate's own; the enforcement detail is the gauges' job.
 */
export function rulesSentence(agent: Pick<Agent, 'name' | 'mandate'>): RulePart[] {
  const { mandate } = agent;
  const parts: RulePart[] = [{ text: `${agent.name} may trade `, strong: false }];
  const venues: string[] = [];
  if (mandate.venues.includes('kuru')) {
    const markets = mandate.kuru.markets.map((address) => marketFor(address)?.symbol ?? address);
    venues.push(`${markets.join(', ') || 'nothing'} on Kuru spot`);
  }
  if (mandate.venues.includes('perpl')) {
    venues.push(`${mandate.perpl.markets.join(', ') || 'nothing'} on Perpl perps`);
  }
  parts.push({ text: venues.join(' and ') || 'nothing', strong: true });

  const quote = quoteUnit(mandate.venues);
  parts.push({ text: ', up to ', strong: false });
  parts.push({
    text: `${formatNotional(mandate.maxOrderNotional)} ${quote} an order`,
    strong: true,
  });
  if (mandate.rollingCap) {
    const token = tokenFor(mandate.rollingCap.token);
    const hours = Math.round(mandate.rollingCap.windowSeconds / 3600);
    const cap = token
      ? formatCap(mandate.rollingCap.capAtoms, token.decimals)
      : mandate.rollingCap.capAtoms.toString();
    parts.push({ text: ' and ', strong: false });
    parts.push({
      text:
        `${cap} ${token?.symbol ?? ''}`.trimEnd() + (hours === 24 ? ' a day' : ` per ${hours}h`),
      strong: true,
    });
  }
  parts.push({ text: ', ', strong: false });
  parts.push(
    mandate.venues.includes('perpl')
      ? { text: `up to ${mandate.perpl.maxLeverage}× leverage`, strong: true }
      : { text: 'with no leverage', strong: false },
  );
  parts.push({ text: ', until ', strong: false });
  parts.push({ text: shortDate(mandate.expiresAt * 1000), strong: true });
  parts.push({
    text: mandate.returnTo
      ? '. Its funds can only go back to you.'
      : '. It has no way to send funds back — amend it to add one.',
    strong: false,
  });
  return parts;
}

function quoteUnit(venues: readonly string[]): string {
  const kuru = venues.includes('kuru');
  const perpl = venues.includes('perpl');
  if (kuru && !perpl) return 'USDC';
  if (perpl && !kuru) return 'AUSD';
  return 'quote units';
}

/** Whole units only, grouped: a cap is a round number, and cents on it are noise. */
function formatCap(atoms: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = atoms / unit;
  const fraction = atoms % unit;
  const text = groupThousands(whole.toString());
  if (fraction === 0n) return text;
  const digits = fraction.toString().padStart(decimals, '0').replace(/0+$/u, '');
  return `${text}.${digits}`;
}

/**
 * `signed Sep 21 · amended Sep 26`. The summary's `mandateSince` moves on each
 * amend; a gap of under a minute from the hire is the hire itself.
 */
export function mandateSigned(createdAt: string, mandateSince: number | undefined): string {
  const hired = Date.parse(createdAt);
  if (!Number.isFinite(hired)) return '';
  const signed = `signed ${shortDate(hired)}`;
  return mandateSince !== undefined && mandateSince - hired > MINUTE
    ? `${signed} · amended ${shortDate(mandateSince)}`
    : signed;
}

/** `180 of 250 USDC`: the proof line for order size, which is Sente's check, not a gauge. */
export function largestOrderLine(
  summary: Pick<AgentSummary, 'largestOrderNotional'> | undefined,
  mandate: Agent['mandate'],
): string {
  const cap = `${formatNotional(mandate.maxOrderNotional)} ${quoteUnit(mandate.venues)}`;
  const largest = summary?.largestOrderNotional;
  if (largest === undefined) return `cap ${cap}`;
  if (largest === null) return `none yet, cap ${cap}`;
  return `${formatNotional(largest)} of ${cap}`;
}

// ---------------------------------------------------------------------------
// Cadence

/** The choices the Overview offers; `null` is "only when you run it". 60..86400 s on the wire. */
export const CADENCES: readonly { label: string; seconds: number | null }[] = [
  { label: 'Manual', seconds: null },
  { label: '5m', seconds: 5 * 60 },
  { label: '15m', seconds: 15 * 60 },
  { label: '1h', seconds: 60 * 60 },
  { label: '4h', seconds: 4 * 60 * 60 },
  { label: '1d', seconds: 24 * 60 * 60 },
];

/** `every 15m`, `every 1h 30m` — any cadence, including one set elsewhere. */
export function cadenceLabel(seconds: number): string {
  return `every ${formatDuration(seconds * 1000)}`;
}

const PAUSE_WORDS: Record<string, string> = {
  credits_low: 'credits are low',
  credits_exhausted: 'credits ran out',
  credits_unavailable: 'credits couldn’t be read',
  daily_cap: 'it hit today’s run cap',
};

/**
 * The line under the cadence chips. With the schedule route (B-T13) it says
 * when the next check is, or why the scheduler is holding off; without it, it
 * says only what the agent record knows — the cadence it asked for.
 */
export function scheduleLine(
  status: AgentScheduleStatusDto | null,
  own: { everySeconds: number } | null | undefined,
  now: number,
): string {
  if (status === null) {
    return own
      ? `Checks the markets ${cadenceLabel(own.everySeconds)}.`
      : 'Runs only when you run it.';
  }
  if (status.paused) {
    const why = PAUSE_WORDS[status.paused.reason] ?? status.paused.reason;
    const until = status.paused.until ? Date.parse(status.paused.until) : NaN;
    return Number.isFinite(until) && until > now
      ? `Paused because ${why}, for ${formatDuration(until - now)}.`
      : `Paused because ${why}.`;
  }
  if (status.everySeconds === null) return 'Runs only when you run it.';
  const whose = status.source === 'global' ? ' (Sente’s default)' : '';
  const next = status.nextRunAt ? Date.parse(status.nextRunAt) : NaN;
  const when = Number.isFinite(next)
    ? next <= now
      ? ' Next check is due now.'
      : ` Next check in ${formatDuration(next - now)}.`
    : '';
  return `Checks the markets ${cadenceLabel(status.everySeconds)}${whose}.${when}`;
}
