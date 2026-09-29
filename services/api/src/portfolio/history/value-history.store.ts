// The ≈ $ value history of every user and agent (SEN-152).
//
// ## Why a store at all
//
// `/portfolio` and `/agents/:id/portfolio` re-read chain and venue state on
// every call and remember nothing, so the Portfolio hero could only chart what
// the phone saw since it opened. A chart over a day, a week or a month needs a
// value from back then, and nothing but a record taken back then can give it:
// balances can be re-read, a price an hour ago cannot.
//
// ## Why append-only JSONL, like the agent event log
//
// Snapshots only ever arrive, one per subject per hour (plus one after a
// landed trade), so a year of one user is ~9k lines. `state/json-file.ts`
// rewrites the whole store per mutation, which is right for tens of records
// and wrong here. So this follows `agents/events/file-agent-event-log.ts`: one
// `{"v":1,…}` line per snapshot, appended and fsynced, read back once at boot.
// A torn LAST line (a crash mid-append) is cut off with a warning, since it is
// one hourly point; a torn line anywhere else, or another version, fails boot
// naming the path, the "refuse to start empty" rule of `json-file.ts`.
//
// No lock of its own: `STATE_DIR` has one writer process (SEN-161), and every
// append here is a synchronous write from that process.

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
  truncateSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Logger } from '@nestjs/common';

import type { Decimal } from '../../venues/dto/markets.dto';

/** Whose value: the session user's own total, or one agent's. */
export type HistoryKind = 'user' | 'agent';

export interface ValueSnapshot {
  /** Unix ms of the reads behind it. */
  readonly at: number;
  /** ≈ $, exact decimal: USDC and AUSD at $1, everything else at its Kuru price. */
  readonly usd: Decimal;
  /** A section (or an agent, or the prices) did not answer, so `usd` leaves it out. */
  readonly partial?: true;
}

export interface ValueHistoryStore {
  append(kind: HistoryKind, id: string, snapshot: ValueSnapshot): void;
  /** Oldest first. */
  list(kind: HistoryKind, id: string): readonly ValueSnapshot[];
  last(kind: HistoryKind, id: string): ValueSnapshot | undefined;
  /** Every id of `kind` with at least one snapshot. */
  ids(kind: HistoryKind): string[];
}

export const VALUE_HISTORY_STORE = Symbol('VALUE_HISTORY_STORE');

/** The file name under `STATE_DIR`. */
export const VALUE_HISTORY_FILE = 'value-history.jsonl';

/**
 * Per subject: over two years of hourly points plus trade points. Older ones
 * drop, so one subject can never grow the boot without bound.
 */
export const VALUE_HISTORY_PER_SUBJECT = 20_000;

const LINE_VERSION = 1;
const COMPACT_RATIO = 1.5;
const COMPACT_SLACK = 1_000;
const DECIMAL = /^-?\d+(\.\d+)?$/;

type Line = { k: HistoryKind; id: string; s: ValueSnapshot };

export class InMemoryValueHistoryStore implements ValueHistoryStore {
  readonly #bySubject = new Map<string, ValueSnapshot[]>();
  readonly #max: number;

  constructor(max = VALUE_HISTORY_PER_SUBJECT) {
    this.#max = max;
  }

  append(kind: HistoryKind, id: string, snapshot: ValueSnapshot): void {
    const key = subjectKey(kind, id);
    const list = this.#bySubject.get(key) ?? [];
    // Kept sorted: a snapshot is stamped with the time its reads started, so
    // two that overlap can land out of order.
    let i = list.length;
    while (i > 0 && list[i - 1]!.at > snapshot.at) i -= 1;
    list.splice(i, 0, snapshot);
    if (list.length > this.#max) list.splice(0, list.length - this.#max);
    this.#bySubject.set(key, list);
  }

  list(kind: HistoryKind, id: string): readonly ValueSnapshot[] {
    return this.#bySubject.get(subjectKey(kind, id)) ?? [];
  }

  last(kind: HistoryKind, id: string): ValueSnapshot | undefined {
    const list = this.#bySubject.get(subjectKey(kind, id));
    return list?.[list.length - 1];
  }

  ids(kind: HistoryKind): string[] {
    const prefix = `${kind}:`;
    return [...this.#bySubject.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  /** Every kept snapshot as a line, for the boot compaction. */
  lines(): Line[] {
    const out: Line[] = [];
    for (const [key, list] of this.#bySubject) {
      const colon = key.indexOf(':');
      const k = key.slice(0, colon) as HistoryKind;
      const id = key.slice(colon + 1);
      for (const s of list) out.push({ k, id, s });
    }
    return out;
  }

  get size(): number {
    let n = 0;
    for (const list of this.#bySubject.values()) n += list.length;
    return n;
  }
}

type StoreLogger = Pick<Logger, 'warn' | 'error'>;

export class FileValueHistoryStore implements ValueHistoryStore {
  readonly #path: string;
  readonly #inner: InMemoryValueHistoryStore;
  readonly #logger: StoreLogger;
  #fd: number | undefined;

  /** Loads (and if needed repairs or compacts) the file eagerly, so a bad file fails at boot. */
  constructor(path: string, opts: { maxPerSubject?: number; logger?: StoreLogger } = {}) {
    this.#path = resolve(path);
    this.#logger = opts.logger ?? new Logger('ValueHistory');
    this.#inner = new InMemoryValueHistoryStore(opts.maxPerSubject);
    const lines = this.#load();
    for (const line of lines) this.#inner.append(line.k, line.id, line.s);
    if (lines.length > COMPACT_RATIO * this.#inner.size + COMPACT_SLACK) this.#rewrite();
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#fd = openSync(this.#path, 'a', 0o600);
  }

  get path(): string {
    return this.#path;
  }

  get size(): number {
    return this.#inner.size;
  }

  append(kind: HistoryKind, id: string, snapshot: ValueSnapshot): void {
    this.#inner.append(kind, id, snapshot);
    try {
      if (this.#fd === undefined) throw new Error('the store is closed');
      writeSync(this.#fd, `${JSON.stringify({ v: LINE_VERSION, k: kind, id, s: snapshot })}\n`);
      fsyncSync(this.#fd);
    } catch (error) {
      // A missed point is a gap in a chart, not lost money: keep serving it
      // from memory rather than fail the recorder's whole tick.
      this.#logger.error(
        `${kind} ${id} value at ${snapshot.at} was not written to ${this.#path}: ${String(error)}`,
      );
    }
  }

  list(kind: HistoryKind, id: string): readonly ValueSnapshot[] {
    return this.#inner.list(kind, id);
  }

  last(kind: HistoryKind, id: string): ValueSnapshot | undefined {
    return this.#inner.last(kind, id);
  }

  ids(kind: HistoryKind): string[] {
    return this.#inner.ids(kind);
  }

  close(): void {
    if (this.#fd === undefined) return;
    closeSync(this.#fd);
    this.#fd = undefined;
  }

  #load(): Line[] {
    if (!existsSync(this.#path)) return [];
    const text = readFileSync(this.#path, 'utf8');
    const lines: Line[] = [];
    let start = 0;
    let lineNo = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline === -1 ? text.length : newline;
      const isLast = newline === -1 || newline === text.length - 1;
      lineNo += 1;
      const line = parseLine(text.slice(start, end));
      if (line === 'torn') {
        if (!isLast) {
          throw new Error(
            `${this.#path} line ${lineNo} is not a readable value snapshot. Refusing to start ` +
              'with a partial history. Move the file aside to start fresh.',
          );
        }
        truncateSync(this.#path, Buffer.byteLength(text.slice(0, start)));
        this.#logger.warn(
          `${this.#path} ended in a torn line (a crash mid-append?); cut it off at line ${lineNo}`,
        );
        return lines;
      }
      if (line === 'wrong-version') {
        throw new Error(
          `${this.#path} line ${lineNo} is not a v${LINE_VERSION} value snapshot. Refusing to start empty.`,
        );
      }
      lines.push(line);
      start = end + 1;
    }
    if (text.length > 0 && !text.endsWith('\n')) {
      const fd = openSync(this.#path, 'a');
      try {
        writeSync(fd, '\n');
      } finally {
        closeSync(fd);
      }
    }
    return lines;
  }

  /** Only the kept snapshots, atomically: temp, fsync, rename (see `JsonRecordFile.save`). */
  #rewrite(): void {
    const temp = `${this.#path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try {
      const text = this.#inner
        .lines()
        .map((line) => `${JSON.stringify({ v: LINE_VERSION, ...line })}\n`)
        .join('');
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, this.#path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

function subjectKey(kind: HistoryKind, id: string): string {
  return `${kind}:${id}`;
}

function parseLine(text: string): Line | 'torn' | 'wrong-version' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'torn';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'torn';
  const record = parsed as { v?: unknown; k?: unknown; id?: unknown; s?: Partial<ValueSnapshot> };
  if (record.v !== LINE_VERSION) return 'wrong-version';
  const { k, id, s } = record;
  if (
    (k !== 'user' && k !== 'agent') ||
    typeof id !== 'string' ||
    typeof s !== 'object' ||
    s === null ||
    !Number.isSafeInteger(s.at) ||
    typeof s.usd !== 'string' ||
    !DECIMAL.test(s.usd)
  ) {
    return 'torn';
  }
  return { k, id, s: { at: s.at!, usd: s.usd, ...(s.partial === true ? { partial: true } : {}) } };
}
