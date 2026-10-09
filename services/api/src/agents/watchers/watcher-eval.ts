/**
 * Checking watchers (SEN-182): deterministic, no model. Given what the market
 * reads say right now and what the previous check left behind, decide which
 * watchers fire and what to remember for the next check.
 *
 * - An EDGE clause is true only when its condition was false on the previous
 *   readable check and is true now. The first readable check only records.
 * - A LEVEL clause is true whenever its condition holds.
 * - A clause whose data cannot be read is "unknown": it is not true, and an
 *   edge keeps its previous answer, so an outage neither fires nor hides a
 *   cross that happens across it.
 * - A watcher fires when its clauses are true by its `match`, and it has not
 *   fired within its cooldown. Edges are recorded on every check, cooldown or
 *   not, so a cross during a cooldown is consumed rather than reported late.
 *
 * Indicators come from the SAME candles and math as `get_indicators`: the
 * shared market-data cache and `computeIndicator`.
 */
import type { VenueId } from '../../venues/dto/markets.dto';
import { computeIndicator, labelOf, type Candle, type IndicatorResult } from '../tools/indicators';
import type { StoredWatcher } from './watcher-store';
import {
  formatNumber,
  isEdge,
  operandLabel,
  type IndicatorClause,
  type WatcherClause,
} from './watcher.schema';

/** What a check reads. Every read may throw; that clause is then unknown. */
export interface WatcherReads {
  /** `last` and `mark` of a market, as numbers; null when the venue has none. */
  prices(venue: VenueId, market: string): Promise<{ last: number | null; mark: number | null }>;
  /** Candles oldest first, the newest possibly still forming, as `get_indicators` reads them. */
  candles(venue: VenueId, market: string, timeframe: string): Promise<readonly Candle[]>;
  /** The agent's open Perpl positions. */
  positions(): Promise<readonly { symbol: string; pnlPct: number | null }[]>;
  /** Funding, % per 8 hours; null when the venue has published none. */
  funding(market: string): Promise<number | null>;
}

/** One read per key per check, however many clauses share it. */
export function memoReads(reads: WatcherReads): WatcherReads {
  const cache = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    let hit = cache.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = read();
      cache.set(key, hit);
    }
    return hit;
  };
  return {
    prices: (venue, market) => once(`p|${venue}|${market}`, () => reads.prices(venue, market)),
    candles: (venue, market, tf) =>
      once(`c|${venue}|${market}|${tf}`, () => reads.candles(venue, market, tf)),
    positions: () => once('positions', () => reads.positions()),
    funding: (market) => once(`f|${market}`, () => reads.funding(market)),
  };
}

type ClauseReading =
  /** `holds`: the condition (for an edge, the side it flips to) is true now. */
  | { readonly known: true; readonly holds: boolean; readonly observed: string }
  | { readonly known: false; readonly error: string };

class Unknown extends Error {}

/** The latest finite value of an indicator output, or Unknown before warm-up. */
/**
 * Indicator results of one check, per candle series and spec: a MACD line
 * against its own signal, or several watchers on one indicator, compute it once.
 */
type IndicatorCache = WeakMap<readonly Candle[], Map<string, IndicatorResult>>;

function latest(
  cache: IndicatorCache,
  candles: readonly Candle[],
  spec: IndicatorClause['indicator'],
  output: string,
) {
  let bySpec = cache.get(candles);
  if (!bySpec) cache.set(candles, (bySpec = new Map()));
  const key = JSON.stringify(spec);
  let result = bySpec.get(key);
  if (!result) bySpec.set(key, (result = computeIndicator(spec, candles)));
  const value = result.outputs[output]?.values.at(-1);
  if (value === undefined || !Number.isFinite(value)) {
    throw new Unknown(
      `${labelOf(spec)} needs ${result.minCandles} candles and has ${candles.length}`,
    );
  }
  return value;
}

/** `a` against `b` by `op`, where a crossing's side is "strictly past". */
function compare(op: string, a: number, b: number): boolean {
  return op === 'above' || op === 'crosses_above' ? a > b : a < b;
}

const VERB: Record<string, [string, string]> = {
  // [what an edge firing says, what a level says]
  above: ['', 'is above'],
  below: ['', 'is below'],
  crosses_above: ['crossed above', 'is above'],
  crosses_below: ['crossed below', 'is below'],
};

function verbOf(op: string, holds: boolean): string {
  const [edge, levelWord] = VERB[op] ?? ['', op];
  if (!holds) return op.endsWith('above') ? 'is not above' : 'is not below';
  return edge || levelWord;
}

async function readClause(
  clause: WatcherClause,
  reads: WatcherReads,
  cache: IndicatorCache,
): Promise<ClauseReading> {
  try {
    switch (clause.type) {
      case 'price': {
        const price = (await reads.prices(clause.venue, clause.market))[clause.source];
        if (price === null) throw new Unknown(`${clause.market} has no ${clause.source} price`);
        const holds = compare(clause.op, price, clause.value);
        return {
          known: true,
          holds,
          observed:
            `${clause.market} ${clause.source} ${formatNumber(price)} ` +
            `${verbOf(clause.op, holds)} ${formatNumber(clause.value)}`,
        };
      }
      case 'price_band': {
        const price = (await reads.prices(clause.venue, clause.market))[clause.source];
        if (price === null) throw new Unknown(`${clause.market} has no ${clause.source} price`);
        const inside = price >= clause.low && price <= clause.high;
        const holds = clause.op === 'inside' || clause.op === 'enters' ? inside : !inside;
        const band = `${formatNumber(clause.low)}–${formatNumber(clause.high)}`;
        const word = holds
          ? { inside: 'is inside', outside: 'is outside', enters: 'entered', leaves: 'left' }[
              clause.op
            ]
          : inside
            ? 'is inside'
            : 'is outside';
        return {
          known: true,
          holds,
          observed: `${clause.market} ${clause.source} ${formatNumber(price)} ${word} ${band}`,
        };
      }
      case 'indicator': {
        const candles = await reads.candles(clause.venue, clause.market, clause.timeframe);
        const output = clause.output ?? 'value';
        const left = latest(cache, candles, clause.indicator, output);
        let right: number;
        let rightLabel: string;
        if (clause.compareTo) {
          const spec = clause.compareTo.indicator ?? clause.indicator;
          const other = clause.compareTo.output ?? 'value';
          right = latest(cache, candles, spec, other);
          rightLabel = `${operandLabel(spec, other)} ${formatNumber(right)}`;
        } else {
          right = clause.value ?? NaN;
          rightLabel = formatNumber(right);
        }
        const holds = compare(clause.op, left, right);
        return {
          known: true,
          holds,
          observed:
            `${clause.market} ${clause.timeframe} ${operandLabel(clause.indicator, output)} ` +
            `${formatNumber(left)} ${verbOf(clause.op, holds)} ${rightLabel}`,
        };
      }
      case 'position': {
        const position = (await reads.positions()).find((p) => p.symbol === clause.market);
        if (clause.op === 'opened' || clause.op === 'closed') {
          const open = position !== undefined;
          return {
            known: true,
            holds: clause.op === 'opened' ? open : !open,
            observed: `your ${clause.market} position is ${open ? 'open' : 'closed'}`,
          };
        }
        if (!position) throw new Unknown(`no open ${clause.market} position`);
        if (position.pnlPct === null) throw new Unknown(`${clause.market} P&L has no margin`);
        const holds = compare(
          clause.op === 'pnl_above' ? 'above' : 'below',
          position.pnlPct,
          clause.value ?? NaN,
        );
        return {
          known: true,
          holds,
          observed:
            `your ${clause.market} P&L ${formatNumber(position.pnlPct)}% of margin ` +
            `${holds ? (clause.op === 'pnl_above' ? 'is above' : 'is below') : 'is not past'} ` +
            `${formatNumber(clause.value ?? NaN)}%`,
        };
      }
      case 'funding': {
        const rate = await reads.funding(clause.market);
        if (rate === null) throw new Unknown(`${clause.market} has no funding rate yet`);
        const holds = compare(clause.op, rate, clause.value);
        return {
          known: true,
          holds,
          observed:
            `${clause.market} funding ${formatNumber(rate)}%/8h ` +
            `${verbOf(clause.op, holds)} ${formatNumber(clause.value)}%/8h`,
        };
      }
    }
  } catch (error) {
    return {
      known: false,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    };
  }
}

export interface Firing {
  readonly id: string;
  readonly label: string;
  /** What the clauses that made it fire saw, in words. */
  readonly observed: string;
}

export interface WatcherCheck {
  /** The watchers as they should be stored after this check. */
  readonly watchers: StoredWatcher[];
  readonly fired: Firing[];
}

/** Checks every watcher once against `reads`, at `now` (Unix ms). */
export async function checkWatchers(
  watchers: readonly StoredWatcher[],
  reads: WatcherReads,
  now: number,
): Promise<WatcherCheck> {
  const memo = memoReads(reads);
  const cache: IndicatorCache = new WeakMap();
  const fired: Firing[] = [];
  const next = await Promise.all(
    watchers.map(async (watcher) => {
      const readings = await Promise.all(watcher.clauses.map((c) => readClause(c, memo, cache)));
      const hits: boolean[] = [];
      const edges = watcher.clauses.map((clause, i) => {
        const reading = readings[i]!;
        const previous = watcher.edges[i] ?? null;
        if (!isEdge(clause)) {
          hits.push(reading.known && reading.holds);
          return null;
        }
        if (!reading.known) {
          hits.push(false);
          return previous;
        }
        hits.push(previous === false && reading.holds);
        return reading.holds;
      });
      const matched = watcher.match === 'all' ? hits.every(Boolean) : hits.some(Boolean);
      const cooling =
        watcher.lastFiredAt !== null &&
        now < watcher.lastFiredAt + watcher.cooldownMinutes * 60_000;
      const errors = readings.flatMap((r) => (r.known ? [] : [r.error]));
      const base: StoredWatcher = {
        ...watcher,
        edges,
        lastEvaluatedAt: now,
        lastError: errors.length > 0 ? errors.join('; ') : null,
      };
      if (!matched || cooling) return base;
      const observed = readings
        .flatMap((r, i) => (r.known && hits[i] ? [r.observed] : []))
        .join('; ');
      fired.push({ id: watcher.id, label: watcher.label, observed });
      return {
        ...base,
        lastFiredAt: now,
        fireCount: watcher.fireCount + 1,
        lastObserved: observed,
      };
    }),
  );
  return { watchers: next, fired };
}
