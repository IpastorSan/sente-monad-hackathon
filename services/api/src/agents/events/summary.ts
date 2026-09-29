/**
 * Per-agent summaries and the cross-agent activity feed (SEN-56), as pure
 * functions of what the event log already holds. The mobile redesign's agent
 * cards (today's P&L, trade and held counts, the largest order against the
 * mandate's cap, the agent's last move) and its home-screen "latest move" read
 * these through `GET /agents/summaries` and `GET /agents/activity`.
 *
 * Nothing here is stored: a summary is recomputed from the log on every read,
 * so it can never disagree with what `GET /agents/:id/events` shows.
 *
 * WHICH FIELDS ARE READ, and from which producer — these are the log's
 * wire-stable names, so a rename there is a silent zero here:
 *
 * | Figure                 | Event     | Field                                            |
 * | ---------------------- | --------- | ------------------------------------------------ |
 * | P&L                    | `verdict` | `detail.realisedPnl`, in `detail.pnlAsset`       |
 * | largest order notional | `order`   | `detail.intent.notional`, with `intent.kind`     |
 * |                        |           | `'order'` and `detail.status` `'ok'`             |
 * | trades / held / theses | `fill` / `refusal` / `thesis` | the count; no field is read  |
 *
 * - `realisedPnl` / `pnlAsset` are `events/verdict.ts#Verdict`, spread into
 *   the event's `detail` by `events/settle-fill.ts#recordVerdictFor`. It is ONE field on
 *   both venues: Kuru's is the FIFO cost basis over the thesis's fills and
 *   Perpl's is the venue's own `dpnl` less funding, both net of fees, and
 *   `settle` has already reduced either to the same signed decimal string.
 *   Perpl's raw figures ride on the `close` event as `realizedPnl` (US
 *   spelling) and `fundingPaid`; those are CUMULATIVE over a position and are
 *   deliberately NOT read here — summing them would count a partial close's
 *   money twice, which is the bug `settle` exists to avoid (SEN-33).
 * - `intent` is `@sente/mandate#Intent`, recorded on the `order` event by
 *   `tools/gate.ts#write`; its `notional` comes from
 *   `tools/registry.ts#orderNotional`, the figure the mandate's
 *   `maxOrderNotional` cap was checked against, in quote units. That is
 *   exactly what the card draws the order against, so it is validated and
 *   compared with the cap's own helpers (`isDecimal`, `maxDecimal`) and
 *   returned exactly as recorded. `cancel_order`, `close_position` and deposits
 *   record `order` events too, but their intent kind is not `'order'` and they
 *   carry no notional.
 */
import { isDecimal } from '@sente/mandate';

import { maxDecimal } from '../tools/decimal';
import type { AgentEvent, AgentEventTruncation } from './agent-event-log';
import { addScaled, decimalOf, decimalString, PERPL_PNL_ASSET, type Scaled } from './verdict';

/** "Today", for the card's P&L: a rolling day, not a calendar one — no timezone to guess. */
export const SUMMARY_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The quote units summed as ONE unit: Kuru's USDC and Perpl's AUSD, both
 * 6-decimal stables on Monad testnet — the same call, and the same caveat,
 * `leaderboard/metrics.ts` makes. Every Kuru market listed today quotes in
 * USDC, so this admits every verdict there is; a verdict in any other asset is
 * left out rather than added to dollars at a rate of one.
 */
const PNL_ASSETS: ReadonlySet<string> = new Set(['USDC', PERPL_PNL_ASSET]);

const ZERO: Scaled = { units: 0n, scale: 0 };

export interface AgentEventSummary {
  /** `fill` events: orders that landed, at least partly. */
  readonly trades: number;
  /** `refusal` events, both layers: what the mandate held the agent back from. */
  readonly held: number;
  /** `thesis` events. */
  readonly theses: number;
  /**
   * Present only when the log has dropped some of the agent's oldest events
   * (SEN-159): `trades`, `held` and `theses` then count only what it still
   * holds, which is everything from `since` (epoch ms, the `at` of the oldest
   * event still held) on. Without it a truncated agent's counts would read as
   * its whole history — a silent undercount.
   */
  readonly countsPartial?: { readonly since: number };
  /**
   * Exact decimal strings in quote units; `'0'` when nothing has settled.
   * `allTimePartial` is present, and `true`, only when the log has dropped
   * some of the agent's oldest events (SEN-129): `allTime` then sums only the
   * verdicts still held, and the true figure is unknown.
   */
  readonly pnl: {
    readonly last24h: string;
    readonly allTime: string;
    readonly allTimePartial?: true;
  };
  /** Quote units, decimal string; `null` when no landed order carries a notional. */
  readonly largestOrderNotional: string | null;
  /** The newest move (see `isMove`), or `null`. */
  readonly lastEvent: AgentEvent | null;
}

/**
 * What the agent card and the home feed call a move: anything but a `run`
 * summary, which is bookkeeping (trigger, cost, stop reason). One predicate,
 * so the card's "last move" and the feed's headline can never disagree.
 */
function isMove(event: AgentEvent): boolean {
  return event.kind !== 'run';
}

/**
 * One agent's summary, from its whole log (oldest first, as `list` returns it).
 * `now` is epoch ms; a verdict counts towards `last24h` when its `at` is at
 * most a day before it, the boundary included. `truncation` is the log's for
 * the agent: required, so no caller can present a partial sum as all-time.
 */
export function summariseEvents(
  events: readonly AgentEvent[],
  now: number,
  truncation: AgentEventTruncation,
): AgentEventSummary {
  let trades = 0;
  let held = 0;
  let theses = 0;
  let allTime = ZERO;
  let last24h = ZERO;
  let largest: string | null = null;
  let lastEvent: AgentEvent | null = null;
  const since = now - SUMMARY_DAY_MS;

  for (const event of events) {
    if (isMove(event)) lastEvent = event;
    switch (event.kind) {
      case 'fill':
        trades += 1;
        break;
      case 'refusal':
        held += 1;
        break;
      case 'thesis':
        theses += 1;
        break;
      case 'verdict': {
        const pnl = verdictPnl(event);
        if (pnl === undefined) break;
        allTime = addScaled(allTime, pnl);
        if (event.at >= since) last24h = addScaled(last24h, pnl);
        break;
      }
      case 'order': {
        const notional = orderNotional(event);
        if (notional !== undefined) {
          largest = largest === null ? notional : maxDecimal(largest, notional);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    trades,
    held,
    theses,
    ...(truncation.evicted > 0
      ? { countsPartial: { since: countsSince(events, truncation) } }
      : {}),
    pnl: {
      last24h: decimalString(last24h),
      allTime: decimalString(allTime),
      ...(truncation.evicted > 0 ? { allTimePartial: true as const } : {}),
    },
    largestOrderNotional: largest,
    lastEvent,
  };
}

/**
 * From when a truncated log's counts are whole. Eviction is oldest-first, so
 * the oldest event still held marks it; an agent whose every event was dropped
 * (not reachable while the cap keeps the newest, but cheap to answer) falls
 * back to the newest dropped one.
 */
function countsSince(events: readonly AgentEvent[], truncation: AgentEventTruncation): number {
  return events[0]?.at ?? truncation.newestEvictedAt ?? 0;
}

/**
 * The most recent `limit` moves across several agents' logs, newest first.
 *
 * Ordered by `seq`, which the log keeps increasing across EVERY agent, rather
 * than by `at`: `seq` is the order the log itself recorded things in, it never
 * ties, and it is the order `GET /agents/:id/events` pages by. Each log is
 * already oldest-first, so it is walked from the end and stops at `limit`: the
 * sort only ever sees `limit` candidates per agent, however long the logs are.
 */
export function latestEvents(
  logs: readonly (readonly AgentEvent[])[],
  limit: number,
): AgentEvent[] {
  const candidates: AgentEvent[] = [];
  for (const log of logs) {
    let taken = 0;
    for (let i = log.length - 1; i >= 0 && taken < limit; i -= 1) {
      const event = log[i]!;
      if (!isMove(event)) continue;
      candidates.push(event);
      taken += 1;
    }
  }
  return candidates.sort((a, b) => b.seq - a.seq).slice(0, Math.max(0, limit));
}

/** A verdict's realised PnL, when it is a decimal in one of the summed stables. */
function verdictPnl(event: AgentEvent): Scaled | undefined {
  const asset = event.detail['pnlAsset'];
  if (typeof asset !== 'string' || !PNL_ASSETS.has(asset)) return undefined;
  return decimalOf(event.detail['realisedPnl']);
}

/**
 * The notional of an order that LANDED. A venue failure is recorded as an
 * `order` event too (`status: 'failed'`), but that order never went anywhere,
 * so it is not the agent's largest order. With `AGENT_PRECHECK=off` the gate
 * builds no intent at all, so those orders carry no notional to compare.
 */
function orderNotional(event: AgentEvent): string | undefined {
  if (event.detail['status'] !== 'ok') return undefined;
  const intent = event.detail['intent'];
  if (typeof intent !== 'object' || intent === null) return undefined;
  const { kind, notional } = intent as Record<string, unknown>;
  return kind === 'order' && isDecimal(notional) ? notional : undefined;
}
