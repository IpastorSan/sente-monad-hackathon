/**
 * One polling loop for every market-data hook (SEN-110, plan U-4).
 *
 * Polls only while the screen is focused AND the app is in the foreground:
 * market data is only worth its request while someone can see it, and a
 * backgrounded phone polling every 2 s is battery and API budget for nothing.
 * Coming back re-fetches at once rather than waiting out the interval.
 *
 * Requests are sequential (the next one is scheduled after the last settles),
 * failures back off, and an API that has no such route (see `isUnavailable`)
 * is not polled again until the screen is re-entered — plan-mobile treats that
 * as "not available yet", not as an error to keep retrying every tick.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { isUnavailable, MarketsApiError } from '@/markets/api';
import { STALE_AFTER_MS } from '@/ui/tradingFormat';
import { asError } from '@/wallet/api';

export type Polled<T> = {
  /** The last good answer for the current `key`; `null` until one arrives. */
  data: T | null;
  /** When the server produced `data` (ms). `null` without data. */
  asOf: number | null;
  /**
   * The numbers may no longer be live: the server flagged them stale, the last
   * poll failed, or they were already older than `STALE_AFTER_MS` when read.
   */
  stale: boolean;
  /** The last failure, cleared by the next good poll. Never set for `unavailable`. */
  error: Error | null;
  /** The API predates this route (404 with no reason): hide the section. */
  unavailable: boolean;
  /** Poll now, e.g. on pull-to-refresh. */
  refresh: () => void;
};

export type PollOptions<T> = {
  intervalMs: number;
  /** Server timestamp of an answer; defaults to its `asOf` field. */
  asOf?: (data: T) => number;
  /** The server's own staleness flag; defaults to its `stale` field. */
  stale?: (data: T) => boolean;
};

type Snapshot<T> = {
  key: string | null;
  data: T | null;
  failed: boolean;
  error: Error | null;
  unavailable: boolean;
};

const MAX_BACKOFF_MS = 60_000;

/**
 * @param key identifies the request. A new key drops the old data at once,
 *   so a screen never shows the previous symbol's numbers under a new title.
 *   `null` means "nothing to poll" (no session, or incomplete input).
 * @param fetcher performs the request. Read through a ref, so an inline
 *   closure does not restart the loop; only `key` does.
 */
export function usePolling<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  { intervalMs, asOf = defaultAsOf, stale = defaultStale }: PollOptions<T>,
): Polled<T> {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>(() => empty(key));
  const [focused, setFocused] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [nudge, setNudge] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setForeground(state === 'active'),
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (key === null || !focused || !foreground) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = intervalMs;

    const run = async (): Promise<void> => {
      try {
        const data = await fetcherRef.current();
        if (stopped) return;
        setSnapshot({ key, data, failed: false, error: null, unavailable: false });
        delay = intervalMs;
      } catch (caught) {
        if (stopped) return;
        if (isUnavailable(caught)) {
          setSnapshot({ ...empty(key), unavailable: true });
          return; // no route to poll; re-entering the screen tries again
        }
        // Keep the last good data on a failed poll: stale numbers marked
        // stale beat a blank screen.
        setSnapshot((current) => ({
          ...(current.key === key ? current : empty(key)),
          failed: true,
          error: asError(caught),
          unavailable: false,
        }));
        const hinted = caught instanceof MarketsApiError ? caught.retryAfterMs : undefined;
        delay = Math.min(Math.max(delay * 2, hinted ?? 0), MAX_BACKOFF_MS);
      }
      if (!stopped) timer = setTimeout(() => void run(), delay);
    };

    void run();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, focused, foreground, intervalMs, nudge]);

  const refresh = useCallback(() => setNudge((n) => n + 1), []);

  // A snapshot for another key is last screen's data: never show it.
  const current = snapshot.key === key ? snapshot : empty<T>(key);
  const data = current.data;
  const at = data === null ? null : asOf(data);
  return {
    data,
    asOf: at,
    stale:
      data !== null &&
      (stale(data) || current.failed || (at !== null && Date.now() - at > STALE_AFTER_MS)),
    error: current.error,
    unavailable: current.unavailable,
    refresh,
  };
}

function empty<T>(key: string | null): Snapshot<T> {
  return { key, data: null, failed: false, error: null, unavailable: false };
}

function defaultAsOf(data: unknown): number {
  const value = (data as { asOf?: unknown }).asOf;
  return typeof value === 'number' ? value : Date.now();
}

function defaultStale(data: unknown): boolean {
  return (data as { stale?: unknown }).stale === true;
}
