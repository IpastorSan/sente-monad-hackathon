// Run transcripts in SQLite (SEN-205), the way `FileRunTranscriptStore` keeps
// them in a JSONL journal: the in-memory store serves every read — the runner
// records synchronously from inside its loop and the agent page polls a live
// run's entries, so neither may wait on a query — and the table is the journal
// it is read back from at boot. A run with no `end` after a restart reads as
// `interrupted`, as with the file.
//
// The differences from the file journal:
// - a run the per-agent cap evicts is deleted at once (its entries by
//   cascade), so there is nothing to compact at boot;
// - every write is its own commit under `synchronous = FULL`, so it is on disk
//   when `append` returns, where the file store did not fsync at all. An entry
//   is a few hundred bytes and a run writes tens of them; the fsync is the
//   cost, and it is paid on the runner's loop, like the file write was.
// Like the file store, a write that fails is logged and the run carries on.
//
// Not persisted, as before: how many entries a full run dropped.
//
// Erasable syntax and `.ts` specifiers: the import script loads this under
// node's type stripping (CLAUDE.md gotcha 10).

import { existsSync } from 'node:fs';
import type { StatementSync } from 'node:sqlite';

import { Logger } from '@nestjs/common';

import type { SenteDb } from '../../../state/db/sente-db.ts';
import { readJsonlLines } from '../../../state/jsonl.ts';
import { parse } from './file-run-transcript-store.ts';
import { MAX_ENTRIES_PER_RUN, MAX_RUNS_PER_AGENT, type TranscriptEntry } from './run-transcript.ts';
import { InMemoryRunTranscriptStore, type RunStart } from './run-transcript-store.ts';

type StoreLogger = Pick<Logger, 'warn' | 'error'>;

/** One line of the journal as the import moves it. */
export type RunTranscriptRecord =
  { readonly start: RunStart } | { readonly runId: string; readonly entry: TranscriptEntry };

/** The import's key for a record. */
export function runTranscriptKey(record: RunTranscriptRecord): string {
  return 'start' in record
    ? `run:${record.start.runId}`
    : `entry:${record.runId}:${String(record.entry.seq).padStart(8, '0')}`;
}

export class SqliteRunTranscriptStore extends InMemoryRunTranscriptStore {
  readonly #db: SenteDb;
  readonly #logger: StoreLogger;
  readonly #insertRun: StatementSync;
  readonly #insertEntry: StatementSync;
  readonly #deleteRun: StatementSync;
  readonly #runs: StatementSync;
  readonly #entries: StatementSync;
  #loading = true;

  constructor(
    db: SenteDb,
    opts: { maxRuns?: number; maxEntries?: number; logger?: StoreLogger } = {},
  ) {
    super(opts.maxRuns ?? MAX_RUNS_PER_AGENT, opts.maxEntries ?? MAX_ENTRIES_PER_RUN);
    this.#db = db;
    this.#logger = opts.logger ?? new Logger('RunTranscripts');
    this.#insertRun = db.prepare(
      'INSERT INTO agent_runs (run_id, agent_id, started_at, data) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (run_id) DO UPDATE SET agent_id = excluded.agent_id, ' +
        'started_at = excluded.started_at, data = excluded.data',
    );
    this.#insertEntry = db.prepare(
      'INSERT INTO agent_run_entries (run_id, seq, kind, at, data) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (run_id, seq) DO UPDATE SET kind = excluded.kind, at = excluded.at, ' +
        'data = excluded.data',
    );
    this.#deleteRun = db.prepare('DELETE FROM agent_runs WHERE run_id = ?');
    // By start time, then insertion: a run the import adds after the API has
    // written newer ones must not read back (or survive the cap) as the newest.
    this.#runs = db.prepare('SELECT data FROM agent_runs ORDER BY started_at, rowid');
    this.#entries = db.prepare(
      'SELECT e.run_id, e.data FROM agent_run_entries e JOIN agent_runs r USING (run_id) ' +
        'ORDER BY r.started_at, r.rowid, e.seq',
    );
    this.#load();
    this.#loading = false;
  }

  get path(): string {
    return this.#db.path;
  }

  /** Runs held after the boot read, across every agent. */
  get size(): number {
    return this.byRun.size;
  }

  protected override onStart(run: RunStart): void {
    this.#write(() => this.#putRun(run));
  }

  protected override onEntry(runId: string, entry: TranscriptEntry): void {
    this.#write(() => this.#putEntry(runId, entry));
  }

  protected override onEvict(run: RunStart): void {
    // At boot too: a run the cap pushes out of what is read back is gone for good.
    this.#write(() => this.#deleteRun.run(run.runId));
  }

  /** For `state/db/state-import.ts`: one journal line, as an upsert. */
  put(record: RunTranscriptRecord): void {
    if ('start' in record) this.#putRun(record.start);
    else this.#putEntry(record.runId, record.entry);
  }

  /** Every run in the order they started, each followed by its entries: what `put` takes. */
  async listAll(): Promise<RunTranscriptRecord[]> {
    const entries = new Map<string, RunTranscriptRecord[]>();
    for (const row of this.#entries.all()) {
      const runId = String(row['run_id']);
      const list = entries.get(runId) ?? [];
      list.push({ runId, entry: JSON.parse(String(row['data'])) as TranscriptEntry });
      entries.set(runId, list);
    }
    const out: RunTranscriptRecord[] = [];
    for (const row of this.#runs.all()) {
      const start = JSON.parse(String(row['data'])) as RunStart;
      out.push({ start }, ...(entries.get(start.runId) ?? []));
    }
    return out;
  }

  #putRun(run: RunStart): void {
    this.#insertRun.run(run.runId, run.agentId, run.startedAt, JSON.stringify(run));
  }

  #putEntry(runId: string, entry: TranscriptEntry): void {
    this.#insertEntry.run(runId, entry.seq, entry.kind, entry.at, JSON.stringify(entry));
  }

  #write(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      if (this.#loading) throw error;
      this.#logger.error(`could not write a run transcript to ${this.path}: ${String(error)}`);
    }
  }

  /** Replays the table into memory; evicts (and deletes) what the cap no longer keeps. */
  #load(): void {
    // Read both result sets before replaying: the replay's evictions delete rows.
    const runs = this.#runs.all().map((row) => JSON.parse(String(row['data'])) as RunStart);
    const entries = this.#entries.all();
    for (const run of runs) this.open(run, true);
    for (const row of entries) {
      this.restore(String(row['run_id']), JSON.parse(String(row['data'])) as TranscriptEntry);
    }
  }
}

/**
 * `agent-runs.jsonl` as `FileRunTranscriptStore` would read it back — the same
 * line checks (an unreadable line is skipped), the same per-agent run cap —
 * streamed, and without touching the file. The records come out in the order
 * the kept runs started, each followed by its entries. `undefined` when there
 * is no file.
 */
export function loadRunTranscriptRecords(
  path: string,
  log: (line: string) => void = () => {},
): RunTranscriptRecord[] | undefined {
  if (!existsSync(path)) return undefined;
  const replay = new TranscriptReplay();
  let skipped = 0;
  for (const { text } of readJsonlLines(path)) {
    if (!text.trim()) continue;
    const line = parse(text);
    if (!line) skipped += 1;
    else if ('start' in line) replay.begin(line.start);
    else replay.entry(line.runId, line.entry);
  }
  if (skipped > 0) log(`${path}: skipped ${skipped} unreadable line(s), as the file store does`);
  return replay.records();
}

/** The in-memory store's own replay, so the cap and the order are exactly the file store's. */
class TranscriptReplay extends InMemoryRunTranscriptStore {
  readonly #order: string[] = [];

  begin(run: RunStart): void {
    this.#order.push(run.runId);
    this.open(run, true);
  }

  entry(runId: string, entry: TranscriptEntry): void {
    this.restore(runId, entry);
  }

  records(): RunTranscriptRecord[] {
    const runs = [];
    const seen = new Set<string>();
    for (const runId of this.#order) {
      const held = this.byRun.get(runId);
      // A runId started twice is held once, at its last start.
      if (!held || seen.has(runId)) continue;
      seen.add(runId);
      runs.push(held);
    }
    // The table reads runs back by start time (then insertion). The file is in
    // that order per agent but not across agents (a compaction rewrites it
    // agent by agent), so sort the same way; the sort is stable for ties.
    runs.sort((a, b) => a.start.startedAt - b.start.startedAt);
    const out: RunTranscriptRecord[] = [];
    for (const held of runs) {
      out.push({ start: held.start });
      for (const entry of held.entries) out.push({ runId: held.start.runId, entry });
    }
    return out;
  }
}
