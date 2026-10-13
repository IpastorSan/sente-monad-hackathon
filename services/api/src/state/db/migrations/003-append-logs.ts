import type { Migration } from './migration.ts';

/**
 * The three append-only logs (SEN-205): the agent event log, run transcripts
 * and the value history, each a JSONL file under `STATE_DIR` before this.
 *
 * Unlike the record stores, `data` holds the payload as the plain JSON the
 * JSONL files carry (no `$date`/`$bigint` tagging: every event, entry and
 * snapshot is JSON-safe before it is stored), so a row decodes to exactly what
 * the file store served. The columns are what the reads filter and order by.
 *
 * - `agent_events.seq` is the event's `seq` itself, AUTOINCREMENT so a number
 *   is never handed out twice (a phone's `afterSeq` cursor relies on it).
 *   Reads are per agent in `seq` order, narrowed by `kind` or `run_id`, hence
 *   the three `(agent_id, …, seq)` indexes; `at` is indexed for time windows.
 * - `agent_event_truncation`: what the per-agent cap evicted (SEN-129).
 * - `agent_runs` / `agent_run_entries`: one row per run, in `rowid` order (the
 *   order the runs started), and one per transcript entry, by `seq` within its
 *   run. Evicting a run deletes its entries by cascade.
 * - `value_history`: one row per snapshot. `dup` numbers a subject's
 *   snapshots stamped at the same millisecond in arrival order, so
 *   `(kind, subject_id, at, dup)` is both the key the import upserts by and
 *   the file store's order: by time, arrival order on a tie.
 */
export const migration: Migration = {
  id: 3,
  name: 'append-logs',
  sql: `
    CREATE TABLE IF NOT EXISTS agent_events (
      seq      INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      run_id   TEXT,
      kind     TEXT NOT NULL,
      -- unix epoch milliseconds
      at       INTEGER NOT NULL,
      data     TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_events_by_agent ON agent_events (agent_id, seq);
    CREATE INDEX IF NOT EXISTS agent_events_by_kind ON agent_events (agent_id, kind, seq);
    CREATE INDEX IF NOT EXISTS agent_events_by_run ON agent_events (agent_id, run_id, seq);
    CREATE INDEX IF NOT EXISTS agent_events_by_time ON agent_events (at);

    CREATE TABLE IF NOT EXISTS agent_event_truncation (
      agent_id          TEXT PRIMARY KEY,
      evicted           INTEGER NOT NULL,
      newest_evicted_at INTEGER
    ) STRICT;

    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id     TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      data       TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_runs_by_agent ON agent_runs (agent_id);

    CREATE TABLE IF NOT EXISTS agent_run_entries (
      run_id TEXT NOT NULL REFERENCES agent_runs (run_id) ON DELETE CASCADE,
      seq    INTEGER NOT NULL,
      kind   TEXT NOT NULL,
      at     INTEGER NOT NULL,
      data   TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS value_history (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      at         INTEGER NOT NULL,
      dup        INTEGER NOT NULL,
      data       TEXT NOT NULL,
      UNIQUE (kind, subject_id, at, dup)
    ) STRICT;
  `,
};
