import type { Migration } from './migration.ts';

/**
 * The two stores whose loss costs a wallet (SEN-48), first into SQLite (SEN-205).
 *
 * The pattern every later migration follows: one table per store, a real
 * column for the key and for each field a store looks records up by, and the
 * whole record in `data` as the same tagged JSON `state/json-file.ts` writes
 * (`{"$date":…}`, `{"$bigint":…}`), so a record round-trips exactly and a field
 * added to the TypeScript type persists with no schema change. The columns are
 * for `WHERE` and `ORDER BY`; the record of truth is `data`.
 *
 * `created_at` columns hold ISO 8601 UTC, which sorts as time sorts.
 */
export const migration: Migration = {
  id: 1,
  name: 'agents-and-user-wallets',
  sql: `
    CREATE TABLE IF NOT EXISTS agents (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      -- the wallet address lower-cased, the key \`findByAddress\` looks up
      address_key    TEXT NOT NULL,
      mcp_token_hash TEXT NOT NULL UNIQUE,
      status         TEXT NOT NULL,
      archived_at    TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      data           TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agents_by_user ON agents (user_id, created_at);
    CREATE INDEX IF NOT EXISTS agents_by_address ON agents (address_key);
    CREATE INDEX IF NOT EXISTS agents_listed_active ON agents (created_at)
      WHERE status = 'active' AND archived_at IS NULL;

    CREATE TABLE IF NOT EXISTS user_wallets (
      user_id           TEXT PRIMARY KEY,
      wallet_id         TEXT NOT NULL,
      address           TEXT NOT NULL,
      device_public_key TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      data              TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS user_wallets_by_address ON user_wallets (address);
  `,
};
