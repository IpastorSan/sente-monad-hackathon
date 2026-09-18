// A JSON file on disk, for the stores this repo has always kept in memory.
//
// ## Why this exists (SEN-48)
//
// Every store here is a `Map` — `wallet/store/*`, `agents/store/agent-store.ts`,
// `gas/ledger`. For most of them a restart costs a testnet inconvenience. For
// two of them it costs a wallet:
//
//   - a Privy user wallet's address is NOT derivable from the device key, so a
//     lost binding means the next `POST /wallet/register` mints a SECOND wallet
//     and whatever the first one holds becomes unreachable from the product;
//   - a lost agent record orphans a funded agent wallet, its policy id and its
//     ERC-8004 identity, all of which live on at their providers under ids
//     nothing here remembers any more.
//
// So this is not a database. It is the smallest thing that makes a restart
// between registration and a demo survivable: load once at boot, write through
// on every mutation, and replace the file atomically so a crash mid-write
// leaves the previous good file rather than half of the new one.
//
// ## Two decisions worth knowing about
//
// **A file that exists and does not parse is fatal, not empty.** Starting with
// an empty registry is precisely the failure this file was written to prevent
// — it looks like success and mints a second wallet. Boot fails naming the
// path instead, and the operator decides.
//
// **`Date` and `bigint` are tagged, not stringified.** `JSON.stringify` throws
// on a bigint and flattens a `Date` to a string that never comes back as one,
// and the records here carry both (`createdAt`, `gasFunding.amountWei`, and
// every atom inside a parsed mandate). The codec walks the value generically
// rather than naming fields, so a record that grows a field persists it with no
// change here. `{"$date":…}` and `{"$bigint":…}` are therefore reserved
// shapes: a stored object with exactly that one key decodes back as a Date or
// a bigint.
//
// This file holds erasable syntax only, and the file-backed stores import it
// with a `.ts` specifier, so `scripts/privy-wallets-recover.ts` can load them
// under node's type stripping (CLAUDE.md gotcha 10).

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The env var that turns persistence on. Unset: every store stays in memory. */
export const STATE_DIR_VAR = 'STATE_DIR';

type Env = Record<string, string | undefined>;

/**
 * The directory the file-backed stores write to, or `undefined` when
 * `STATE_DIR` is unset or blank — which is what keeps the specs, and a plain
 * `pnpm start`, on the in-memory stores.
 *
 * A relative value resolves against the process's cwd, so the documented
 * `STATE_DIR=services/api/.state` means the same directory whichever package
 * script started the API.
 */
export function stateDir(env: Env = process.env): string | undefined {
  const value = env[STATE_DIR_VAR]?.trim();
  return value ? resolve(value) : undefined;
}

/** `<STATE_DIR>/<name>.json`, or `undefined` when `STATE_DIR` is unset. */
export function statePath(name: string, env: Env = process.env): string | undefined {
  const dir = stateDir(env);
  return dir ? join(dir, `${name}.json`) : undefined;
}

/** What `save` writes. Checked on load, so a format change is a message rather than a mystery. */
const ENVELOPE_VERSION = 1;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * A list of records in one JSON file.
 *
 * Deliberately synchronous. These files are small (tens of records), and a
 * synchronous write is the only kind that cannot interleave with the next
 * mutation of the same store — no lock, no queue, no half-applied state.
 */
export class JsonRecordFile<T> {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  /** Every stored record, or `[]` when the file does not exist yet. Throws on a file it cannot read. */
  load(): T[] {
    if (!existsSync(this.path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      throw new Error(
        `${this.path} is not readable JSON. Refusing to start empty: an empty store here ` +
          'mints a second wallet. Move the file aside to start fresh.',
        { cause: error },
      );
    }
    const envelope = parsed as { version?: unknown; records?: unknown } | null;
    if (envelope?.version !== ENVELOPE_VERSION || !Array.isArray(envelope.records)) {
      throw new Error(
        `${this.path} is not a v${ENVELOPE_VERSION} state file. Refusing to start empty.`,
      );
    }
    return envelope.records.map((record) => decode(record as JsonValue) as T);
  }

  /**
   * Replace the file with `records`, atomically.
   *
   * Write a sibling temp file, flush it, then `rename` over the target —
   * `rename` within a directory is atomic, so a reader (or the next boot after
   * a crash mid-write) sees either the whole previous file or the whole new
   * one, never a truncated mixture.
   */
  save(records: readonly T[]): void {
    const text = JSON.stringify(
      { version: ENVELOPE_VERSION, records: records.map((record) => encode(record)) },
      null,
      2,
    );
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const handle = openSync(temp, 'w', 0o600);
    try {
      writeSync(handle, text);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    try {
      renameSync(temp, this.path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

/**
 * `instanceof Date` would do here, and it would be wrong exactly where it
 * matters: the stores hand records through `structuredClone`, whose output
 * carries the HOST realm's `Date` prototype. Under jest's vm sandbox that is
 * not the `Date` this module sees, `instanceof` answers false, and a timestamp
 * is silently persisted as `{}` — an agent that loads back with no `createdAt`.
 * The brand check is realm-independent.
 */
function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/** Value -> JSON, tagging what JSON has no room for. See the header. */
function encode(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (isDate(value)) return { $date: value.toISOString() };
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot persist the number ${String(value)}`);
    return value;
  }
  // `undefined` inside an array becomes null, exactly as JSON.stringify does;
  // as an object property it is dropped below, which is what makes an absent
  // optional field absent again on load rather than present-and-undefined.
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => encode(item));
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = encode(item);
    }
    return out;
  }
  throw new Error(`cannot persist a ${typeof value}`);
}

/** JSON -> value, untagging what `encode` tagged. */
function decode(value: JsonValue): unknown {
  if (Array.isArray(value)) return value.map((item) => decode(item));
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const tagged = value as { $bigint?: JsonValue; $date?: JsonValue };
      if (typeof tagged.$bigint === 'string') return BigInt(tagged.$bigint);
      if (typeof tagged.$date === 'string') return new Date(tagged.$date);
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = decode(value[key] as JsonValue);
    return out;
  }
  return value;
}
