/**
 * The agent's watchers (SEN-182): set by the agent through `set_watchers`, or
 * by its owner through `PUT /agents/:id/watchers`, and checked by the
 * scheduler on the agent's cadence with no model call.
 *
 * Every write goes through the same validation (`watcher.schema.ts`) against
 * the agent's CURRENT mandate. A check re-reads that mandate too: a market
 * amended out of it stops being read, so a watcher can never make the agent
 * look at a market it may no longer trade.
 */
import { randomBytes } from 'node:crypto';

import type { Position } from '@sente/venues';
import * as z from 'zod/v4';

import type { MarketDataService } from '../../venues/market-data.service';
import type { AgentRecord } from '../store/agent-store';
import { symbolInMandate } from '../tools/registry';
import type { Candle } from '../tools/indicators';
import { checkWatchers, type Firing, type WatcherReads } from './watcher-eval';
import type { StoredWatcher, WatcherSet, WatcherSetBy, WatcherStore } from './watcher-store';
import {
  checkUniqueIds,
  checkWatcher,
  DEFAULT_HEARTBEAT_SECONDS,
  describeWatcher,
  MAX_WATCHERS,
  watcherInput,
  WatcherInvalidError,
  watcherSetInput,
  type MandateScope,
  type ParsedWatcher,
} from './watcher.schema';

/** As many candles as `get_indicators` reads by default, so both share a cache entry. */
export const WATCHER_LOOKBACK = 200;
const MAX_ERROR = 300;

type VenueId = 'kuru' | 'perpl';

export interface WatcherServiceOptions {
  readonly store: WatcherStore;
  /** The shared, cached reads the tools use (SEN-79). Absent: market clauses are unknown. */
  readonly marketData?: Pick<MarketDataService, 'ticker' | 'klines'>;
  /** The agent's open Perpl positions; undefined when it has no Perpl account here. */
  readonly positionsOf?: (agent: AgentRecord) => Promise<readonly Position[] | undefined>;
}

export interface WatcherCheckResult {
  readonly fired: readonly Firing[];
}

/** One watcher as the agent and the owner read it. */
export interface WatcherView {
  readonly id: string;
  readonly label: string;
  readonly match: 'all' | 'any';
  readonly clauses: StoredWatcher['clauses'];
  /** The condition in words. */
  readonly reads: string;
  readonly cooldownMinutes: number;
  readonly setBy: WatcherSetBy;
  readonly lastEvaluatedAt: string | null;
  readonly lastFiredAt: string | null;
  readonly fireCount: number;
  readonly lastObserved: string | null;
  readonly lastError: string | null;
}

export interface WatcherSetView {
  readonly heartbeatSeconds: number;
  readonly checks: number;
  readonly wakes: number;
  readonly heartbeats: number;
  /** Scheduled checks that started no run: each one a model call not made. */
  readonly modelCallsSaved: number;
  readonly lastCheckAt: string | null;
  readonly lastWakeAt: string | null;
  readonly watchers: WatcherView[];
}

export class WatcherService {
  readonly #options: WatcherServiceOptions;

  constructor(options: WatcherServiceOptions) {
    this.#options = options;
  }

  get(agentId: string): WatcherSet | undefined {
    return this.#options.store.get(agentId);
  }

  /** Whether the scheduler should check instead of run: a set with at least one watcher. */
  has(agentId: string): boolean {
    return (this.get(agentId)?.watchers.length ?? 0) > 0;
  }

  view(agentId: string): WatcherSetView {
    return toView(this.get(agentId) ?? emptySet(agentId, Date.now()));
  }

  /**
   * Replaces the agent's whole set. A watcher passed with an existing id and
   * the same condition keeps its edge state and history; anything else
   * starts fresh. Throws `WatcherInvalidError`.
   */
  replace(agent: AgentRecord, raw: unknown, setBy: WatcherSetBy, now = Date.now()): WatcherSet {
    const input = parse(watcherSetInput, raw);
    checkUniqueIds(input.watchers);
    const scope = scopeOf(agent);
    const previous = this.get(agent.id) ?? emptySet(agent.id, now);
    const taken = new Set(input.watchers.flatMap((w) => (w.id ? [w.id] : [])));
    const watchers = input.watchers.map((w) =>
      stored(checkWatcher(w, scope), previous, setBy, now, taken),
    );
    const next: WatcherSet = {
      ...previous,
      heartbeatSeconds:
        input.heartbeatHours !== undefined
          ? Math.round(input.heartbeatHours * 3_600)
          : previous.heartbeatSeconds,
      watchers,
      updatedAt: now,
    };
    this.#options.store.put(next);
    return next;
  }

  /** Adds or edits one watcher by id. Throws `WatcherInvalidError`. */
  upsert(
    agent: AgentRecord,
    id: string,
    raw: unknown,
    setBy: WatcherSetBy,
    now = Date.now(),
  ): WatcherSet {
    const body = typeof raw === 'object' && raw !== null ? { ...raw, id } : raw;
    const watcher = checkWatcher(parse(watcherInput, body), scopeOf(agent));
    const previous = this.get(agent.id) ?? emptySet(agent.id, now);
    const exists = previous.watchers.some((w) => w.id === id);
    if (!exists && previous.watchers.length >= MAX_WATCHERS) {
      throw new WatcherInvalidError(
        'invalid_input',
        `an agent keeps at most ${MAX_WATCHERS} watchers; delete one first`,
      );
    }
    const one = stored(watcher, previous, setBy, now, new Set([id]));
    const next: WatcherSet = {
      ...previous,
      watchers: exists
        ? previous.watchers.map((w) => (w.id === id ? one : w))
        : [...previous.watchers, one],
      updatedAt: now,
    };
    this.#options.store.put(next);
    return next;
  }

  /** Deletes one watcher. False when there was none by that id. */
  remove(agentId: string, id: string, now = Date.now()): boolean {
    const set = this.get(agentId);
    if (!set?.watchers.some((w) => w.id === id)) return false;
    this.#options.store.put({
      ...set,
      watchers: set.watchers.filter((w) => w.id !== id),
      updatedAt: now,
    });
    return true;
  }

  /** Removes every watcher; the counters stay, so the page still shows what was saved. */
  clear(agentId: string, now = Date.now()): void {
    const set = this.get(agentId);
    if (set) this.#options.store.put({ ...set, watchers: [], updatedAt: now });
  }

  /**
   * One scheduled check of every watcher, no model. Records the check and
   * each watcher's new state; returns what fired (cooldowns applied).
   */
  async check(agent: AgentRecord, now = Date.now()): Promise<WatcherCheckResult> {
    const set = this.get(agent.id);
    if (!set || set.watchers.length === 0) return { fired: [] };
    const { watchers, fired } = await checkWatchers(set.watchers, this.#reads(agent), now);
    // Re-read: a set_watchers in a run that started meanwhile wins over this check.
    const latest = this.get(agent.id);
    if (latest && latest.updatedAt !== set.updatedAt) return { fired: [] };
    this.#options.store.put({ ...set, watchers, checks: set.checks + 1, lastCheckAt: now });
    return { fired };
  }

  /** What the check led to: nothing (a model call saved), a watcher's run, or a heartbeat's. */
  record(agentId: string, outcome: 'skipped' | 'wake' | 'heartbeat', now = Date.now()): void {
    const set = this.get(agentId);
    if (!set) return;
    this.#options.store.put({
      ...set,
      ...(outcome === 'skipped' ? { skipped: set.skipped + 1 } : {}),
      ...(outcome === 'wake' ? { wakes: set.wakes + 1, lastWakeAt: now } : {}),
      ...(outcome === 'heartbeat' ? { heartbeats: set.heartbeats + 1, lastWakeAt: now } : {}),
    });
  }

  heartbeatSeconds(agentId: string): number {
    return this.get(agentId)?.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
  }

  #reads(agent: AgentRecord): WatcherReads {
    const { marketData, positionsOf } = this.#options;
    const scoped = (venue: VenueId, market: string) => {
      if (!symbolInMandate(agent.mandate, venue, market)) {
        throw new Error(`${market} on ${venue} is no longer in the mandate`);
      }
      if (!marketData) throw new Error('market data is not available');
      return marketData;
    };
    return {
      async prices(venue, market) {
        const ticker = await scoped(venue, market).ticker(venue, market);
        const mark = num(ticker.mark) ?? num(ticker.mid) ?? num(ticker.last);
        return { last: num(ticker.last) ?? mark, mark };
      },
      async candles(venue, market, timeframe) {
        const page = await scoped(venue, market).klines(
          venue,
          market,
          timeframe as Parameters<MarketDataService['klines']>[2],
          WATCHER_LOOKBACK,
        );
        return page.klines.map((k): Candle => ({
          t: k.openTime,
          open: Number(k.open),
          high: Number(k.high),
          low: Number(k.low),
          close: Number(k.close),
          volume: Number(k.volume),
        }));
      },
      async positions() {
        const positions = positionsOf ? await positionsOf(agent) : undefined;
        if (positions === undefined) throw new Error('Perpl is not set up for this agent');
        return positions.map((p) => {
          const margin = Number(p.margin);
          const pnl = Number(p.unrealizedPnl);
          return {
            symbol: p.symbol,
            pnlPct:
              margin > 0 && Number.isFinite(pnl) ? Math.round((pnl / margin) * 1e6) / 1e4 : null,
          };
        });
      },
      async funding(market) {
        const { funding } = await scoped('perpl', market).ticker('perpl', market);
        if (!funding || !(funding.intervalHours > 0)) return null;
        return (Number(funding.rate) * 100 * 8) / funding.intervalHours;
      },
    };
  }
}

function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new WatcherInvalidError(
      'invalid_input',
      z.prettifyError(parsed.error).slice(0, MAX_ERROR),
    );
  }
  return parsed.data;
}

function scopeOf(agent: AgentRecord): MandateScope {
  return (venue, market) => {
    if (!agent.mandate.venues.includes(venue)) return 'venue';
    return symbolInMandate(agent.mandate, venue, market) ? 'ok' : 'market';
  };
}

function emptySet(agentId: string, now: number): WatcherSet {
  return {
    agentId,
    heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
    watchers: [],
    updatedAt: now,
    checks: 0,
    skipped: 0,
    wakes: 0,
    heartbeats: 0,
    lastCheckAt: null,
    lastWakeAt: null,
  };
}

/** A parsed watcher as stored: its old state kept when its id and condition are unchanged. */
function stored(
  watcher: ParsedWatcher,
  previous: WatcherSet,
  setBy: WatcherSetBy,
  now: number,
  taken: Set<string>,
): StoredWatcher {
  const id = watcher.id ?? freshId(taken);
  const old = previous.watchers.find((w) => w.id === id);
  const same =
    old !== undefined &&
    old.match === watcher.match &&
    JSON.stringify(old.clauses) === JSON.stringify(watcher.clauses);
  return {
    id,
    label: watcher.label,
    match: watcher.match,
    clauses: watcher.clauses,
    cooldownMinutes: watcher.cooldownMinutes,
    setBy,
    createdAt: old?.createdAt ?? now,
    edges: same ? old.edges : watcher.clauses.map(() => null),
    lastEvaluatedAt: same ? old.lastEvaluatedAt : null,
    lastFiredAt: old?.lastFiredAt ?? null,
    fireCount: old?.fireCount ?? 0,
    lastObserved: old?.lastObserved ?? null,
    lastError: null,
  };
}

function freshId(taken: Set<string>): string {
  let id: string;
  do id = `w-${randomBytes(3).toString('hex')}`;
  while (taken.has(id));
  taken.add(id);
  return id;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function toView(set: WatcherSet): WatcherSetView {
  return {
    heartbeatSeconds: set.heartbeatSeconds,
    checks: set.checks,
    wakes: set.wakes,
    heartbeats: set.heartbeats,
    modelCallsSaved: set.skipped,
    lastCheckAt: iso(set.lastCheckAt),
    lastWakeAt: iso(set.lastWakeAt),
    watchers: set.watchers.map((w) => ({
      id: w.id,
      label: w.label,
      match: w.match,
      clauses: w.clauses,
      reads: describeWatcher(w),
      cooldownMinutes: w.cooldownMinutes,
      setBy: w.setBy,
      lastEvaluatedAt: iso(w.lastEvaluatedAt),
      lastFiredAt: iso(w.lastFiredAt),
      fireCount: w.fireCount,
      lastObserved: w.lastObserved,
      lastError: w.lastError,
    })),
  };
}
