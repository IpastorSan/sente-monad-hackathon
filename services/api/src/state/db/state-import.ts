// JSON files -> sente.db (SEN-205): the cut-over's one-time copy.
//
// Reads each store's file under STATE_DIR exactly as the file store would
// (`state/json-file.ts`, so a bad file fails rather than imports empty), writes
// each record whose key the table does not hold yet through the SQLite store's
// `put`, one transaction per store, and then reads the table back and compares
// it with the file record by record. It is insert-only: a key already in the
// table is never overwritten, so a re-run after the API has written under
// `sqlite` only adds what is missing and never reverts a row the API wrote
// (such a row is reported as `changedSince`). It cannot tell a row the API
// deleted from one never imported, so a re-run re-adds deleted records: run it
// once against a fresh `sente.db` (docs/state.md). The files are never
// touched: `STORE_BACKEND=file` is the rollback, and it needs them intact.
//
// It takes the STATE_DIR lock first (`state/state-dir-lock.ts`): a running API
// under `file` would keep rewriting the files behind the copy, and one under
// `sqlite` would be writing the very tables being imported.
//
// ## Adding a store
//
// One entry in `STORE_IMPORTS`: the file, how to load it, the SQLite store's
// `put` and `listAll`, and the key. `loadJsonRecords` covers `.json` envelope
// files; a `.jsonl` store brings its own `load` (streamed with
// `state/jsonl.ts#readJsonlLines`, never the whole file as one string) and sets
// `ordered`, so the check also proves the table reads back in the file's order.
//
// Erasable syntax and `.ts` specifiers: `scripts/state-import-sqlite.ts` runs
// this under node's type stripping (CLAUDE.md gotcha 10).

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  agentEventLogKey,
  loadAgentEventLogRecords,
  SqliteAgentEventLog,
} from '../../agents/events/sqlite-agent-event-log.ts';
import {
  loadRunTranscriptRecords,
  runTranscriptKey,
  SqliteRunTranscriptStore,
} from '../../agents/runner/transcript/sqlite-run-transcript-store.ts';
import { SqliteAgentStore } from '../../agents/store/sqlite-agent-store.ts';
import type { AgentSecretRecord } from '../../agents/venues/file-agent-secret-store.ts';
import { agentSecretRows } from '../../agents/venues/sqlite-agent-secret-store.ts';
import type { SealedCreditKey } from '../../credits/store/file-credit-key-store.ts';
import { creditKeyRows } from '../../credits/store/sqlite-credit-key-store.ts';
import { SqliteCreatorFeeLedger } from '../../fees/sqlite-creator-fees.ts';
import { SqliteProfileStore } from '../../profile/sqlite-profile.store.ts';
import { SqliteStarterKitStore } from '../../starter-kit/sqlite-starter-kit.store.ts';
import type { UserVenueSecretRecord } from '../../trade/file-user-venue-secrets.ts';
import { userVenueSecretRows } from '../../trade/sqlite-user-venue-secrets.ts';
import {
  loadValueHistoryRecords,
  SqliteValueHistoryStore,
  valueHistoryKey,
} from '../../portfolio/history/sqlite-value-history-store.ts';
import { SqliteWatcherStore } from '../../agents/watchers/sqlite-watcher-store.ts';
import { SqliteUserWalletRegistry } from '../../wallet/store/sqlite-user-wallet-registry.ts';
import { encodeValue, JsonRecordFile, type JsonValue } from '../json-file.ts';
import { acquireStateDirLock } from '../state-dir-lock.ts';
import { SenteDb, senteDbPath } from './sente-db.ts';

export interface StoreImport<T> {
  /** The table, as printed. */
  readonly name: string;
  /** The file under STATE_DIR, e.g. `agents.json`. */
  readonly file: string;
  /** The file's records, or `undefined` when the file does not exist. Throws on a bad file. */
  readonly load: (path: string) => T[] | undefined;
  /** The SQLite store over `db`: a write by key, and every record it holds. The import only `put`s absent keys. */
  readonly open: (db: SenteDb) => { put: (record: T) => void; listAll: () => Promise<T[]> };
  readonly key: (record: T) => string;
  /**
   * An append-only log: `listAll` must return the file's records in the
   * file's order (`load`'s), which the check verifies along with the content.
   */
  readonly ordered?: boolean;
}

/** `JsonRecordFile.load`, or `undefined` for a file that is not there. */
export function loadJsonRecords<T>(path: string): T[] | undefined {
  return existsSync(path) ? new JsonRecordFile<T>(path).load() : undefined;
}

function entry<T>(store: StoreImport<T>): StoreImport<unknown> {
  return store as StoreImport<unknown>;
}

/** Every store the import covers, in the order it runs. Append one entry per converted store. */
export const STORE_IMPORTS: readonly StoreImport<unknown>[] = [
  entry<Parameters<SqliteAgentStore['put']>[0]>({
    name: 'agents',
    file: 'agents.json',
    load: loadJsonRecords,
    open: (db) => new SqliteAgentStore(db),
    key: (record) => record.id,
  }),
  entry<Parameters<SqliteUserWalletRegistry['put']>[0]>({
    name: 'user_wallets',
    file: 'user-wallets.json',
    load: loadJsonRecords,
    open: (db) => new SqliteUserWalletRegistry(db),
    key: (record) => record.userId,
  }),
  entry<Parameters<SqliteProfileStore['put']>[0]>({
    name: 'profiles',
    file: 'profiles.json',
    load: loadJsonRecords,
    open: (db) => new SqliteProfileStore(db),
    key: (record) => record.userId,
  }),
  entry<Parameters<SqliteStarterKitStore['put']>[0]>({
    name: 'starter_kits',
    file: 'starter-kits.json',
    load: loadJsonRecords,
    open: (db) => new SqliteStarterKitStore(db),
    key: (record) => record.userId,
  }),
  entry<Parameters<SqliteCreatorFeeLedger['put']>[0]>({
    name: 'creator_fees',
    file: 'creator-fees.json',
    load: loadJsonRecords,
    open: (db) => new SqliteCreatorFeeLedger(db),
    key: (record) => record.id,
  }),
  // The sealed stores: rows in, rows out, ciphertext as it is — no AGENT_SECRETS_KEY here.
  entry<SealedCreditKey>({
    name: 'credit_keys',
    file: 'credit-keys.json',
    load: loadJsonRecords,
    open: creditKeyRows,
    key: (record) => record.userId,
  }),
  entry<AgentSecretRecord>({
    name: 'agent_secrets',
    file: 'agent-secrets.json',
    load: loadJsonRecords,
    open: agentSecretRows,
    key: (record) => record.agentId,
  }),
  entry<UserVenueSecretRecord>({
    name: 'user_venue_secrets',
    file: 'user-venue-secrets.json',
    load: loadJsonRecords,
    open: userVenueSecretRows,
    key: (record) => record.userId,
  }),
  entry<Parameters<SqliteAgentEventLog['put']>[0]>({
    name: 'agent_events',
    file: 'agent-events.jsonl',
    load: (path) => loadAgentEventLogRecords(path),
    open: (db) => new SqliteAgentEventLog(db),
    key: agentEventLogKey,
    ordered: true,
  }),
  entry<Parameters<SqliteRunTranscriptStore['put']>[0]>({
    name: 'agent_runs',
    file: 'agent-runs.jsonl',
    load: (path) => loadRunTranscriptRecords(path),
    // The import never starts or appends a run, so loading the table is all this does.
    open: (db) => new SqliteRunTranscriptStore(db),
    key: runTranscriptKey,
    ordered: true,
  }),
  entry<Parameters<SqliteValueHistoryStore['put']>[0]>({
    name: 'value_history',
    file: 'value-history.jsonl',
    load: (path) => loadValueHistoryRecords(path),
    open: (db) => new SqliteValueHistoryStore(db),
    key: valueHistoryKey,
    ordered: true,
  }),
  entry<Parameters<SqliteWatcherStore['put']>[0]>({
    name: 'agent_watchers',
    file: 'agent-watchers.json',
    load: loadJsonRecords,
    open: (db) => new SqliteWatcherStore(db),
    key: (record) => record.agentId,
  }),
];

export interface StoreImportReport {
  readonly name: string;
  readonly file: string;
  /** `undefined`: no such file, nothing imported. */
  readonly fileCount: number | undefined;
  /** What the table holds after the import. */
  readonly dbCount: number;
  /** File records written by this run: their key was not in the table. */
  readonly inserted: number;
  /** File records whose stored copy is identical. */
  readonly matched: number;
  /**
   * File records whose stored copy differs: the API changed the row under
   * `sqlite` since the first copy. Left as the API wrote it; not a failure.
   */
  readonly changedSince: number;
  /** File records absent from the table — never, unless the import failed. */
  readonly missing: number;
  /** Table records with no file counterpart: written by the API under `sqlite` since the copy. */
  readonly dbOnly: number;
  /**
   * For an `ordered` store: whether the file's records read back from the
   * table in the file's order (records only in the table are skipped). Always
   * true for the others.
   */
  readonly inOrder: boolean;
  readonly fileHash: string | undefined;
  readonly dbHash: string;
  /** Every file record's key is in the table (and, for an `ordered` store, in the file's order). */
  readonly ok: boolean;
}

/**
 * Import every store's file in `dir` into `<dir>/sente.db`. Throws
 * `StateDirLockedError` while another process holds the directory. `log`
 * reports progress; the script prints it, the spec does not.
 */
export async function importStateToSqlite(
  dir: string,
  log: (line: string) => void = () => {},
): Promise<StoreImportReport[]> {
  const root = resolve(dir);
  const lock = acquireStateDirLock(root);
  try {
    const db = SenteDb.open(senteDbPath(root));
    try {
      log(`Opened ${db.path} (schema v${db.schemaVersion})`);
      const reports: StoreImportReport[] = [];
      for (const store of STORE_IMPORTS) {
        reports.push(await importStore(db, root, store, log));
      }
      return reports;
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}

async function importStore(
  db: SenteDb,
  root: string,
  store: StoreImport<unknown>,
  log: (line: string) => void,
): Promise<StoreImportReport> {
  const path = join(root, store.file);
  const records = store.load(path);
  const table = store.open(db);
  let inserted = 0;
  if (records !== undefined) {
    // Insert-only: what the table holds now — a previous run's copy or the API's writes since — stays.
    const held = new Set((await table.listAll()).map(store.key));
    db.transaction(() => {
      for (const record of records) {
        if (held.has(store.key(record))) continue;
        table.put(record);
        inserted += 1;
      }
    });
    log(
      `${store.name}: ${inserted} of ${records.length} record(s) from ${store.file} written ` +
        `(${records.length - inserted} already in the table, left as they are)`,
    );
  } else {
    log(`${store.name}: no ${store.file} in ${root}, nothing imported`);
  }

  // Each record's canonical form once, keyed; the comparison and the hashes both read these.
  const inFile = records ? canonicalByKey(records, store.key) : undefined;
  const inDb = canonicalByKey(await table.listAll(), store.key);
  let matched = 0;
  let changedSince = 0;
  let missing = 0;
  for (const [key, line] of inFile ?? []) {
    const copy = inDb.get(key);
    if (copy === undefined) missing += 1;
    else if (copy === line) matched += 1;
    else changedSince += 1;
  }
  let dbOnly = 0;
  for (const key of inDb.keys()) if (!inFile?.has(key)) dbOnly += 1;
  const inOrder = !store.ordered || !inFile || sameOrder(inFile, inDb);
  return {
    name: store.name,
    file: store.file,
    fileCount: records?.length,
    dbCount: inDb.size,
    inserted,
    matched,
    changedSince,
    missing,
    dbOnly,
    inOrder,
    fileHash: inFile ? hashOf(inFile) : undefined,
    dbHash: hashOf(inDb),
    ok: missing === 0 && inOrder,
  };
}

/** The file's keys appear in the table's listing in the file's order. */
function sameOrder(inFile: Map<string, string>, inDb: Map<string, string>): boolean {
  const fileKeys = inFile.keys();
  for (const key of inDb.keys()) {
    if (!inFile.has(key)) continue;
    if (fileKeys.next().value !== key) return false;
  }
  return true;
}

/**
 * sha256 over the records' tagged JSON, sorted by key with object keys sorted,
 * so the same records hash the same whichever store they came out of.
 */
export function contentHash<T>(records: readonly T[], key: (record: T) => string): string {
  return hashOf(canonicalByKey(records, key));
}

function hashOf(canonical: Map<string, string>): string {
  const lines = [...canonical.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, line]) => line);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Each record as tagged JSON with every object's keys sorted, by its key. */
function canonicalByKey<T>(records: readonly T[], key: (record: T) => string): Map<string, string> {
  return new Map(
    records.map((record) => [key(record), JSON.stringify(sortKeys(encodeValue(record)))]),
  );
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]!);
    return out;
  }
  return value;
}
