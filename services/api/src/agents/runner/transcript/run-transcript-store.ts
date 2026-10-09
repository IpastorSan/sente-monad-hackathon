/**
 * Where run transcripts live (SEN-178): the last `MAX_RUNS_PER_AGENT` runs of
 * each agent, each with at most `MAX_ENTRIES_PER_RUN` entries.
 *
 * A run's summary (iterations, tokens, cost, stop reason) is DERIVED from its
 * entries as they are appended, so the list and the transcript can never
 * disagree. Synchronous on purpose: the runner records from inside its loop and
 * a transcript must never be able to fail or slow a run.
 *
 * PERSISTENCE: in memory here; `FileRunTranscriptStore` adds an append-only
 * JSONL journal under STATE_DIR (one process per STATE_DIR, gotcha 14).
 */
import {
  MAX_ENTRIES_PER_RUN,
  MAX_RUNS_PER_AGENT,
  type RunTranscriptSummary,
  type TranscriptEntry,
  type TranscriptEntryBody,
} from './run-transcript';
import type { RunTrigger } from '../agent-runner.service';

/** DI token for the `RunTranscriptStore`. */
export const RUN_TRANSCRIPTS = Symbol('RUN_TRANSCRIPTS');

export interface RunStart {
  readonly runId: string;
  readonly agentId: string;
  readonly trigger: RunTrigger;
  readonly model: string;
  /** Unix epoch milliseconds. */
  readonly startedAt: number;
}

export interface RunTranscriptPage {
  readonly run: RunTranscriptSummary;
  /** Entries with `seq > after`, oldest first. */
  readonly entries: readonly TranscriptEntry[];
}

export interface RunTranscriptStore {
  /** Opens a run. Evicts the agent's oldest run past the cap. */
  start(run: RunStart): void;
  /** Appends to an open run; ignored for a run this store does not hold. */
  append(runId: string, body: TranscriptEntryBody, at?: number): void;
  /** The agent's runs, newest first. */
  list(agentId: string): RunTranscriptSummary[];
  /** One run of this agent, with its entries after `after`; undefined if it is not held. */
  read(agentId: string, runId: string, after?: number): RunTranscriptPage | undefined;
}

/** A run as held: its summary fields, mutable, plus its entries. */
interface HeldRun {
  start: RunStart;
  entries: TranscriptEntry[];
  seq: number;
  dropped: number;
  noted: boolean;
  iterations: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ended?: Extract<TranscriptEntry, { kind: 'end' }>;
  /** Read back from disk without an `end`: the process stopped mid-run. */
  interrupted: boolean;
}

export const TRANSCRIPT_FULL_NOTE =
  'Transcript full: later steps are not shown. The run carried on; its orders are in History.';

export class InMemoryRunTranscriptStore implements RunTranscriptStore {
  /** agentId → runs, oldest first. */
  protected readonly byAgent = new Map<string, HeldRun[]>();
  protected readonly byRun = new Map<string, HeldRun>();

  constructor(
    protected readonly maxRuns = MAX_RUNS_PER_AGENT,
    protected readonly maxEntries = MAX_ENTRIES_PER_RUN,
  ) {}

  start(run: RunStart): void {
    this.open(run, false);
    this.onStart(run);
  }

  append(runId: string, body: TranscriptEntryBody, at = Date.now()): void {
    const held = this.byRun.get(runId);
    if (!held || held.ended) return;
    const stored = this.accept(held, body, at);
    for (const entry of stored) this.onEntry(runId, entry);
  }

  list(agentId: string): RunTranscriptSummary[] {
    return (this.byAgent.get(agentId) ?? []).map(summaryOf).reverse();
  }

  read(agentId: string, runId: string, after = 0): RunTranscriptPage | undefined {
    const held = this.byRun.get(runId);
    if (!held || held.start.agentId !== agentId) return undefined;
    return { run: summaryOf(held), entries: held.entries.filter((e) => e.seq > after) };
  }

  /** Persistence hooks; the in-memory store has none. */
  protected onStart(_run: RunStart): void {}
  protected onEntry(_runId: string, _entry: TranscriptEntry): void {}
  /** Called with every run the cap pushes out. */
  protected onEvict(_run: RunStart): void {}

  protected open(run: RunStart, interrupted: boolean): HeldRun {
    const held: HeldRun = {
      start: { ...run },
      entries: [],
      seq: 0,
      dropped: 0,
      noted: false,
      iterations: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      interrupted,
    };
    const runs = this.byAgent.get(run.agentId) ?? [];
    runs.push(held);
    this.byAgent.set(run.agentId, runs);
    this.byRun.set(run.runId, held);
    while (runs.length > this.maxRuns) {
      const evicted = runs.shift()!;
      this.byRun.delete(evicted.start.runId);
      this.onEvict(evicted.start);
    }
    return held;
  }

  /**
   * Counts the entry into the summary and stores it, unless the run is full.
   * A full run still counts usage and tool calls, keeps one note saying it is
   * full, and always keeps its `end`. Returns what was stored.
   */
  protected accept(held: HeldRun, body: TranscriptEntryBody, at: number): TranscriptEntry[] {
    if (body.kind === 'usage') {
      held.iterations += 1;
      held.inputTokens += body.inputTokens;
      held.outputTokens += body.outputTokens;
      held.costUsd += body.costUsd ?? 0;
    } else if (body.kind === 'tool_call') {
      held.toolCalls += 1;
    }

    const stored: TranscriptEntry[] = [];
    const push = (b: TranscriptEntryBody) => {
      const entry = { ...b, seq: ++held.seq, at } as TranscriptEntry;
      held.entries.push(entry);
      stored.push(entry);
    };
    // Two places are held back: the note and the end.
    if (body.kind !== 'end' && held.entries.length >= this.maxEntries - 2) {
      held.dropped += 1;
      if (!held.noted) {
        held.noted = true;
        push({ kind: 'note', text: TRANSCRIPT_FULL_NOTE });
      }
      return stored;
    }
    push(body);
    if (body.kind === 'end') held.ended = stored[0] as Extract<TranscriptEntry, { kind: 'end' }>;
    return stored;
  }

  /** Puts an entry read back from disk in place, `seq` and all, and counts it. */
  protected restore(runId: string, entry: TranscriptEntry): void {
    const held = this.byRun.get(runId);
    if (!held) return;
    if (entry.kind === 'usage') {
      held.iterations += 1;
      held.inputTokens += entry.inputTokens;
      held.outputTokens += entry.outputTokens;
      held.costUsd += entry.costUsd ?? 0;
    } else if (entry.kind === 'tool_call') {
      held.toolCalls += 1;
    } else if (entry.kind === 'note' && entry.text === TRANSCRIPT_FULL_NOTE) {
      held.noted = true;
    }
    held.entries.push(entry);
    held.seq = Math.max(held.seq, entry.seq);
    if (entry.kind === 'end') {
      held.ended = entry;
      held.interrupted = false;
    }
  }
}

function summaryOf(held: HeldRun): RunTranscriptSummary {
  const end = held.ended;
  const cost = end?.costUsd ?? (held.costUsd > 0 ? round(held.costUsd) : undefined);
  return {
    runId: held.start.runId,
    agentId: held.start.agentId,
    trigger: held.start.trigger,
    model: held.start.model,
    status: end ? 'ended' : held.interrupted ? 'interrupted' : 'running',
    startedAt: held.start.startedAt,
    ...(end ? { endedAt: end.at, stopReason: end.stopReason } : {}),
    iterations: end?.iterations ?? held.iterations,
    toolCalls: end?.toolCalls ?? held.toolCalls,
    inputTokens: end?.inputTokens ?? held.inputTokens,
    outputTokens: end?.outputTokens ?? held.outputTokens,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    lastSeq: held.seq,
    droppedEntries: held.dropped,
  };
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}
