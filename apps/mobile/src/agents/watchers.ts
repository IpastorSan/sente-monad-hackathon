/**
 * What the Watchers section SAYS (SEN-182): each watcher's condition as a
 * plain sentence, its firing history, the section's summary line, and the
 * edit sheet's form for the common cases.
 *
 * Pure, like `cockpit.ts`: no React, no React Native, so `watchers.test.ts`
 * pins every string under plain `node --test`. The condition is rendered from
 * its clauses rather than the API's own `reads`, because the app speaks to an
 * owner ("crosses above") and the API's wording is written for the model.
 */
import type {
  AgentMandate,
  AgentWatchersDto,
  IndicatorSpecDto,
  VenueId,
  WatcherBody,
  WatcherClauseDto,
  WatcherComparison,
  WatcherDto,
} from './api.ts';
import { marketFor } from './mandate.ts';
import { formatDuration, relativeAge } from './usage.ts';

/** A run of a sentence. `value` runs carry the numbers and names the owner set. */
export type Part = { text: string; value?: true };

const v = (text: string): Part => ({ text, value: true });
const t = (text: string): Part => ({ text });

const COMPARE: Record<WatcherComparison, string> = {
  above: 'is above',
  below: 'is below',
  crosses_above: 'crosses above',
  crosses_below: 'crosses below',
};

/** A number as an owner reads it: grouped thousands, no float noise. */
export function formatLevel(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

const INDICATOR_NAMES: Record<string, string> = {
  sma: 'SMA',
  ema: 'EMA',
  wma: 'WMA',
  rsi: 'RSI',
  atr: 'ATR',
  adx: 'ADX',
  macd: 'MACD',
  stochastic: 'Stochastic',
  bollinger: 'Bollinger',
  vwap: 'VWAP',
  obv: 'OBV',
  force_index: 'Force index',
  elder_ray: 'Elder ray',
};

/** Outputs named the way a chart labels them. */
const OUTPUT_NAMES: Record<string, string> = {
  line: 'line',
  signal: 'signal line',
  histogram: 'histogram',
  upper: 'upper band',
  middle: 'middle band',
  lower: 'lower band',
  percentB: '%B',
  bandwidth: 'bandwidth',
  k: '%K',
  d: '%D',
  plusDi: '+DI',
  minusDi: '−DI',
  bullPower: 'bull power',
  bearPower: 'bear power',
};

/** `RSI 14`, `MACD`, `EMA 50`: the defaults left unsaid. */
export function indicatorName(spec: IndicatorSpecDto): string {
  const name = INDICATOR_NAMES[spec.type] ?? spec.type.toUpperCase();
  const period = spec['period'];
  return typeof period === 'number' ? `${name} ${period}` : name;
}

function operandName(spec: IndicatorSpecDto, output: string | undefined): string {
  if (output === undefined || output === 'value') return indicatorName(spec);
  return `${indicatorName(spec)} ${OUTPUT_NAMES[output] ?? output}`;
}

function sameSpec(a: IndicatorSpecDto, b: IndicatorSpecDto | undefined): boolean {
  return b === undefined || JSON.stringify(a) === JSON.stringify(b);
}

/** One clause as a sentence, in runs. */
export function clauseParts(clause: WatcherClauseDto): Part[] {
  switch (clause.type) {
    case 'price':
      return [
        v(clause.market),
        t(clause.source === 'last' ? ' last trade ' : ' price '),
        t(COMPARE[clause.op]),
        t(' '),
        v(formatLevel(clause.value)),
      ];
    case 'price_band': {
      const verb = {
        inside: 'is inside',
        outside: 'is outside',
        enters: 'enters',
        leaves: 'leaves',
      }[clause.op];
      return [
        v(clause.market),
        t(` price ${verb} `),
        v(`${formatLevel(clause.low)} – ${formatLevel(clause.high)}`),
      ];
    }
    case 'indicator': {
      const left = operandName(clause.indicator, clause.output);
      let right: Part;
      if (clause.compareTo) {
        const other = clause.compareTo.indicator;
        right = sameSpec(clause.indicator, other)
          ? t(
              `its ${OUTPUT_NAMES[clause.compareTo.output ?? ''] ?? clause.compareTo.output ?? 'value'}`,
            )
          : v(operandName(other!, clause.compareTo.output));
      } else {
        right = v(formatLevel(clause.value ?? Number.NaN));
      }
      return [
        v(clause.market),
        t(' '),
        v(clause.timeframe),
        t(': '),
        v(left),
        t(` ${COMPARE[clause.op]} `),
        right,
      ];
    }
    case 'position':
      if (clause.op === 'opened' || clause.op === 'closed') {
        return [
          t('Its '),
          v(clause.market),
          t(` position ${clause.op === 'opened' ? 'opens' : 'closes'}`),
        ];
      }
      return [
        t('Its '),
        v(clause.market),
        t(` P&L ${clause.op === 'pnl_above' ? 'is above' : 'is below'} `),
        v(`${formatLevel(clause.value ?? Number.NaN)}%`),
        t(' of margin'),
      ];
    case 'funding':
      return [
        v(clause.market),
        t(` funding ${COMPARE[clause.op]} `),
        v(`${formatLevel(clause.value)}%`),
        t(' per 8h'),
      ];
  }
}

/** A whole watcher as runs: its clauses joined by "and" or "or". */
export function watcherParts(watcher: Pick<WatcherDto, 'match' | 'clauses'>): Part[] {
  const joiner = t(watcher.match === 'any' ? ' or ' : ' and ');
  return watcher.clauses.flatMap((clause, i) => {
    const parts = clauseParts(clause);
    // Only the first clause opens the sentence with a capital.
    if (i > 0 && parts[0]?.text === 'Its ') parts[0] = t('its ');
    return i === 0 ? parts : [joiner, ...parts];
  });
}

export function describeWatcher(watcher: Pick<WatcherDto, 'match' | 'clauses'>): string {
  return watcherParts(watcher)
    .map((part) => part.text)
    .join('');
}

const EDGE_OPS = new Set([
  'crosses_above',
  'crosses_below',
  'enters',
  'leaves',
  'opened',
  'closed',
]);

/** How it fires: once on the event, or while true with its cooldown between wakes. */
export function triggerLine(watcher: Pick<WatcherDto, 'clauses' | 'cooldownMinutes'>): string {
  const cooldown = formatDuration(watcher.cooldownMinutes * 60_000);
  return watcher.clauses.every((c) => EDGE_OPS.has(c.op))
    ? `Fires the moment it happens, then rests ${cooldown}`
    : `Fires while true, at most once every ${cooldown}`;
}

/** Its history: `Never fired`, `Fired once, 12m ago`, `Fired 4 times, last 2h ago`. */
export function firedLine(
  watcher: Pick<WatcherDto, 'fireCount' | 'lastFiredAt'>,
  now: number,
): string {
  const last = watcher.lastFiredAt ? Date.parse(watcher.lastFiredAt) : Number.NaN;
  if (watcher.fireCount === 0 || !Number.isFinite(last)) return 'Never fired';
  const age = relativeAge(last, now);
  const ago = age === 'now' ? 'just now' : `${age} ago`;
  return watcher.fireCount === 1
    ? `Fired once, ${ago}`
    : `Fired ${watcher.fireCount} times, last ${ago}`;
}

/**
 * The section's line: what the watchers cost and saved.
 * `Checked every 5m without the model · woke it 3 times · saved ~214 model calls`.
 */
export function watchersSummary(
  dto: Pick<AgentWatchersDto, 'everySeconds' | 'wakes' | 'modelCallsSaved' | 'watchers'>,
): string {
  if (dto.everySeconds === null) {
    return dto.watchers.length === 0
      ? 'It runs only when you run it, so there is nothing to watch for.'
      : 'Not checked: it runs only when you run it. Pick a cadence to have these checked.';
  }
  const every = `every ${formatDuration(dto.everySeconds * 1000)}`;
  if (dto.watchers.length === 0) {
    return `None set, so the model runs ${every}. The agent can set watchers, or you can add one.`;
  }
  const woke = dto.wakes === 1 ? 'woke it once' : `woke it ${dto.wakes} times`;
  const saved = dto.modelCallsSaved === 1 ? '1 model call' : `${dto.modelCallsSaved} model calls`;
  return `Checked ${every} without the model · ${woke} · saved ~${saved}`;
}

// ─── The edit sheet ─────────────────────────────────────────────────────────

export type WatcherFormKind = 'price' | 'rsi' | 'macd' | 'pnl';

export type WatcherForm = {
  kind: WatcherFormKind;
  label: string;
  market: string;
  /** price/rsi: a comparison; macd: crosses_above/crosses_below; pnl: above/below. */
  op: WatcherComparison;
  /** The level as typed. Unused for macd. */
  value: string;
  timeframe: string;
  cooldownMinutes: number;
};

export type MarketChoice = { symbol: string; venue: VenueId };

export const FORM_KINDS: readonly { value: WatcherFormKind; label: string }[] = [
  { value: 'price', label: 'Price' },
  { value: 'rsi', label: 'RSI' },
  { value: 'macd', label: 'MACD cross' },
  { value: 'pnl', label: 'P&L' },
];

export const FORM_TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;

export const FORM_COOLDOWNS: readonly { minutes: number; label: string }[] = [
  { minutes: 15, label: '15m' },
  { minutes: 60, label: '1h' },
  { minutes: 240, label: '4h' },
];

/** The ops each kind offers, with the words the sheet shows. */
export function formOps(kind: WatcherFormKind): { value: WatcherComparison; label: string }[] {
  switch (kind) {
    case 'macd':
      return [
        { value: 'crosses_above', label: 'Line crosses above signal' },
        { value: 'crosses_below', label: 'Line crosses below signal' },
      ];
    case 'pnl':
      return [
        { value: 'above', label: 'Above' },
        { value: 'below', label: 'Below' },
      ];
    default:
      return [
        { value: 'crosses_above', label: 'Crosses above' },
        { value: 'crosses_below', label: 'Crosses below' },
        { value: 'above', label: 'Is above' },
        { value: 'below', label: 'Is below' },
      ];
  }
}

/** The markets a watcher may name: the mandate's, by symbol. */
export function marketChoices(mandate: AgentMandate): MarketChoice[] {
  const kuru = mandate.venues.includes('kuru')
    ? mandate.kuru.markets.flatMap((address) => {
        const market = marketFor(address);
        return market ? [{ symbol: market.symbol, venue: 'kuru' as const }] : [];
      })
    : [];
  const perpl = mandate.venues.includes('perpl')
    ? mandate.perpl.markets.map((symbol) => ({ symbol, venue: 'perpl' as const }))
    : [];
  return [...kuru, ...perpl];
}

export function emptyForm(markets: readonly MarketChoice[]): WatcherForm {
  return {
    kind: 'price',
    label: '',
    market: markets[0]?.symbol ?? '',
    op: 'crosses_above',
    value: '',
    timeframe: '15m',
    cooldownMinutes: 60,
  };
}

/**
 * The form for a watcher the sheet can edit — one clause of a kind it knows —
 * or `null` for anything richer, which the sheet then only describes.
 */
export function formOf(watcher: WatcherDto): WatcherForm | null {
  if (watcher.clauses.length !== 1) return null;
  const clause = watcher.clauses[0]!;
  const base = { label: watcher.label, cooldownMinutes: watcher.cooldownMinutes, timeframe: '15m' };
  if (clause.type === 'price' && clause.source !== 'last') {
    return {
      ...base,
      kind: 'price',
      market: clause.market,
      op: clause.op,
      value: String(clause.value),
    };
  }
  if (clause.type === 'indicator') {
    const spec = clause.indicator;
    const defaultRsi = spec.type === 'rsi' && (spec['period'] ?? 14) === 14;
    if (defaultRsi && clause.value !== undefined && !clause.compareTo) {
      return {
        ...base,
        kind: 'rsi',
        market: clause.market,
        op: clause.op,
        value: String(clause.value),
        timeframe: clause.timeframe,
      };
    }
    const defaultMacd =
      spec.type === 'macd' &&
      (spec['fast'] ?? 12) === 12 &&
      (spec['slow'] ?? 26) === 26 &&
      (spec['signal'] ?? 9) === 9;
    if (
      defaultMacd &&
      clause.output === 'line' &&
      clause.compareTo?.output === 'signal' &&
      sameSpec(spec, clause.compareTo.indicator) &&
      (clause.op === 'crosses_above' || clause.op === 'crosses_below')
    ) {
      return {
        ...base,
        kind: 'macd',
        market: clause.market,
        op: clause.op,
        value: '',
        timeframe: clause.timeframe,
      };
    }
    return null;
  }
  if (clause.type === 'position' && (clause.op === 'pnl_above' || clause.op === 'pnl_below')) {
    return {
      ...base,
      kind: 'pnl',
      market: clause.market,
      op: clause.op === 'pnl_above' ? 'above' : 'below',
      value: String(clause.value ?? ''),
    };
  }
  return null;
}

const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** The request body for a filled form, or what is wrong with it, in words. */
export function bodyOf(
  form: WatcherForm,
  markets: readonly MarketChoice[],
): { body: WatcherBody } | { error: string } {
  const label = form.label.trim();
  if (!label) return { error: 'Say what this watcher is for, in a few words.' };
  const market = markets.find((m) => m.symbol === form.market);
  if (!market) return { error: 'Pick one of the markets in its mandate.' };
  const raw = form.value.trim();
  const value = Number(raw);
  const needsValue = form.kind !== 'macd';
  if (needsValue && (!NUMBER.test(raw) || !Number.isFinite(value))) {
    return {
      error: form.kind === 'pnl' ? 'Enter a % of margin, like 5 or -3.' : 'Enter a number.',
    };
  }
  let clause: WatcherClauseDto;
  switch (form.kind) {
    case 'price':
      if (value <= 0) return { error: 'A price is above zero.' };
      clause = { type: 'price', venue: market.venue, market: market.symbol, op: form.op, value };
      break;
    case 'rsi':
      if (value < 0 || value > 100) return { error: 'RSI runs from 0 to 100.' };
      clause = {
        type: 'indicator',
        venue: market.venue,
        market: market.symbol,
        timeframe: form.timeframe,
        indicator: { type: 'rsi', period: 14 },
        op: form.op,
        value,
      };
      break;
    case 'macd':
      clause = {
        type: 'indicator',
        venue: market.venue,
        market: market.symbol,
        timeframe: form.timeframe,
        indicator: { type: 'macd' },
        output: 'line',
        op: form.op === 'crosses_below' ? 'crosses_below' : 'crosses_above',
        compareTo: { output: 'signal' },
      };
      break;
    case 'pnl':
      if (market.venue !== 'perpl') return { error: 'P&L watchers are for Perpl positions.' };
      clause = {
        type: 'position',
        market: market.symbol,
        op: form.op === 'below' ? 'pnl_below' : 'pnl_above',
        value,
      };
      break;
  }
  return {
    body: { label, match: 'all', clauses: [clause], cooldownMinutes: form.cooldownMinutes },
  };
}

/** An id for a watcher the owner adds: short, and not one the agent already uses. */
export function newWatcherId(existing: readonly { id: string }[], now: number): string {
  let n = now;
  let id: string;
  do id = `you-${(n++).toString(36).slice(-6)}`;
  while (existing.some((w) => w.id === id));
  return id;
}
