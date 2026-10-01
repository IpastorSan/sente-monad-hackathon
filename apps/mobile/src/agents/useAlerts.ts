/**
 * The Alerts feed as a hook (SEN-156): `GET /agents/activity` polled, turned
 * into alerts by `alerts.ts`, and the unread count against what this device
 * has seen. Home's bell and the Alerts screen both read it.
 *
 * Polled through `usePolling`, like every market hook: only while the screen
 * is focused and the app is in the foreground, so a backgrounded phone asks
 * for nothing. Push notifications are a later step; until then the feed is as
 * fresh as the last poll.
 *
 * The seen marks live in ONE `platform/kv` key, as `alerts.ts` describes
 * them. Not a secret, but the app already links the store and it is where the
 * other device-side lists live (`markets/localLists.ts`). A failed read is "no
 * state" and a failed write is dropped: a stale dot is not worth an error.
 * The marks are per agent id, so they do not need resetting on sign-out: a
 * different account's agents simply have no marks yet.
 */
import { useFocusEffect } from 'expo-router';
import * as SecureStore from '@/platform/kv';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  badgeLabel,
  markSeen,
  parseSeen,
  serializeSeen,
  toAlerts,
  unreadCount,
  type Alert,
  type Seen,
} from '@/agents/alerts';
import type { ActivityEvent } from '@/agents/api';
import { usePolling, type Polled } from '@/markets/usePolling';
import { useSession } from '@/session';

/** The route's own maximum page. */
export const ALERTS_PAGE = 50;

/**
 * Agents act on their schedule, minutes apart, so a quote-speed poll would be
 * requests for nothing; 30 s keeps the bell honest while Home is open.
 */
const POLL_MS = 30_000;

const SEEN_KEY = 'sente.alerts.seen';

export async function readSeen(): Promise<Seen | null> {
  try {
    return parseSeen(await SecureStore.getItemAsync(SEEN_KEY));
  } catch {
    return null;
  }
}

async function writeSeen(seen: Seen): Promise<void> {
  try {
    await SecureStore.setItemAsync(SEEN_KEY, serializeSeen(seen));
  } catch {
    // Best effort: see the header.
  }
}

const NONE: ActivityEvent[] = [];

export type AlertsFeed = {
  /** The raw page, newest first: Home's latest move and chart read it too. */
  events: ActivityEvent[];
  alerts: Alert[];
  /** `undefined` until the store has been read; `null` when it holds nothing. */
  seen: Seen | null | undefined;
  unread: number;
  /** The bell's badge text, or `null` for no badge. */
  badge: string | null;
  polled: Polled<ActivityEvent[]>;
  /** Records `alerts` as seen, on top of whatever the store holds now. */
  markSeen: (alerts: readonly Alert[]) => Promise<void>;
};

export function useAlerts(): AlertsFeed {
  const { agents: api } = useSession();
  const polled = usePolling(api ? 'agents.activity' : null, () => api!.activity(ALERTS_PAGE), {
    intervalMs: POLL_MS,
    // The page carries no server time; it is as fresh as the request.
    asOf: () => Date.now(),
    stale: () => false,
  });
  const [seen, setSeen] = useState<Seen | null | undefined>(undefined);

  // Re-read on focus: the Alerts screen moves the marks while Home is behind it.
  useFocusEffect(
    useCallback(() => {
      void readSeen().then(setSeen);
    }, []),
  );

  const events = polled.data ?? NONE;
  const alerts = useMemo(() => toAlerts(events), [events]);

  const mark = useCallback(async (shown: readonly Alert[]) => {
    const next = markSeen(await readSeen(), shown);
    setSeen(next);
    await writeSeen(next);
  }, []);

  // First run on this device: everything already on the wire counts as seen,
  // so the bell starts at zero instead of at the agents' whole history.
  useEffect(() => {
    if (seen === null && polled.data !== null) void mark(alerts);
  }, [seen, polled.data, alerts, mark]);

  const unread = unreadCount(alerts, seen ?? null);
  return {
    events,
    alerts,
    seen,
    unread,
    badge: badgeLabel(unread, events.length, ALERTS_PAGE),
    polled,
    markSeen: mark,
  };
}
