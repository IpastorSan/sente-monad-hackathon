// Run transcripts on disk (SEN-178), the same way as the event log (SEN-65):
// an append-only JSONL journal under STATE_DIR, read back once at boot into the
// in-memory store that serves every read.
//
// Lines: `{"v":1,"start":<RunStart>}` opens a run, `{"v":1,"runId":…,"entry":<entry>}`
// adds one of its entries. A run with no `end` entry after a restart was cut
// off by the restart and reads as `interrupted`.
//
// Unlike the event log this is a debugging view, not a record of account, so:
// - a line that does not parse is SKIPPED with a warning rather than failing
//   boot — losing a transcript is never worth an API that will not start;
// - appends are not fsynced; a crash may lose the last few entries;
// - a write that fails is logged and the run carries on.
//
// The file only grows between boots. At boot, when it holds more lines than
// the runs it keeps (the per-agent cap evicted some), it is rewritten
// atomically (temp, rename) with only those.
//
// Not persisted: how many entries a full run dropped (`droppedEntries` reads 0
// after a restart; the "transcript full" note itself is kept).

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Logger } from '@nestjs/common';

import { MAX_ENTRIES_PER_RUN, MAX_RUNS_PER_AGENT, type TranscriptEntry } from './run-transcript';
import { InMemoryRunTranscriptStore, type RunStart } from './run-transcript-store';

export const RUN_TRANSCRIPTS_FILE = 'agent-runs.jsonl';

const LINE_VERSION = 1;

type Line = { v: 1; start: RunStart } | { v: 1; runId: string; entry: TranscriptEntry };

type StoreLogger = Pick<Logger, 'warn' | 'error'>;

export class FileRunTranscriptStore extends InMemoryRunTranscriptStore {
  readonly #path: string;
  readonly #logger: StoreLogger;
  #fd: number | undefined;
  #loading = true;

  constructor(
    path: string,
    opts: { maxRuns?: number; maxEntries?: number; logger?: StoreLogger } = {},
  ) {
    super(opts.maxRuns ?? MAX_RUNS_PER_AGENT, opts.maxEntries ?? MAX_ENTRIES_PER_RUN);
    this.#path = resolve(path);
    this.#logger = opts.logger ?? new Logger('RunTranscripts');
    const lines = this.#load();
    this.#loading = false;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    if (lines > this.#keptLines()) this.#rewrite();
    this.#fd = openSync(this.#path, 'a', 0o600);
  }

  get path(): string {
    return this.#path;
  }

  /** Runs held after the boot read, across every agent. */
  get size(): number {
    return this.byRun.size;
  }

  close(): void {
    if (this.#fd === undefined) return;
    closeSync(this.#fd);
    this.#fd = undefined;
  }

  protected override onStart(run: RunStart): void {
    this.#write({ v: LINE_VERSION, start: run });
  }

  protected override onEntry(runId: string, entry: TranscriptEntry): void {
    this.#write({ v: LINE_VERSION, runId, entry });
  }

  #write(line: Line): void {
    if (this.#loading) return;
    try {
      if (this.#fd === undefined) throw new Error('the store is closed');
      writeSync(this.#fd, `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.#logger.error(`could not write to ${this.#path}: ${String(error)}`);
    }
  }

  /** Replays the journal; returns how many lines it had. */
  #load(): number {
    if (!existsSync(this.#path)) return 0;
    const text = readFileSync(this.#path, 'utf8');
    let count = 0;
    let skipped = 0;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      count += 1;
      const line = parse(raw);
      if (!line) {
        skipped += 1;
        continue;
      }
      if ('start' in line) this.open(line.start, true);
      else this.restore(line.runId, line.entry);
    }
    if (skipped > 0) {
      this.#logger.warn(`${this.#path}: skipped ${skipped} unreadable line(s)`);
    }
    return count;
  }

  #keptLines(): number {
    let lines = 0;
    for (const runs of this.byAgent.values()) {
      for (const run of runs) lines += 1 + run.entries.length;
    }
    return lines;
  }

  #rewrite(): void {
    const temp = `${this.#path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const out: string[] = [];
    for (const runs of this.byAgent.values()) {
      for (const run of runs) {
        out.push(JSON.stringify({ v: LINE_VERSION, start: run.start }));
        for (const entry of run.entries) {
          out.push(JSON.stringify({ v: LINE_VERSION, runId: run.start.runId, entry }));
        }
      }
    }
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeSync(fd, out.length > 0 ? `${out.join('\n')}\n` : '');
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, this.#path);
    } catch (error) {
      rmSync(temp, { force: true });
      this.#logger.error(`could not compact ${this.#path}: ${String(error)}`);
    }
  }
}

function parse(raw: string): Line | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const line = value as Partial<{
    v: unknown;
    start: RunStart;
    runId: unknown;
    entry: TranscriptEntry;
  }>;
  if (line.v !== LINE_VERSION) return undefined;
  if (
    line.start &&
    typeof line.start.runId === 'string' &&
    typeof line.start.agentId === 'string'
  ) {
    return { v: 1, start: line.start };
  }
  if (
    typeof line.runId === 'string' &&
    line.entry &&
    Number.isInteger(line.entry.seq) &&
    typeof line.entry.kind === 'string'
  ) {
    return { v: 1, runId: line.runId, entry: line.entry };
  }
  return undefined;
}
