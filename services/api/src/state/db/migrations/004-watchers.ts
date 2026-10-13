import type { Migration } from './migration.ts';

/**
 * The watcher store (SEN-182) into SQLite (SEN-205): one row per agent's
 * watcher set, the whole set — watchers, every edge clause's previous answer,
 * cooldowns and counters — in `data`, as `agent-watchers.json` held it. The
 * scheduler reads a set by agent id and nothing else, so the key is the only
 * lookup column; `updated_at` (ISO 8601 UTC) is there for a human with
 * `sqlite3`.
 */
export const migration: Migration = {
  id: 4,
  name: 'agent-watchers',
  sql: `
    CREATE TABLE IF NOT EXISTS agent_watchers (
      agent_id   TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      data       TEXT NOT NULL
    ) STRICT;
  `,
};
