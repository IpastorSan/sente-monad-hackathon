/**
 * The agent terminal's logic (SEN-178), with no React Native in it so plain
 * node can test it: the wire shapes of `GET /agents/:id/runs[/:runId]`, how a
 * polled page merges into what the terminal already holds, when to poll next,
 * and how each transcript entry reads as a terminal line.
 *
 * The wire types mirror `services/api/src/agents/runner/transcript/run-transcript.ts`.
 */
import { modelLabel } from './api.ts';
import { relativeAge } from './usage.ts';

export type RunStatus = 'running' | 'ended' | 'interrupted';

export type RunSummary = {
  runId: string;
  agentId: string;
  trigger: 'manual' | 'schedule';
  model: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  stopReason?: string;
  iterations: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  lastSeq: number;
  droppedEntries: number;
};

type Stamp = { seq: number; at: number };

export type TranscriptEntry = Stamp &
  (
    | {
        kind: 'start';
        trigger: 'manual' | 'schedule';
        model: string;
        instruction?: string;
        thinkingRequested: boolean;
      }
    | {
        kind: 'thinking';
        turn: number;
        visibility: 'visible' | 'omitted' | 'redacted';
        source: 'thinking' | 'reasoning';
        text?: string;
        truncated?: boolean;
      }
    | { kind: 'text'; turn: number; text: string; truncated?: boolean }
    | {
        kind: 'tool_call';
        turn: number;
        toolUseId: string;
        tool: string;
        market?: string;
        input: string;
      }
    | {
        kind: 'tool_result';
        toolUseId?: string;
        tool: string;
        status: 'ok' | 'refused' | 'error';
        layer?: 'sente' | 'enclave';
        code?: string;
        summary: string;
      }
    | {
        kind: 'usage';
        turn: number;
        inputTokens: number;
        outputTokens: number;
        costUsd?: number;
        stopReason: string | null;
      }
    | {
        kind: 'end';
        stopReason: string;
        iterations: number;
        toolCalls: number;
        inputTokens: number;
        outputTokens: number;
        costUsd?: number;
        durationMs: number;
        thinkingTurns: number;
        error?: string;
      }
    | { kind: 'note'; text: string }
  );

export type RunTranscriptPage = {
  run: RunSummary;
  entries: TranscriptEntry[];
  nextSeq: number;
};

// ─── Polling ────────────────────────────────────────────────────────────────

/** While a run is live. */
export const LIVE_POLL_MS = 1_500;
/** The runs list while nothing runs: often enough to notice a scheduled run start. */
export const IDLE_POLL_MS = 6_000;
const MAX_BACKOFF_MS = 15_000;

export type RunView = {
  run: RunSummary | null;
  /** Oldest first, one per `seq`. */
  entries: TranscriptEntry[];
  /** The cursor for the next poll: the highest `seq` held. */
  nextSeq: number;
  loaded: boolean;
  /** The last failure, cleared by the next good poll. */
  error: string | null;
  /** Consecutive failures, for the backoff. */
  failures: number;
  /** The server no longer holds this run (404 `run_not_found`). */
  gone: boolean;
};

export const EMPTY_VIEW: RunView = {
  run: null,
  entries: [],
  nextSeq: 0,
  loaded: false,
  error: null,
  failures: 0,
  gone: false,
};

/**
 * A page folded into the view. Entries are keyed by `seq`, so a page that
 * overlaps what is held (a retried poll) adds nothing twice and cannot reorder.
 */
export function applyPage(view: RunView, page: RunTranscriptPage): RunView {
  const held = new Set(view.entries.map((e) => e.seq));
  const fresh = page.entries.filter((e) => !held.has(e.seq));
  const entries =
    fresh.length === 0 ? view.entries : [...view.entries, ...fresh].sort((a, b) => a.seq - b.seq);
  return {
    run: page.run,
    entries,
    nextSeq: Math.max(view.nextSeq, page.nextSeq, entries.at(-1)?.seq ?? 0),
    loaded: true,
    error: null,
    failures: 0,
    gone: false,
  };
}

export function applyFailure(view: RunView, message: string, gone = false): RunView {
  return { ...view, loaded: true, error: message, failures: view.failures + 1, gone };
}

/**
 * When to poll this run again, or `null` to stop: it is over (ended,
 * interrupted, or no longer held). A failing poll backs off; a live run is
 * read every `LIVE_POLL_MS`.
 */
export function nextPollDelay(view: RunView): number | null {
  if (view.gone) return null;
  if (view.failures > 0) return Math.min(LIVE_POLL_MS * 2 ** view.failures, MAX_BACKOFF_MS);
  if (!view.loaded || view.run === null) return LIVE_POLL_MS;
  return view.run.status === 'running' ? LIVE_POLL_MS : null;
}

/** The runs list's cadence: fast while one is live, slow otherwise. */
export function runsPollDelay(runs: readonly RunSummary[] | null, failures: number): number {
  if (failures > 0) return Math.min(IDLE_POLL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS * 2);
  return runs?.some((r) => r.status === 'running') ? LIVE_POLL_MS : IDLE_POLL_MS;
}

export type Scheduler = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/**
 * Polls one run's transcript until it is over or `stop()` is called. Each
 * poll is scheduled after the previous one settles, never beside it. The
 * cursor is the view's `nextSeq`, so a run already held in full costs one
 * request with an empty answer.
 */
export function pollRun(options: {
  fetchPage: (after: number) => Promise<RunTranscriptPage>;
  onView: (view: RunView) => void;
  /** `true` for an error that means the run is gone for good (a 404). */
  isGone?: (error: unknown) => boolean;
  scheduler?: Scheduler;
  initial?: RunView;
}): () => void {
  const scheduler: Scheduler = options.scheduler ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let view = options.initial ?? EMPTY_VIEW;
  let stopped = false;
  let handle: unknown;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const page = await options.fetchPage(view.nextSeq);
      if (stopped) return;
      view = applyPage(view, page);
    } catch (error) {
      if (stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      view = applyFailure(view, message, options.isGone?.(error) ?? false);
    }
    options.onView(view);
    const delay = nextPollDelay(view);
    if (delay !== null && !stopped) handle = scheduler.setTimeout(() => void tick(), delay);
  };

  void tick();
  return () => {
    stopped = true;
    if (handle !== undefined) scheduler.clearTimeout(handle);
  };
}

// ─── Lines ──────────────────────────────────────────────────────────────────

/**
 * What a line is, which is what colours it: `meta` (start, notes), `thinking`
 * (dim), `say` (the agent's own words), `call`, `ok`, `refused` (the mandate
 * or the enclave holding — the product working, never an error), `error`,
 * `usage`, `end`.
 */
export type LineTone =
  'meta' | 'thinking' | 'say' | 'call' | 'ok' | 'refused' | 'error' | 'usage' | 'end';

export type TerminalLine = {
  key: string;
  seq: number;
  tone: LineTone;
  /** One character, the line's kind at a glance. */
  glyph: string;
  /** The head of the line. */
  text: string;
  /** Under or after the head, quieter: a call's arguments, a result's summary. */
  detail?: string;
  /** `+12.4s` since the run started. */
  elapsed: string;
  /** Set on the first line of each model turn, so the terminal can rule it off. */
  turnStart?: number;
};

const STOP_LABELS: Record<string, string> = {
  end_turn: 'finished',
  stop_sequence: 'stop sequence',
  refusal: 'the model refused',
  max_tokens: 'hit the token limit',
  model_context_window_exceeded: 'context window full',
  max_iterations: 'hit the turn limit',
  timeout: 'timed out',
  agent_revoked: 'stopped: agent revoked',
  credits_exhausted: 'out of credits',
  model_error: 'model call failed',
};

export function stopLabel(stopReason: string | undefined): string {
  if (!stopReason) return 'running';
  return STOP_LABELS[stopReason] ?? stopReason.replace(/_/g, ' ');
}

export function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1_000).toFixed(1)}k` : n.toLocaleString('en-US');
}

export function formatCost(usd: number | undefined): string | null {
  if (usd === undefined) return null;
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1_000;
  if (s < 60) return `+${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `+${m}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

function join(...parts: (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(' · ');
}

/**
 * Every entry as terminal lines, in order. `startedAt` anchors the elapsed
 * gutter; without it the first entry does.
 */
export function formatEntries(
  entries: readonly TranscriptEntry[],
  startedAt?: number,
): TerminalLine[] {
  const origin = startedAt ?? entries[0]?.at ?? 0;
  const lines: TerminalLine[] = [];
  let turn = 0;
  for (const entry of entries) {
    const entryTurn = 'turn' in entry ? entry.turn : null;
    const opensTurn = entryTurn !== null && entryTurn !== turn;
    if (entryTurn !== null) turn = entryTurn;
    const made = formatEntry(entry, formatElapsed(entry.at - origin));
    if (opensTurn && made[0]) made[0] = { ...made[0], turnStart: entryTurn };
    lines.push(...made);
  }
  return lines;
}

/** One entry's lines: one, or two for an end that has something more to say. */
export function formatEntry(entry: TranscriptEntry, elapsed = ''): TerminalLine[] {
  const base = { key: String(entry.seq), seq: entry.seq, elapsed };
  switch (entry.kind) {
    case 'start':
      return [
        {
          ...base,
          tone: 'meta',
          glyph: '▸',
          text: join(
            `${entry.trigger === 'schedule' ? 'Scheduled' : 'Manual'} run started`,
            modelLabel(entry.model),
            entry.thinkingRequested && 'thinking requested',
          ),
          ...(entry.instruction ? { detail: `“${entry.instruction}”` } : {}),
        },
      ];
    case 'note':
      return [{ ...base, tone: 'meta', glyph: '·', text: entry.text }];
    case 'thinking': {
      const what = entry.source === 'reasoning' ? 'reasoning' : 'thinking';
      const text =
        entry.visibility === 'visible'
          ? `${entry.text ?? ''}${entry.truncated ? ' …[cut]' : ''}`
          : entry.visibility === 'redacted'
            ? `${what} redacted by the provider (encrypted, not readable)`
            : `${what} hidden by the provider (only its signature came back)`;
      return [{ ...base, tone: 'thinking', glyph: '∴', text }];
    }
    case 'text':
      return [
        {
          ...base,
          tone: 'say',
          glyph: '›',
          text: `${entry.text}${entry.truncated ? ' …[cut]' : ''}`,
        },
      ];
    case 'tool_call':
      return [{ ...base, tone: 'call', glyph: '→', text: entry.tool, detail: entry.input }];
    case 'tool_result': {
      if (entry.status === 'ok') {
        return [
          { ...base, tone: 'ok', glyph: '✓', text: `${entry.tool} ok`, detail: entry.summary },
        ];
      }
      if (entry.status === 'refused') {
        const reason = refusalReason(entry.summary);
        const by =
          entry.layer === 'enclave' ? 'refused by the enclave' : 'refused by the mandate check';
        return [
          {
            ...base,
            tone: 'refused',
            glyph: '⊘',
            text: `${entry.tool} ${by}${entry.code ? ` (${entry.code})` : ''}`,
            ...(reason ? { detail: reason } : {}),
          },
        ];
      }
      return [
        { ...base, tone: 'error', glyph: '✗', text: `${entry.tool} failed`, detail: entry.summary },
      ];
    }
    case 'usage':
      return [
        {
          ...base,
          tone: 'usage',
          glyph: '≡',
          text: join(
            `turn ${entry.turn}`,
            `${formatTokens(entry.inputTokens)} in`,
            `${formatTokens(entry.outputTokens)} out`,
            formatCost(entry.costUsd),
          ),
        },
      ];
    case 'end': {
      const lines: TerminalLine[] = [
        {
          ...base,
          tone: entry.error ? 'error' : 'end',
          glyph: '■',
          text: join(
            `Run ${stopLabel(entry.stopReason)}`,
            `${entry.iterations} turn${entry.iterations === 1 ? '' : 's'}`,
            `${entry.toolCalls} tool call${entry.toolCalls === 1 ? '' : 's'}`,
            `${formatTokens(entry.inputTokens + entry.outputTokens)} tokens`,
            formatCost(entry.costUsd),
            `${(entry.durationMs / 1_000).toFixed(1)}s`,
          ),
          ...(entry.error ? { detail: entry.error } : {}),
        },
      ];
      if (entry.thinkingTurns === 0 && entry.iterations > 0) {
        lines.push({
          ...base,
          key: `${entry.seq}-thinking`,
          tone: 'meta',
          glyph: '·',
          text: 'The model returned no reasoning on this run.',
        });
      }
      return lines;
    }
  }
}

/**
 * A refusal's message without the prefix the head already says: "Refused by
 * Sente mandate: <code>. " and "Refused by the Privy enclave (<code>): ".
 */
export function refusalReason(summary: string): string {
  return summary
    .replace(/^Refused by Sente mandate: [a-z_]+\.\s*/, '')
    .replace(/^Refused by the Privy enclave \([^)]*\):?\s*/, '')
    .trim();
}

/** A run as one row of the history list. */
export function describeRun(
  run: RunSummary,
  now: number,
): { title: string; caption: string; live: boolean } {
  const live = run.status === 'running';
  const age = relativeAge(run.startedAt, now);
  return {
    title: `${run.trigger === 'schedule' ? 'Scheduled' : 'Manual'} run · ${age === 'now' ? 'just now' : `${age} ago`}`,
    caption: join(
      live
        ? 'running'
        : run.status === 'interrupted'
          ? 'cut off by a server restart'
          : stopLabel(run.stopReason),
      `${run.iterations} turn${run.iterations === 1 ? '' : 's'}`,
      `${run.toolCalls} call${run.toolCalls === 1 ? '' : 's'}`,
      formatCost(run.costUsd),
    ),
    live,
  };
}
