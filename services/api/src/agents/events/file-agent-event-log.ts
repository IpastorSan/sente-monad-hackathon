// The agent event log, on disk (SEN-65).
//
// ## Why not `state/json-file.ts`
//
// That file rewrites the whole store on every mutation, which is right for tens
// of agent records and wrong for up to 10k events per agent appended on every
// tool call. So this is an append-only JSONL file beside the other state files:
// one `{"v":1,"e":<event>}` line per event, appended and fsynced as it happens,
// read back once at boot into the same `InMemoryAgentEventLog` that serves
// every read. Events are JSON-safe already (`toJsonSafe` on the way in), so
// unlike `json-file.ts` there is no `$date`/`$bigint` tagging.
//
// ## Loading
//
// A crash mid-append leaves at most the LAST line torn, and that line is an
// event whose trade the gate has already reported — losing it is the same as
// the crash landing a moment earlier. So a torn last line is cut off with a
// warning. A torn line anywhere else, or a line of another format version,
// means the file is not what this code wrote, and boot fails naming the path:
// the "refuse to start empty" rule of `json-file.ts`, because an emptied log
// is a Ledger and a cost basis that silently lost their history.
//
// The per-agent cap drops old events in memory but not on disk, so the file
// grows past what a boot keeps. When it holds more than 1.5x the kept events
// plus 1,000 lines, boot rewrites it atomically (temp, fsync, rename) with only
// the kept ones.
//
// ## Remembering what was dropped (SEN-129)
//
// A compaction deletes events for good, and after it the file alone would look
// like a whole history: a cost basis or a preset's capital read off it would be
// wrong with nothing to say so. So the rewrite starts with one
// `{"v":1,"truncated":{"<agentId>":{"evicted":n,"newestEvictedAt":ms}}}` line
// carrying every agent's dropped count, and a load adds to it the events the
// cap drops from what is still in the file. Old code reading a compacted file
// fails on that line rather than starting with a history it thinks is whole.
//
// ## An append that fails to reach disk still resolves
//
// `FileAgentStore` rejects when a write fails, because a hire that is not on
// disk should not happen. Here the event is a record of something that ALREADY
// happened — the order is on the venue — and rejecting would make the gate
// report a landed order as failed, which is worse than the Ledger missing it
// after the next restart. So a failed write is logged as an error and the
// append resolves with the in-memory event. The trade-off: a full or read-only
// disk loses events at the next restart rather than stopping the agents.

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

import {
  addTruncation,
  AGENT_EVENTS_PER_AGENT,
  InMemoryAgentEventLog,
  NOT_TRUNCATED,
  type AgentEvent,
  type AgentEventLog,
  type AgentEventQuery,
  type AgentEventTruncation,
  type NewAgentEvent,
} from './agent-event-log';

/** The file name under `STATE_DIR`. */
export const AGENT_EVENTS_FILE = 'agent-events.jsonl';

/** The `v` of every line. Checked on load, so a format change is a message rather than a mystery. */
const LINE_VERSION = 1;

/** Compact at boot above `COMPACT_RATIO * kept + COMPACT_SLACK` lines. */
const COMPACT_RATIO = 1.5;
const COMPACT_SLACK = 1_000;

type EventLogger = Pick<Logger, 'warn' | 'error'>;

export class FileAgentEventLog implements AgentEventLog {
  readonly #path: string;
  readonly #inner: InMemoryAgentEventLog;
  readonly #logger: EventLogger;
  readonly #size: number;
  #fd: number | undefined;

  /** Loads (and if needed repairs or compacts) the file eagerly, so a bad file fails at boot. */
  constructor(path: string, opts: { maxPerAgent?: number; logger?: EventLogger } = {}) {
    this.#path = resolve(path);
    this.#logger = opts.logger ?? new Logger('AgentEventLog');
    const maxPerAgent = opts.maxPerAgent ?? AGENT_EVENTS_PER_AGENT;

    const { events, lines, truncated } = this.#load();
    const { kept, dropped } = keepNewest(events, maxPerAgent);
    for (const [agentId, more] of dropped) {
      truncated.set(agentId, addTruncation(truncated.get(agentId) ?? NOT_TRUNCATED, more));
    }
    if (lines > COMPACT_RATIO * kept.length + COMPACT_SLACK) this.#rewrite(kept, truncated);

    this.#inner = new InMemoryAgentEventLog(maxPerAgent, kept, truncated);
    this.#size = kept.length;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#fd = openSync(this.#path, 'a', 0o600);
  }

  /** The file behind this log. Logged at boot so the operator knows what a restart will read. */
  get path(): string {
    return this.#path;
  }

  /** How many events came back from disk. Logged at boot. */
  get size(): number {
    return this.#size;
  }

  async append(event: NewAgentEvent): Promise<AgentEvent> {
    // A malformed event (a refusal without a layer) rejects here, before disk.
    const stored = await this.#inner.append(event);
    try {
      if (this.#fd === undefined) throw new Error('the log is closed');
      writeSync(this.#fd, `${JSON.stringify({ v: LINE_VERSION, e: stored })}\n`);
      fsyncSync(this.#fd);
    } catch (error) {
      // Resolve anyway: see "An append that fails to reach disk" in the header.
      this.#logger.error(
        `event ${stored.seq} (${stored.kind}, agent ${stored.agentId}) was not written to ` +
          `${this.#path} and will be missing after a restart: ${String(error)}`,
      );
    }
    return stored;
  }

  list(agentId: string, query?: AgentEventQuery): Promise<AgentEvent[]> {
    return this.#inner.list(agentId, query);
  }

  truncation(agentId: string): Promise<AgentEventTruncation> {
    return this.#inner.truncation(agentId);
  }

  /** Closes the file. Appends after this stay in memory and log an error. */
  close(): void {
    if (this.#fd === undefined) return;
    closeSync(this.#fd);
    this.#fd = undefined;
  }

  /**
   * Every event in the file, how many lines held them, and what earlier
   * compactions dropped. Repairs a torn last line.
   */
  #load(): { events: AgentEvent[]; lines: number; truncated: Map<string, AgentEventTruncation> } {
    const truncated = new Map<string, AgentEventTruncation>();
    if (!existsSync(this.#path)) return { events: [], lines: 0, truncated };
    const text = readFileSync(this.#path, 'utf8');
    const events: AgentEvent[] = [];
    let start = 0;
    let lineNo = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline === -1 ? text.length : newline;
      const isLast = newline === -1 || newline === text.length - 1;
      lineNo += 1;
      const event = parseLine(text.slice(start, end));
      if (event === 'torn') {
        if (!isLast) {
          throw new Error(
            `${this.#path} line ${lineNo} is not a readable event. Refusing to start with a ` +
              'partial history. Move the file aside to start fresh.',
          );
        }
        // Everything before `start` is whole lines, so its byte length is exact.
        truncateSync(this.#path, Buffer.byteLength(text.slice(0, start)));
        this.#logger.warn(
          `${this.#path} ended in a torn line (a crash mid-append?); cut it off at line ${lineNo}`,
        );
        return { events, lines: lineNo - 1, truncated };
      }
      if (event === 'wrong-version') {
        throw new Error(
          `${this.#path} line ${lineNo} is not a v${LINE_VERSION} event. Refusing to start empty.`,
        );
      }
      if (event instanceof Map) {
        for (const [agentId, more] of event) {
          truncated.set(agentId, addTruncation(truncated.get(agentId) ?? NOT_TRUNCATED, more));
        }
      } else {
        events.push(event);
      }
      start = end + 1;
    }
    // A whole last line with no newline after it (only a hand edit does this):
    // terminate it so the next append starts a line of its own.
    if (text.length > 0 && !text.endsWith('\n')) {
      const fd = openSync(this.#path, 'a');
      try {
        writeSync(fd, '\n');
      } finally {
        closeSync(fd);
      }
    }
    return { events, lines: lineNo, truncated };
  }

  /**
   * Replace the file with `events`, atomically — see `JsonRecordFile.save` —
   * led by the line that remembers what was dropped (SEN-129).
   */
  #rewrite(
    events: readonly AgentEvent[],
    truncated: ReadonlyMap<string, AgentEventTruncation>,
  ): void {
    const temp = `${this.#path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try {
      const header =
        truncated.size > 0
          ? `${JSON.stringify({ v: LINE_VERSION, truncated: Object.fromEntries(truncated) })}\n`
          : '';
      const text =
        header + events.map((e) => `${JSON.stringify({ v: LINE_VERSION, e })}\n`).join('');
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

/**
 * One line -> its event (or a compaction's truncation record), `torn` when it
 * does not parse as one, `wrong-version` for another `v`.
 */
function parseLine(
  line: string,
): AgentEvent | Map<string, AgentEventTruncation> | 'torn' | 'wrong-version' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return 'torn';
  }
  const record = parsed as { v?: unknown; e?: Partial<AgentEvent>; truncated?: unknown } | null;
  if (typeof record !== 'object' || record === null) return 'torn';
  if (record.v !== LINE_VERSION) return 'wrong-version';
  if (record.truncated !== undefined) return parseTruncated(record.truncated);
  const e = record.e;
  if (
    typeof e !== 'object' ||
    e === null ||
    !Number.isInteger(e.seq) ||
    typeof e.agentId !== 'string' ||
    typeof e.kind !== 'string'
  ) {
    return 'torn';
  }
  return e as AgentEvent;
}

/** A `truncated` line's per-agent record, or `torn` when any entry is not one. */
function parseTruncated(value: unknown): Map<string, AgentEventTruncation> | 'torn' {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'torn';
  const truncated = new Map<string, AgentEventTruncation>();
  for (const [agentId, entry] of Object.entries(value)) {
    const { evicted, newestEvictedAt } = (entry ?? {}) as Partial<AgentEventTruncation>;
    if (!Number.isInteger(evicted) || evicted! < 0) return 'torn';
    if (newestEvictedAt !== null && typeof newestEvictedAt !== 'number') return 'torn';
    truncated.set(agentId, { evicted: evicted!, newestEvictedAt: newestEvictedAt ?? null });
  }
  return truncated;
}

/**
 * The newest `max` events of each agent, in `seq` order — what the in-memory
 * log will hold — and, per agent, what that leaves out.
 */
function keepNewest(
  events: readonly AgentEvent[],
  max: number,
): { kept: AgentEvent[]; dropped: Map<string, AgentEventTruncation> } {
  const perAgent = new Map<string, number>();
  const kept: AgentEvent[] = [];
  const dropped = new Map<string, AgentEventTruncation>();
  for (const event of [...events].sort((a, b) => b.seq - a.seq)) {
    const count = perAgent.get(event.agentId) ?? 0;
    if (count >= max) {
      dropped.set(
        event.agentId,
        addTruncation(dropped.get(event.agentId) ?? NOT_TRUNCATED, {
          evicted: 1,
          newestEvictedAt: event.at,
        }),
      );
      continue;
    }
    perAgent.set(event.agentId, count + 1);
    kept.push(event);
  }
  return { kept: kept.reverse(), dropped };
}
