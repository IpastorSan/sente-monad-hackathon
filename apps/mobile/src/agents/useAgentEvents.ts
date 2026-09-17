/**
 * The Ledger's live tail (SEN-23).
 *
 * Polls `GET /agents/:id/events` with a `seq` cursor while the screen is
 * focused, and stops on blur. The cadence is deliberate: 1s while the agent is
 * doing something, backing off to 10s once the trail stops moving, because an
 * agent that trades twice an hour should not cost a request a second in
 * between. Anything new resets the cadence immediately.
 *
 * Polling rather than a socket on purpose: the event log is in the API's
 * memory today (SEN-20 is explicit that persistence is its own issue), so there
 * is no stream to subscribe to yet. When there is one, only `run` changes.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { toLedgerEntries, type LedgerEntry } from '@/agents/ledger';
import { useSession } from '@/session';

/** How many events the first page asks for: enough to fill a screenful and then some. */
const FIRST_PAGE = 100;
const POLL_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;

export type AgentEvents = {
  /** Oldest first, as the API pages them. The screen reverses for display. */
  entries: LedgerEntry[];
  /** True once a page has come back, successfully or not. */
  loaded: boolean;
  /** The last failure's message, cleared by the next good poll. */
  error: string | null;
};

export function useAgentEvents(id: string | undefined): AgentEvents {
  const { agents: api } = useSession();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A ref, not state: the cursor must not re-run the effect, and it must
  // survive a blur/focus cycle so re-entering the screen does not re-read the
  // whole log.
  const cursor = useRef(0);
  const started = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (!api || !id) return;

      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let delay = POLL_MS;

      const run = async (): Promise<void> => {
        if (stopped) return;
        try {
          const page = await api.events(
            id,
            started.current ? cursor.current : undefined,
            FIRST_PAGE,
          );
          if (stopped) return;
          if (page.events.length > 0) {
            cursor.current = Math.max(cursor.current, page.nextSeq);
            const fresh = toLedgerEntries(page.events);
            // Appending is safe because the mapping sorts by `seq`, so a page
            // that overlaps what we already hold cannot reorder the list.
            setEntries((current) => [...current, ...fresh]);
            delay = POLL_MS;
          } else if (started.current) {
            delay = Math.min(delay * 2, MAX_BACKOFF_MS);
          }
          started.current = true;
          setLoaded(true);
          setError(null);
        } catch (caught) {
          if (stopped) return;
          started.current = true;
          setError(caught instanceof Error ? caught.message : String(caught));
          setLoaded(true);
          // A failing API is not polled at 1s.
          delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        }
        // Scheduled after the request settles, never in parallel with it.
        if (!stopped) timer = setTimeout(() => void run(), delay);
      };

      void run();

      return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [api, id]),
  );

  return { entries, loaded, error };
}
