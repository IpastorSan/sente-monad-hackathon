/**
 * A range of value snapshots, cut down to what a phone chart can draw (SEN-152).
 *
 * The window is split into equal time buckets and each keeps its LAST point,
 * so the newest value is always the newest point drawn, and gaps in time stay
 * gaps rather than being evened out by index. The window's first point is kept
 * as well: it is the baseline the change line measures from.
 */
import type { ValueSnapshot } from './value-history.store';
import type { HistoryRange } from './value-history.dto';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RANGE_MS: Record<Exclude<HistoryRange, 'all'>, number> = {
  '1d': DAY,
  '1w': 7 * DAY,
  '1m': 30 * DAY,
};

/** About one point per 3 px across a phone's width: more is not visible. */
export const MAX_POINTS = 120;

export function windowStart(
  snapshots: readonly ValueSnapshot[],
  range: HistoryRange,
  now: number,
): number {
  return range === 'all' ? (snapshots[0]?.at ?? now) : now - RANGE_MS[range];
}

/** `snapshots` must be oldest first, as the store keeps them. */
export function downsample(
  snapshots: readonly ValueSnapshot[],
  from: number,
  to: number,
  maxPoints = MAX_POINTS,
): ValueSnapshot[] {
  const inside = snapshots.filter((s) => s.at >= from && s.at <= to);
  if (inside.length <= maxPoints) return inside;

  const width = (to - from) / maxPoints;
  const byBucket = new Map<number, ValueSnapshot>();
  for (const snapshot of inside) {
    const bucket = Math.min(maxPoints - 1, Math.floor((snapshot.at - from) / width));
    byBucket.set(bucket, snapshot);
  }
  const kept = [...byBucket.values()];
  const first = inside[0]!;
  return kept[0] === first ? kept : [first, ...kept];
}
