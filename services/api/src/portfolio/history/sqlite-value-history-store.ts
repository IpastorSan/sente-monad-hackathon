// The value history in SQLite (SEN-205).
//
// Same semantics as `InMemoryValueHistoryStore` and `FileValueHistoryStore`,
// which the spec runs it beside: per subject, snapshots oldest first by `at`
// and in arrival order on a tie (a snapshot is stamped with the time its reads
// started, so two can land out of order), at most `maxPerSubject` of them with
// the oldest dropped first. The cap is applied as each snapshot lands, so the
// table never holds more than it serves and there is no boot compaction.
//
// The interface is synchronous and so is `node:sqlite`; every call is a query.
// `list` of a subject at the 20k cap parses 20k rows, a few ms at most, once
// per chart request.
//
// Schema: `state/db/migrations/003-append-logs.ts`. `dup` numbers a subject's
// snapshots at the same millisecond in arrival order, which makes
// `(kind, subject_id, at, dup)` both the order and the key the import upserts
// by. `data` is the snapshot as the JSONL line carries it.
//
// Erasable syntax and `.ts` specifiers: the import script loads this under
// node's type stripping (CLAUDE.md gotcha 10).

import { existsSync } from 'node:fs';
import type { StatementSync } from 'node:sqlite';

import { Logger } from '@nestjs/common';

import type { SenteDb } from '../../state/db/sente-db.ts';
import { readJsonlLines } from '../../state/jsonl.ts';
import {
  InMemoryValueHistoryStore,
  parseLine,
  VALUE_HISTORY_PER_SUBJECT,
  type HistoryKind,
  type ValueHistoryStore,
  type ValueSnapshot,
} from './value-history.store.ts';

type StoreLogger = Pick<Logger, 'warn' | 'error'>;

/** One snapshot as the import moves it: `n` is its place among the subject's snapshots at the same `at`. */
export interface ValueHistoryRecord {
  readonly k: HistoryKind;
  readonly id: string;
  readonly s: ValueSnapshot;
  readonly n: number;
}

/** The import's key for a record. */
export function valueHistoryKey(record: ValueHistoryRecord): string {
  return JSON.stringify([record.k, record.id, record.s.at, record.n]);
}

const ORDER = 'ORDER BY at, dup';

export class SqliteValueHistoryStore implements ValueHistoryStore {
  readonly #db: SenteDb;
  readonly #max: number;
  readonly #logger: StoreLogger;
  readonly #nextDup: StatementSync;
  readonly #insert: StatementSync;
  readonly #countSubject: StatementSync;
  readonly #dropOldest: StatementSync;
  readonly #list: StatementSync;
  readonly #last: StatementSync;
  /** Subjects by kind, first seen first (the in-memory store's Map order), so `ids` is no scan. */
  readonly #ids = new Map<HistoryKind, Set<string>>();
  readonly #all: StatementSync;
  readonly #count: StatementSync;

  constructor(db: SenteDb, opts: { maxPerSubject?: number; logger?: StoreLogger } = {}) {
    this.#db = db;
    this.#max = opts.maxPerSubject ?? VALUE_HISTORY_PER_SUBJECT;
    this.#logger = opts.logger ?? new Logger('ValueHistory');
    this.#nextDup = db.prepare(
      'SELECT coalesce(max(dup) + 1, 0) AS n FROM value_history ' +
        'WHERE kind = ? AND subject_id = ? AND at = ?',
    );
    this.#insert = db.prepare(
      'INSERT INTO value_history (kind, subject_id, at, dup, data) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (kind, subject_id, at, dup) DO UPDATE SET data = excluded.data',
    );
    this.#countSubject = db.prepare(
      'SELECT count(*) AS n FROM value_history WHERE kind = ? AND subject_id = ?',
    );
    this.#dropOldest = db.prepare(
      'DELETE FROM value_history WHERE seq IN (SELECT seq FROM value_history ' +
        `WHERE kind = ? AND subject_id = ? ${ORDER} LIMIT ?)`,
    );
    this.#list = db.prepare(
      `SELECT data FROM value_history WHERE kind = ? AND subject_id = ? ${ORDER}`,
    );
    this.#last = db.prepare(
      'SELECT data FROM value_history WHERE kind = ? AND subject_id = ? ' +
        'ORDER BY at DESC, dup DESC LIMIT 1',
    );
    this.#all = db.prepare(
      'SELECT kind, subject_id, dup, data FROM value_history ORDER BY kind, subject_id, at, dup',
    );
    this.#count = db.prepare('SELECT count(*) AS n FROM value_history');
    // Seeded once, first seen first; `append` and `put` add each new subject after.
    const seed = db.prepare(
      'SELECT kind, subject_id FROM value_history GROUP BY kind, subject_id ORDER BY min(seq)',
    );
    for (const row of seed.all()) {
      this.#seen(String(row['kind']) as HistoryKind, String(row['subject_id']));
    }
  }

  get path(): string {
    return this.#db.path;
  }

  get size(): number {
    return Number(this.#count.get()!['n']);
  }

  append(kind: HistoryKind, id: string, snapshot: ValueSnapshot): void {
    try {
      this.#db.transaction(() => {
        const dup = Number(this.#nextDup.get(kind, id, snapshot.at)!['n']);
        this.#put({ k: kind, id, s: snapshot, n: dup });
        const over = Number(this.#countSubject.get(kind, id)!['n']) - this.#max;
        if (over > 0) this.#dropOldest.run(kind, id, over);
      });
      this.#seen(kind, id);
    } catch (error) {
      // A missed point is a gap in a chart, not lost money (as in the file store).
      this.#logger.error(
        `${kind} ${id} value at ${snapshot.at} was not written to ${this.path}: ${String(error)}`,
      );
    }
  }

  list(kind: HistoryKind, id: string): readonly ValueSnapshot[] {
    return this.#list.all(kind, id).map(snapshotOf);
  }

  last(kind: HistoryKind, id: string): ValueSnapshot | undefined {
    const row = this.#last.get(kind, id);
    return row ? snapshotOf(row) : undefined;
  }

  ids(kind: HistoryKind): string[] {
    return [...(this.#ids.get(kind) ?? [])];
  }

  /** For `state/db/state-import.ts`: a snapshot at its place, as an upsert. */
  put(record: ValueHistoryRecord): void {
    this.#put(record);
    this.#seen(record.k, record.id);
  }

  /** Every snapshot, by subject, then oldest first: what `put` takes. */
  async listAll(): Promise<ValueHistoryRecord[]> {
    return this.#all.all().map((row) => ({
      k: String(row['kind']) as HistoryKind,
      id: String(row['subject_id']),
      s: snapshotOf(row),
      n: Number(row['dup']),
    }));
  }

  #put(record: ValueHistoryRecord): void {
    this.#insert.run(record.k, record.id, record.s.at, record.n, JSON.stringify(record.s));
  }

  #seen(kind: HistoryKind, id: string): void {
    let ids = this.#ids.get(kind);
    if (!ids) this.#ids.set(kind, (ids = new Set()));
    ids.add(id);
  }
}

function snapshotOf(row: Record<string, unknown>): ValueSnapshot {
  return JSON.parse(String(row['data'])) as ValueSnapshot;
}

/**
 * `value-history.jsonl` as `FileValueHistoryStore` would load it — the same
 * line checks, the same per-subject cap and order — streamed, and without
 * touching the file: a torn last line is skipped and left in place (the file
 * store would cut it off at its next boot). Sorted by subject, then oldest
 * first, each snapshot numbered among its subject's at the same `at`.
 * `undefined` when there is no file.
 */
export function loadValueHistoryRecords(
  path: string,
  maxPerSubject = VALUE_HISTORY_PER_SUBJECT,
): ValueHistoryRecord[] | undefined {
  if (!existsSync(path)) return undefined;
  const memory = new InMemoryValueHistoryStore(maxPerSubject);
  for (const { text, lineNo, isLast } of readJsonlLines(path)) {
    const line = parseLine(text);
    if (line === 'torn') {
      if (isLast) break;
      throw new Error(`${path} line ${lineNo} is not a readable value snapshot. Not importing it.`);
    }
    if (line === 'wrong-version') {
      throw new Error(`${path} line ${lineNo} is not a v1 value snapshot. Not importing it.`);
    }
    memory.append(line.k, line.id, line.s);
  }
  const records: ValueHistoryRecord[] = [];
  // The table's order: kind, subject, then the snapshots oldest first.
  for (const k of ['agent', 'user'] as const) {
    for (const id of memory.ids(k).sort(compare)) {
      let previous: number | undefined;
      let n = 0;
      for (const s of memory.list(k, id)) {
        n = s.at === previous ? n + 1 : 0;
        previous = s.at;
        records.push({ k, id, s, n });
      }
    }
  }
  return records;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
