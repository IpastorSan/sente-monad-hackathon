// The agent event log, in SQLite (SEN-205).
//
// Same semantics as `InMemoryAgentEventLog` and `FileAgentEventLog`, and the
// spec beside the file log runs all three through one table: `seq` increasing
// across the whole log and carried on across a restart, `list` filtered by
// run, kind and cursor with the same paging (the FIRST `limit` after a cursor,
// the LAST `limit` without one), the per-agent cap evicting oldest first and
// counting what it evicted (SEN-129), records frozen on the way out, and an
// append whose write fails still resolving (see the file log's header: the
// event already happened).
//
// What differs is where reads come from. The file log holds every event in
// memory; this one queries, and filtered reads (`kind`, `runId`, a cursor, a
// `limit`) go through the indexes and touch only what they return. An
// unfiltered `list` — the whole history, which the resting-fill watcher reads
// for every agent every 15 s and the leaderboard, portfolio and public page
// read per request — would parse up to 10k rows each time (~25 ms at the cap,
// measured), so the first one for an agent is cached and kept current by
// `append`. At worst that is the memory the file log always spent; an agent
// nobody reads in full costs none.
//
// Schema: `state/db/migrations/003-append-logs.ts`. `data` is the event as the
// JSONL file holds it, plain JSON (events are JSON-safe on the way in).
//
// Erasable syntax and `.ts` specifiers: the import script loads this under
// node's type stripping (CLAUDE.md gotcha 10).

import { existsSync } from 'node:fs';
import type { StatementSync } from 'node:sqlite';

import { Logger } from '@nestjs/common';

import type { SenteDb } from '../../state/db/sente-db.ts';
import { readJsonlLines } from '../../state/jsonl.ts';
import {
  addTruncation,
  AGENT_EVENTS_PER_AGENT,
  deepFreeze,
  NOT_TRUNCATED,
  toJsonSafe,
  type AgentEvent,
  type AgentEventLog,
  type AgentEventQuery,
  type AgentEventTruncation,
  type NewAgentEvent,
} from './agent-event-log.ts';
import { keepNewest, LINE_VERSION, parseLine } from './file-agent-event-log.ts';

type EventLogger = Pick<Logger, 'warn' | 'error'>;

/**
 * One record of the log as the import moves it: an event, or what the cap
 * dropped for one agent before the copy.
 */
export type AgentEventLogRecord =
  | { readonly event: AgentEvent }
  | { readonly truncated: string; readonly truncation: AgentEventTruncation };

/** The import's key for a record. Events sort by `seq` within their prefix. */
export function agentEventLogKey(record: AgentEventLogRecord): string {
  return 'event' in record
    ? `event:${String(record.event.seq).padStart(16, '0')}`
    : `truncated:${record.truncated}`;
}

const SELECT = 'SELECT data FROM agent_events';

export class SqliteAgentEventLog implements AgentEventLog {
  readonly #db: SenteDb;
  readonly #maxPerAgent: number;
  readonly #logger: EventLogger;
  readonly #nextSeq: StatementSync;
  readonly #insert: StatementSync;
  readonly #countAgent: StatementSync;
  readonly #oldest: StatementSync;
  readonly #deleteUpTo: StatementSync;
  readonly #getTruncation: StatementSync;
  readonly #setTruncation: StatementSync;
  readonly #minSeq: StatementSync;
  readonly #all: StatementSync;
  readonly #allTruncations: StatementSync;
  readonly #count: StatementSync;
  /** `list` statements, by which filters and which paging they carry. */
  readonly #lists = new Map<string, StatementSync>();
  /** Agents whose whole history was read: the events `list` holds, oldest first, kept current. */
  readonly #history = new Map<string, AgentEvent[]>();

  constructor(db: SenteDb, opts: { maxPerAgent?: number; logger?: EventLogger } = {}) {
    this.#db = db;
    this.#maxPerAgent = opts.maxPerAgent ?? AGENT_EVENTS_PER_AGENT;
    this.#logger = opts.logger ?? new Logger('AgentEventLog');
    // AUTOINCREMENT's high-water mark, so a seq is never reused even if its row is gone.
    this.#nextSeq = db.prepare(
      `SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'agent_events'), 0) + 1 AS n`,
    );
    this.#insert = db.prepare(
      'INSERT INTO agent_events (seq, agent_id, run_id, kind, at, data) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (seq) DO NOTHING',
    );
    this.#countAgent = db.prepare('SELECT count(*) AS n FROM agent_events WHERE agent_id = ?');
    this.#oldest = db.prepare(
      'SELECT max(seq) AS seq, max(at) AS at, count(*) AS n FROM ' +
        '(SELECT seq, at FROM agent_events WHERE agent_id = ? ORDER BY seq LIMIT ?)',
    );
    this.#deleteUpTo = db.prepare('DELETE FROM agent_events WHERE agent_id = ? AND seq <= ?');
    this.#getTruncation = db.prepare(
      'SELECT evicted, newest_evicted_at FROM agent_event_truncation WHERE agent_id = ?',
    );
    this.#setTruncation = db.prepare(
      'INSERT INTO agent_event_truncation (agent_id, evicted, newest_evicted_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT (agent_id) DO UPDATE SET evicted = excluded.evicted, ' +
        'newest_evicted_at = excluded.newest_evicted_at',
    );
    this.#minSeq = db.prepare('SELECT min(seq) AS seq FROM agent_events WHERE agent_id = ?');
    this.#all = db.prepare(`${SELECT} ORDER BY seq`);
    this.#allTruncations = db.prepare(
      'SELECT agent_id, evicted, newest_evicted_at FROM agent_event_truncation ORDER BY agent_id',
    );
    this.#count = db.prepare('SELECT count(*) AS n FROM agent_events');
  }

  /** The database behind this log. Logged at boot. */
  get path(): string {
    return this.#db.path;
  }

  /** How many events the table holds. Logged at boot. */
  get size(): number {
    return Number(this.#count.get()!['n']);
  }

  append(event: NewAgentEvent): Promise<AgentEvent> {
    if ((event.kind === 'refusal') !== (event.layer !== undefined)) {
      return Promise.reject(new Error('a refusal must name its layer, and only a refusal has one'));
    }
    let stored: AgentEvent;
    try {
      let evicted = 0;
      stored = this.#db.transaction(() => {
        const record: AgentEvent = deepFreeze({
          ...toJsonSafe(event),
          seq: Number(this.#nextSeq.get()!['n']),
          at: event.at ?? Date.now(),
        });
        this.#write(record);
        evicted = this.#evictOverflow(record.agentId);
        return record;
      });
      // Committed: bring a cached history along. Inside a caller's transaction
      // it may still roll back, so the cache is dropped and re-read instead.
      const history = this.#history.get(stored.agentId);
      if (history && this.#db.inTransaction) {
        this.#history.delete(stored.agentId);
      } else if (history) {
        history.push(stored);
        history.splice(0, evicted);
      }
    } catch (error) {
      // Resolve anyway: the event already happened (`file-agent-event-log.ts`, header).
      stored = deepFreeze({ ...toJsonSafe(event), seq: 0, at: event.at ?? Date.now() });
      this.#logger.error(
        `event (${stored.kind}, agent ${stored.agentId}) was not written to ${this.path} ` +
          `and will be missing from the Ledger: ${String(error)}`,
      );
    }
    return Promise.resolve(stored);
  }

  list(agentId: string, query: AgentEventQuery = {}): Promise<AgentEvent[]> {
    const whole =
      query.runId === undefined &&
      query.kind === undefined &&
      query.afterSeq === undefined &&
      query.limit === undefined;
    if (whole) {
      let history = this.#history.get(agentId);
      if (!history) {
        history = this.#query(agentId, query);
        this.#history.set(agentId, history);
      }
      return Promise.resolve(history.slice());
    }
    return Promise.resolve(this.#query(agentId, query));
  }

  #query(agentId: string, query: AgentEventQuery): AgentEvent[] {
    const where = ['agent_id = ?'];
    const params: (string | number)[] = [agentId];
    if (query.runId !== undefined) {
      where.push('run_id = ?');
      params.push(query.runId);
    }
    if (query.kind !== undefined) {
      where.push('kind = ?');
      params.push(query.kind);
    }
    if (query.afterSeq !== undefined) {
      where.push('seq > ?');
      params.push(query.afterSeq);
    }
    let paging = 'all';
    if (query.limit !== undefined) {
      const limit = Math.max(0, Math.trunc(query.limit));
      if (limit === 0) return [];
      // With a cursor, the FIRST `limit` after it (SEN-35); without, the most recent `limit`.
      paging = query.afterSeq === undefined ? 'last' : 'first';
      params.push(limit);
    }
    const key = `${where.join(' AND ')}|${paging}`;
    let statement = this.#lists.get(key);
    if (!statement) {
      const filtered = `${SELECT} WHERE ${where.join(' AND ')}`;
      const sql =
        paging === 'all'
          ? `${filtered} ORDER BY seq`
          : paging === 'first'
            ? `${filtered} ORDER BY seq LIMIT ?`
            : `SELECT data FROM (SELECT data, seq FROM agent_events WHERE ${where.join(' AND ')} ` +
              'ORDER BY seq DESC LIMIT ?) ORDER BY seq';
      statement = this.#db.prepare(sql);
      this.#lists.set(key, statement);
    }
    return statement.all(...params).map(eventOf);
  }

  truncation(agentId: string): Promise<AgentEventTruncation> {
    return Promise.resolve(truncationOf(this.#getTruncation.get(agentId)));
  }

  /**
   * For `state/db/state-import.ts`: an event as it was stamped, `seq` and all,
   * or an agent's dropped count. An event already in the table is left as it
   * is (events never change), and one older than everything the table holds
   * for an agent whose history was already cut is skipped rather than
   * resurrected: the cap evicted it here since the last copy. A dropped count
   * keeps the larger of the two, so a re-run never forgets an eviction.
   */
  put(record: AgentEventLogRecord): void {
    if ('event' in record) {
      const { event } = record;
      this.#history.delete(event.agentId);
      if (this.#getTruncation.get(event.agentId)) {
        const min = this.#minSeq.get(event.agentId)!['seq'];
        if (min !== null && event.seq < Number(min)) return;
      }
      this.#write(event);
      return;
    }
    const held = truncationOf(this.#getTruncation.get(record.truncated));
    const next = record.truncation;
    this.#setTruncation.run(
      record.truncated,
      Math.max(held.evicted, next.evicted),
      maxOrNull(held.newestEvictedAt, next.newestEvictedAt),
    );
  }

  /** Every dropped count, then every event in `seq` order: what `put` takes. */
  async listAll(): Promise<AgentEventLogRecord[]> {
    const truncations: AgentEventLogRecord[] = this.#allTruncations.all().map((row) => ({
      truncated: String(row['agent_id']),
      truncation: truncationOf(row),
    }));
    return [...truncations, ...this.#all.all().map((row) => ({ event: eventOf(row) }))];
  }

  #write(event: AgentEvent): void {
    this.#insert.run(
      event.seq,
      event.agentId,
      event.runId ?? null,
      event.kind,
      event.at,
      JSON.stringify(event),
    );
  }

  /** Drop one agent's oldest events past the cap, remember that they were dropped, say how many. */
  #evictOverflow(agentId: string): number {
    const over = Number(this.#countAgent.get(agentId)!['n']) - this.#maxPerAgent;
    if (over <= 0) return 0;
    const dropped = this.#oldest.get(agentId, over)!;
    this.#deleteUpTo.run(agentId, Number(dropped['seq']));
    const total = addTruncation(truncationOf(this.#getTruncation.get(agentId)), {
      evicted: Number(dropped['n']),
      newestEvictedAt: Number(dropped['at']),
    });
    this.#setTruncation.run(agentId, total.evicted, total.newestEvictedAt);
    return Number(dropped['n']);
  }
}

function eventOf(row: Record<string, unknown>): AgentEvent {
  return deepFreeze(JSON.parse(String(row['data'])) as AgentEvent);
}

function truncationOf(row: Record<string, unknown> | undefined): AgentEventTruncation {
  if (!row) return NOT_TRUNCATED;
  const newest = row['newest_evicted_at'];
  return {
    evicted: Number(row['evicted']),
    newestEvictedAt: newest === null || newest === undefined ? null : Number(newest),
  };
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * `agent-events.jsonl` as `FileAgentEventLog` would load it — the same line
 * checks, the same per-agent cap, the dropped counts of earlier compactions
 * plus what the cap drops now — streamed, and without touching the file: a
 * torn last line is left in place and skipped (the file log would cut it off
 * at its next boot). `undefined` when there is no file.
 */
export function loadAgentEventLogRecords(
  path: string,
  maxPerAgent = AGENT_EVENTS_PER_AGENT,
): AgentEventLogRecord[] | undefined {
  if (!existsSync(path)) return undefined;
  const events: AgentEvent[] = [];
  const truncated = new Map<string, AgentEventTruncation>();
  for (const { text, lineNo, isLast } of readJsonlLines(path)) {
    const parsed = parseLine(text);
    if (parsed === 'torn') {
      if (isLast) break;
      throw new Error(`${path} line ${lineNo} is not a readable event. Not importing it.`);
    }
    if (parsed === 'wrong-version') {
      throw new Error(`${path} line ${lineNo} is not a v${LINE_VERSION} event. Not importing it.`);
    }
    if (parsed instanceof Map) {
      for (const [agentId, more] of parsed) {
        truncated.set(agentId, addTruncation(truncated.get(agentId) ?? NOT_TRUNCATED, more));
      }
    } else {
      events.push(parsed);
    }
  }
  const { kept, dropped } = keepNewest(events, maxPerAgent);
  for (const [agentId, more] of dropped) {
    truncated.set(agentId, addTruncation(truncated.get(agentId) ?? NOT_TRUNCATED, more));
  }
  const records: AgentEventLogRecord[] = [...truncated.entries()]
    .filter(([, truncation]) => truncation.evicted > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([agentId, truncation]) => ({ truncated: agentId, truncation }));
  for (const event of kept) records.push({ event });
  return records;
}
