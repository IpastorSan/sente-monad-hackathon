/**
 * `GET /portfolio/history` for the hero's chosen range (SEN-152). Behind the
 * manual-trading flag like `/portfolio`, so it is asked for only with the
 * flag on; an API without the route leaves `data` null and the hero falls
 * back to what the phone observed.
 */
import { usePolling, type Polled } from '@/markets/usePolling';
import { useSession } from '@/session';

import { rangeQuery, type HeroRange, type ValueHistory } from './history';

/** A point lands hourly (or after a trade): a minute is plenty to pick it up. */
const HISTORY_MS = 60_000;

export function useValueHistory(trading: boolean, range: HeroRange): Polled<ValueHistory> {
  const { trade } = useSession();
  return usePolling(
    trading && trade ? `portfolio:history:${range}` : null,
    () => trade!.valueHistory(rangeQuery(range)),
    // Recorded points are history, never "stale" the way a live price is.
    { intervalMs: HISTORY_MS, stale: () => false },
  );
}
