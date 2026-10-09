/**
 * The Alerts feed (SEN-156): what your agents did while you weren't looking,
 * from `GET /agents/activity` (SEN-56), and which of it you have not seen.
 *
 * Plain node, no React Native, so `alerts.test.ts` pins every sentence, the
 * unread count and the grouping without a device. The screen and Home's bell
 * only lay these out.
 *
 * Every alert is built from the Ledger's own mapping (`toLedgerEntries`) and
 * its own headlines (`ledgerView.ts`), never from `detail` again: an event the
 * Ledger does not show must not raise an alert, and an alert must read like
 * the row it points at. Money goes through `ui/money.ts` via `pnlLabel`.
 *
 * Unread state lives on the device, in one secure-store key (`alertsStore.ts`),
 * as the newest `seq` AND `at` seen PER AGENT. Per agent, because the API's
 * `seq` is only promised to order one agent's log (it happens to be global
 * today, and a per-agent high-water mark is right either way). Both numbers,
 * because the in-memory event log restarts `seq` at 1 when the API restarts:
 * a new event then has a lower `seq` than one already seen but a later `at`,
 * and a deposit may carry a backdated `at` but still a new `seq`. An event is
 * unread when it is past the mark on either.
 */
import type { ActivityEvent } from './api.ts';
import { heldLabel, toLedgerEntries, type LedgerEntry } from './ledger.ts';
import {
  accountOpened,
  depositHeadline,
  depositSource,
  heldBy,
  outcome,
  stoneFor,
  tradeDetail,
  tradeHeadline,
  type LedgerStone,
} from './ledgerView.ts';
import { pnlLabel } from './leaderboard.ts';

/** Where tapping an alert goes. */
export type AlertTarget =
  /** A fill: the live position on that market (`/agents/[id]/position/[symbol]`). */
  | { kind: 'position'; symbol: string; venue: string | null }
  /** Anything else: the agent's Ledger, where the same row sits. */
  | { kind: 'ledger' };

export type Alert = {
  /** `agentId:seq` — unique across agents, stable across polls. The list key. */
  key: string;
  agentId: string;
  agentName: string;
  seq: number;
  at: number;
  /** The Ledger's stone for the same entry. */
  stone: LedgerStone;
  /**
   * The sentence after the agent's name, which the screen sets in bold before
   * it. Starts with its own joint (` bought…`, `’s order…`), so the two
   * concatenate into the whole sentence.
   */
  lead: string;
  /** A P&L, tinted apart from the sentence; `null` for anything but a close. */
  figure: { text: string; tone: 'up' | 'down' | null } | null;
  /** The line under it, or `null`. */
  detail: string | null;
  /** A refusal's pill (`Held by the enclave`). Lilac on screen, never berry. */
  held: string | null;
  target: AlertTarget;
};

/**
 * The activity page as alerts, newest first.
 *
 * Mapped one event at a time: `toLedgerEntries` sorts by `seq`, which only
 * orders one agent's log, so a mixed page is ordered here by time instead.
 *
 * Left out, beyond what the Ledger leaves out:
 * - a thesis: it is the agent thinking, and the trade it leads to is the alert;
 * - a venue `close` that its run's verdict settles: both carry the P&L, and
 *   two "closed" alerts for one trade would read as two trades.
 */
export function toAlerts(events: readonly ActivityEvent[]): Alert[] {
  const settled = new Set(
    events.flatMap((event) =>
      event.kind === 'verdict' && event.runId !== undefined ? [runKey(event)] : [],
    ),
  );
  return events
    .filter((event) => !(event.kind === 'close' && settled.has(runKey(event))))
    .flatMap((event) => {
      const [entry] = toLedgerEntries([event]);
      if (!entry || entry.kind === 'thesis') return [];
      return [
        {
          key: `${event.agentId}:${event.seq}`,
          agentId: event.agentId,
          agentName: event.agentName || 'Your agent',
          seq: event.seq,
          at: event.at,
          stone: stoneFor(entry),
          ...sentence(entry),
          target: targetOf(entry),
        },
      ];
    })
    .sort((a, b) => b.at - a.at || b.seq - a.seq);
}

function runKey(event: Pick<ActivityEvent, 'agentId' | 'runId'>): string {
  return `${event.agentId}:${event.runId ?? ''}`;
}

type Sentence = Pick<Alert, 'lead' | 'figure' | 'detail' | 'held'>;

function sentence(entry: Exclude<LedgerEntry, { kind: 'thesis' }>): Sentence {
  const plain = { figure: null, held: null };
  switch (entry.kind) {
    case 'trade':
      return entry.filled
        ? {
            ...plain,
            lead: ` ${lowerFirst(tradeHeadline(entry))}`,
            detail: orNull(tradeDetail(entry)),
          }
        : {
            ...plain,
            // `Didn’t fill: buy 180 MON` turned around, so the agent stays the subject.
            lead: `’s order to ${tradeHeadline(entry).replace(/^Didn’t fill: /u, '')} didn’t fill`,
            detail: orNull(tradeDetail(entry)),
          };
    case 'refusal':
      return {
        lead: ' was held to its mandate',
        figure: null,
        detail: entry.message || entry.code,
        held: heldBy(entry.layer),
      };
    case 'verdict': {
      const what =
        entry.direction !== null ? `a ${entry.direction}` : (entry.market ?? 'a position');
      const unit = quoteOf(entry.market);
      return {
        lead: entry.pnl === null ? ` closed ${what}` : ` closed ${what}:`,
        figure:
          entry.pnl === null
            ? null
            : { text: `${pnlLabel(entry.pnl)}${unit ? ` ${unit}` : ''}`, tone: outcome(entry) },
        // A venue's own close cannot say whether the thesis held; only a verdict can.
        detail: orNull(
          [entry.market, entry.origin === 'verdict' ? heldLabel(entry.held) : null]
            .filter((part): part is string => part !== null)
            .join(' · '),
        ),
        held: null,
      };
    }
    case 'deposit':
      return {
        ...plain,
        // The Ledger's `Funded 500.00 USDC`, with the agent as the one who received it.
        lead: ` received ${depositHeadline(entry).replace(/^Funded /u, '')}`,
        detail: depositSource(entry),
      };
    // SEN-187: Sente opening the agent's Perpl account, or why it could not yet.
    case 'account':
      return {
        ...plain,
        lead: accountOpened(entry) ? ': perps account opened' : '’s perps account is not open yet',
        detail: orNull(entry.message),
      };
  }
}

/**
 * A fill opens the position it moved. A close has no position left to show, and
 * a refusal or a deposit names no market, so those open the Ledger.
 */
function targetOf(entry: LedgerEntry): AlertTarget {
  if (entry.kind === 'trade' && entry.filled && entry.market !== '—') {
    return { kind: 'position', symbol: entry.market, venue: entry.venue };
  }
  return { kind: 'ledger' };
}

/** `MON-USDC` → `USDC`; a perp settles in AUSD (Perpl's collateral). */
function quoteOf(market: string | null): string | null {
  if (market === null) return null;
  if (/-PERP$/u.test(market)) return 'AUSD';
  const quote = market.split(/[-/]/u)[1];
  return quote !== undefined && quote !== '' ? quote : null;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function orNull(value: string): string | null {
  return value === '' ? null : value;
}

// ---------------------------------------------------------------------------
// Read / unread

/** The newest event seen, per agent. */
export type SeenMark = { seq: number; at: number };
export type Seen = Readonly<Record<string, SeenMark>>;

/**
 * What the store holds, read back. `null` when nothing was ever stored (or it
 * does not parse): the device has never shown the feed, and the caller seeds
 * it rather than lighting the bell with the agents' whole history.
 */
export function parseSeen(raw: string | null): Seen | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const agents = (parsed as { agents?: unknown }).agents;
  if (typeof agents !== 'object' || agents === null) return null;
  const seen: Record<string, SeenMark> = {};
  for (const [id, mark] of Object.entries(agents)) {
    const { seq, at } = (mark ?? {}) as { seq?: unknown; at?: unknown };
    if (typeof seq === 'number' && typeof at === 'number') seen[id] = { seq, at };
  }
  return seen;
}

export function serializeSeen(seen: Seen): string {
  return JSON.stringify({ v: 1, agents: seen });
}

/** `seen` moved up to cover everything in `alerts`. Never moves a mark back. */
export function markSeen(
  seen: Seen | null,
  alerts: readonly Pick<Alert, 'agentId' | 'seq' | 'at'>[],
): Seen {
  const next: Record<string, SeenMark> = { ...seen };
  for (const { agentId, seq, at } of alerts) {
    const mark = next[agentId];
    next[agentId] = { seq: Math.max(mark?.seq ?? 0, seq), at: Math.max(mark?.at ?? 0, at) };
  }
  return next;
}

/**
 * Past the agent's mark on `seq` or on `at` (see the header for why both). An
 * agent with no mark yet was hired after the feed was last opened, so all of
 * its alerts are new. With no state at all nothing is unread (`parseSeen`).
 */
export function isUnread(alert: Pick<Alert, 'agentId' | 'seq' | 'at'>, seen: Seen | null): boolean {
  if (seen === null) return false;
  const mark = seen[alert.agentId];
  if (mark === undefined) return true;
  return alert.seq > mark.seq || alert.at > mark.at;
}

export function unreadCount(
  alerts: readonly Pick<Alert, 'agentId' | 'seq' | 'at'>[],
  seen: Seen | null,
): number {
  return alerts.filter((alert) => isUnread(alert, seen)).length;
}

/**
 * The bell's badge: `null` hides it, and a page that is unread end to end
 * says `50+`, because the route returns at most that many and more may wait.
 */
export function badgeLabel(unread: number, page: number, limit: number): string | null {
  if (unread <= 0) return null;
  return unread >= limit && page >= limit ? `${limit}+` : String(unread);
}

// ---------------------------------------------------------------------------
// Filters and grouping

/** `all`, one agent's id, or `held` (refusals only). */
export type AlertFilter = 'all' | 'held' | { agentId: string };

/** The chips: All, each agent in the feed (the busiest recently first), then Held. */
export function alertFilters(
  alerts: readonly Pick<Alert, 'agentId' | 'agentName'>[],
): { key: string; label: string; filter: AlertFilter }[] {
  const agents = new Map<string, string>();
  for (const alert of alerts) {
    if (!agents.has(alert.agentId)) agents.set(alert.agentId, alert.agentName);
  }
  return [
    { key: 'all', label: 'All', filter: 'all' },
    ...[...agents].map(([agentId, label]) => ({
      key: `agent:${agentId}`,
      label,
      filter: { agentId },
    })),
    { key: 'held', label: 'Held', filter: 'held' },
  ];
}

export function filterKey(filter: AlertFilter): string {
  return typeof filter === 'string' ? filter : `agent:${filter.agentId}`;
}

export function inAlertFilter(
  alert: Pick<Alert, 'agentId' | 'stone'>,
  filter: AlertFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'held') return alert.stone === 'refusal';
  return alert.agentId === filter.agentId;
}

/**
 * `Today`, then `Earlier`, each newest first; an empty group is left out. The
 * day is the UTC day, like `entryTime` beside each alert, so a row under Today
 * always shows a clock time and one under Earlier a date.
 */
export function groupAlerts<T extends Pick<Alert, 'at'>>(
  alerts: readonly T[],
  now: number,
): { label: 'Today' | 'Earlier'; alerts: T[] }[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const groups = [
    { label: 'Today' as const, alerts: [] as T[] },
    { label: 'Earlier' as const, alerts: [] as T[] },
  ];
  for (const alert of alerts) {
    groups[new Date(alert.at).toISOString().slice(0, 10) === today ? 0 : 1]!.alerts.push(alert);
  }
  return groups.filter((group) => group.alerts.length > 0);
}
