import type { Migration } from './migration.ts';

/**
 * Six small stores into SQLite (SEN-205, phase 2): the profiles, the starter
 * kits, the creator fee ledger and the three stores sealed under
 * `AGENT_SECRETS_KEY` (credit keys, agent secrets, user venue secrets).
 *
 * Same pattern as 001: a column for the key and for every field a store looks
 * records up by, the whole record in `data` as tagged JSON. The sealed stores'
 * `data` is the file's record exactly — ciphertext, IV and tag — so nothing in
 * those tables is readable without the key, and the import never needs it.
 */
export const migration: Migration = {
  id: 2,
  name: 'small-stores-and-secrets',
  sql: `
    CREATE TABLE IF NOT EXISTS profiles (
      user_id    TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      data       TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS starter_kits (
      user_id    TEXT PRIMARY KEY,
      address    TEXT NOT NULL,
      status     TEXT NOT NULL,
      -- SHA-256 of the claiming IP (SEN-204), never the IP itself
      ip_hash    TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data       TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS starter_kits_by_day ON starter_kits (created_at);
    CREATE INDEX IF NOT EXISTS starter_kits_by_ip ON starter_kits (ip_hash, created_at)
      WHERE ip_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS starter_kits_pending ON starter_kits (status)
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS creator_fees (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      creator_user_id TEXT NOT NULL,
      -- NULL on a payout
      agent_id        TEXT,
      asset           TEXT NOT NULL,
      -- the tx hash lower-cased: both duplicate checks compare it case-blind
      tx_key          TEXT NOT NULL,
      at              TEXT NOT NULL,
      data            TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS creator_fees_by_creator ON creator_fees (creator_user_id, at);
    CREATE INDEX IF NOT EXISTS creator_fees_by_tx ON creator_fees (tx_key, agent_id, asset);

    CREATE TABLE IF NOT EXISTS credit_keys (
      user_id    TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      data       TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS agent_secrets (
      agent_id TEXT PRIMARY KEY,
      data     TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS user_venue_secrets (
      user_id TEXT PRIMARY KEY,
      data    TEXT NOT NULL
    ) STRICT;
  `,
};
