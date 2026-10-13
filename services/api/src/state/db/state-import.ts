// JSON files -> sente.db (SEN-205): the cut-over's one-time copy.
//
// Reads each store's file under STATE_DIR exactly as the file store would
// (`state/json-file.ts`, so a bad file fails rather than imports empty), writes
// every record into its table through the SQLite store's `put` (an upsert by
// key, so re-running is safe and a second run after new API writes changes
// nothing it should not), one transaction per store, and then reads the table
// back and compares it with the file record by record. The files are never
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
// files; a `.jsonl` store brings its own `load`.
//
// Erasable syntax and `.ts` specifiers: `scripts/state-import-sqlite.ts` runs
// this under node's type stripping (CLAUDE.md gotcha 10).

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SqliteAgentStore } from '../../agents/store/sqlite-agent-store.ts';
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
  /** The SQLite store over `db`: an upsert by key, and every record it holds. */
  readonly open: (db: SenteDb) => { put: (record: T) => void; listAll: () => Promise<T[]> };
  readonly key: (record: T) => string;
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
];

export interface StoreImportReport {
  readonly name: string;
  readonly file: string;
  /** `undefined`: no such file, nothing imported. */
  readonly fileCount: number | undefined;
  /** What the table holds after the import. */
  readonly dbCount: number;
  /** File records whose stored copy is identical. */
  readonly matched: number;
  /** File records whose stored copy differs — never, unless something else wrote the table since. */
  readonly differs: number;
  /** File records absent from the table — never, unless the import failed. */
  readonly missing: number;
  /** Table records with no file counterpart: written by the API under `sqlite` since the copy. */
  readonly dbOnly: number;
  readonly fileHash: string | undefined;
  readonly dbHash: string;
  /** Every file record is in the table, identical. */
  readonly ok: boolean;
}

export interface ImportOptions {
  readonly imports?: readonly StoreImport<unknown>[];
  /** Report progress; the script prints it, the spec does not. */
  readonly log?: (line: string) => void;
}

/**
 * Import every store's file in `dir` into `<dir>/sente.db`. Throws
 * `StateDirLockedError` while another process holds the directory.
 */
export async function importStateToSqlite(
  dir: string,
  options: ImportOptions = {},
): Promise<StoreImportReport[]> {
  const imports = options.imports ?? STORE_IMPORTS;
  const log = options.log ?? (() => {});
  const root = resolve(dir);
  const lock = acquireStateDirLock(root);
  try {
    const db = SenteDb.open(senteDbPath(root));
    try {
      log(`Opened ${db.path} (schema v${db.schemaVersion})`);
      const reports: StoreImportReport[] = [];
      for (const store of imports) {
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
  if (records !== undefined) {
    db.transaction(() => {
      for (const record of records) table.put(record);
    });
    log(`${store.name}: ${records.length} record(s) from ${store.file} written`);
  } else {
    log(`${store.name}: no ${store.file} in ${root}, nothing imported`);
  }

  const stored = await table.listAll();
  const byKey = new Map(stored.map((record) => [store.key(record), canonical(record)]));
  let matched = 0;
  let differs = 0;
  let missing = 0;
  for (const record of records ?? []) {
    const copy = byKey.get(store.key(record));
    if (copy === undefined) missing += 1;
    else if (copy === canonical(record)) matched += 1;
    else differs += 1;
  }
  const fileKeys = new Set((records ?? []).map((record) => store.key(record)));
  const dbOnly = stored.filter((record) => !fileKeys.has(store.key(record))).length;
  return {
    name: store.name,
    file: store.file,
    fileCount: records?.length,
    dbCount: stored.length,
    matched,
    differs,
    missing,
    dbOnly,
    fileHash: records ? contentHash(records, store.key) : undefined,
    dbHash: contentHash(stored, store.key),
    ok: differs === 0 && missing === 0,
  };
}

/**
 * sha256 over the records' tagged JSON, sorted by key with object keys sorted,
 * so the same records hash the same whichever store they came out of.
 */
export function contentHash<T>(records: readonly T[], key: (record: T) => string): string {
  const lines = records
    .map((record) => [key(record), canonical(record)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, line]) => line);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** One record as tagged JSON with every object's keys sorted. */
function canonical(record: unknown): string {
  return JSON.stringify(sortKeys(encodeValue(record)));
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
