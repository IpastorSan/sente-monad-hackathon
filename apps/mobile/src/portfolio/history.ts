/**
 * The Portfolio hero's line over time (SEN-152): what `GET /portfolio/history`
 * recorded, with the live total as its newest point.
 *
 * Pure, like `view.ts`, so `history.test.ts` pins it under plain `node --test`.
 * The wire types copy `services/api/src/portfolio/history/value-history.dto.ts`
 * — change one and change the other.
 *
 * Before the server has a point in the chosen range, the hero keeps its
 * "since you opened" line (`useObservedValue`); nothing here invents history.
 */
import { seriesChange, shortDate, type ValueSample } from './view.ts';
import type { Direction } from '../ui/tradingFormat.ts';

export type HistoryRange = '1d' | '1w' | '1m' | 'all';

export type ValuePoint = { at: number; usd: string; partial?: true };

export type ValueHistory = {
  range: HistoryRange;
  asOf: number;
  from: number;
  points: ValuePoint[];
  partial: boolean;
  everyMs: number;
  note: string;
};

/** The design's pills, in order: `1D 1W 1M ALL`. */
export const HERO_RANGES = ['1D', '1W', '1M', 'ALL'] as const;
export type HeroRange = (typeof HERO_RANGES)[number];

export function rangeQuery(range: HeroRange): HistoryRange {
  return range.toLowerCase() as HistoryRange;
}

export type HeroLine = {
  points: ValueSample[];
  change: { delta: string; pct: number | null; tone: Direction } | null;
  /** After the change: ` today`, ` this week`, ` since Sep 3`. */
  suffix: string;
  /** Some point left out a venue, an agent or a price that did not answer. */
  partial: boolean;
};

/**
 * The recorded points of `history` (oldest first) ending at the live total:
 * the line, and the change under the big number, always end where that number
 * is (SEN-179). A recorded point at or after the live read is dropped rather
 * than left as the endpoint, so a snapshot taken from an older cached read
 * can never stand in for the total on screen. `null` while the range holds no
 * recorded point before the live one.
 */
export function heroLine(
  history: ValueHistory | null,
  range: HeroRange,
  live: ValueSample | null,
): HeroLine | null {
  if (history === null || history.points.length === 0) return null;
  const points: ValueSample[] = history.points
    .filter((p) => live === null || p.at < live.at)
    .map(({ at, usd }) => ({ at, usd }));
  if (live !== null) points.push(live);
  if (points.length < 2) return null;
  return {
    points,
    change: seriesChange(points),
    suffix: rangeSuffix(range, points[0]?.at ?? history.from),
    partial: history.points.some((p) => p.partial === true),
  };
}

function rangeSuffix(range: HeroRange, first: number): string {
  switch (range) {
    case '1D':
      return ' today';
    case '1W':
      return ' this week';
    case '1M':
      return ' this month';
    case 'ALL':
      return ` since ${shortDate(first)}`;
  }
}

/** Said under the chart when it applies, so a dip from a venue outage is not read as a loss. */
export const PARTIAL_NOTE =
  'Some points leave out a venue, agent or price that didn’t answer at the time.';
