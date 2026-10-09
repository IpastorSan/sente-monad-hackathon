/**
 * A run's transcript (SEN-178): what the agent saw, said, thought and did
 * during one Tool Runner run, entry by entry, so its owner can watch it work
 * live and read it back afterwards.
 *
 * This is a VIEW of a run, not its record of account: the event log
 * (`events/agent-event-log.ts`) stays the source of truth for orders, fills and
 * refusals. So the transcript is bounded and lossy on purpose — every text is
 * truncated, a run keeps at most `MAX_ENTRIES_PER_RUN` entries, and an agent
 * keeps its last `MAX_RUNS_PER_AGENT` runs.
 *
 * WHAT IS NEVER IN IT: the owner's OpenRouter key, any `Bearer` header, an MCP
 * token, or a value under a key that names a secret. Every string goes through
 * `redact` on the way in, with the run's own key as an exact match on top of
 * the shape patterns.
 *
 * THINKING is recorded as it arrives, and its absence is recorded too:
 * - a `thinking` block with text → a `thinking` entry with that text;
 * - a `thinking` block with an empty text (Anthropic's `display: 'omitted'`, or
 *   a provider that keeps only the signature) → `visibility: 'omitted'`;
 * - a `redacted_thinking` block → `visibility: 'redacted'` (it is encrypted);
 * - a non-standard `reasoning` field (OpenRouter's chat-completions shape, in
 *   case a provider leaks it into the Messages response) → `source: 'reasoning'`.
 * The `end` entry counts the turns that carried any, so "no reasoning returned"
 * is a fact the client can print rather than an empty space.
 */
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages';

import type { RefusalLayer } from '../../events/agent-event-log';
import type { ToolOutcome } from '../../tools/gate';
import type { RunStopReason, RunTrigger } from '../agent-runner.service';

export const MAX_RUNS_PER_AGENT = 10;
export const MAX_ENTRIES_PER_RUN = 400;
export const MAX_TEXT = 2_000;
export const MAX_THINKING = 4_000;
export const MAX_SUMMARY = 240;
export const MAX_INSTRUCTION = 500;
const MAX_FIELD = 80;

export type RunStatus = 'running' | 'ended' | 'interrupted';

/** One run, without its entries: what `GET /agents/:id/runs` lists. */
export interface RunTranscriptSummary {
  readonly runId: string;
  readonly agentId: string;
  readonly trigger: RunTrigger;
  readonly model: string;
  /** `interrupted`: the process stopped while the run was open (read back from disk). */
  readonly status: RunStatus;
  /** Unix epoch milliseconds. */
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly stopReason?: RunStopReason;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
  /** The highest `seq` in the run: a client holding it is up to date. */
  readonly lastSeq: number;
  /** Entries dropped past `MAX_ENTRIES_PER_RUN`. */
  readonly droppedEntries: number;
}

export type ToolResultStatus = 'ok' | 'refused' | 'error';

/** Entry bodies, as the recorder writes them; the store stamps `seq` and `at`. */
export type TranscriptEntryBody =
  | {
      readonly kind: 'start';
      readonly trigger: RunTrigger;
      readonly model: string;
      readonly instruction?: string;
      /** Whether the runner asked for `thinking` (AGENT_RUNNER_THINKING). */
      readonly thinkingRequested: boolean;
    }
  | {
      readonly kind: 'thinking';
      readonly turn: number;
      readonly visibility: 'visible' | 'omitted' | 'redacted';
      readonly source: 'thinking' | 'reasoning';
      readonly text?: string;
      readonly truncated?: boolean;
    }
  | {
      readonly kind: 'text';
      readonly turn: number;
      readonly text: string;
      readonly truncated?: boolean;
    }
  | {
      readonly kind: 'tool_call';
      readonly turn: number;
      readonly toolUseId: string;
      readonly tool: string;
      /** The market the call is about, when its input names one. */
      readonly market?: string;
      readonly input: string;
    }
  | {
      readonly kind: 'tool_result';
      readonly toolUseId?: string;
      readonly tool: string;
      readonly status: ToolResultStatus;
      /** Set on a refusal: our own gate (`sente`, the precheck) or the Privy enclave. */
      readonly layer?: RefusalLayer;
      readonly code?: string;
      readonly summary: string;
    }
  | {
      readonly kind: 'usage';
      readonly turn: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly costUsd?: number;
      readonly stopReason: string | null;
    }
  | {
      readonly kind: 'end';
      readonly stopReason: RunStopReason;
      readonly iterations: number;
      readonly toolCalls: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly costUsd?: number;
      readonly durationMs: number;
      /** Turns that carried any thinking or reasoning, visible or not. */
      readonly thinkingTurns: number;
      readonly error?: string;
    }
  | { readonly kind: 'note'; readonly text: string };

export type TranscriptEntry = TranscriptEntryBody & {
  /** 1, 2, 3… within the run. Poll with `?after=<seq>`. */
  readonly seq: number;
  /** Unix epoch milliseconds. */
  readonly at: number;
};

export type TranscriptEntryKind = TranscriptEntry['kind'];

// ─── Redaction ──────────────────────────────────────────────────────────────

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/sk-or-[A-Za-z0-9_-]+/g, 'sk-or-[redacted]'],
  [/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[redacted]'],
  [/sente_mcp_[A-Za-z0-9_-]+/g, 'sente_mcp_[redacted]'],
  [/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]'],
  [/privy-app-secret[^\s"',}]*/gi, '[redacted]'],
];

/** Object keys whose VALUE is never recorded, wherever they appear in a tool input or result. */
const SECRET_KEY = /(api[-_]?key|secret|token|authorization|password|private[-_]?key|mnemonic)/i;

/** `text` with every exact `secrets` match and every key-shaped string replaced. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: `${text.slice(0, max)}…`, truncated: true }
    : { text, truncated: false };
}

/** JSON with secret-named keys masked and bigints as strings. */
function safeJson(value: unknown): string {
  try {
    return (
      JSON.stringify(value ?? null, (key, v: unknown) => {
        if (key && SECRET_KEY.test(key)) return '[redacted]';
        return typeof v === 'bigint' ? v.toString() : v;
      }) ?? 'null'
    );
  } catch {
    return String(value);
  }
}

// ─── Compact summaries ──────────────────────────────────────────────────────

/** Keys shown first, in this order: what a trader reads a call by. */
const LEAD_KEYS = ['venue', 'market', 'symbol', 'side', 'direction', 'size', 'price', 'leverage'];

function scalar(value: unknown): string {
  if (typeof value === 'string') return truncate(value, MAX_FIELD).text;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return truncate(safeJson(value), MAX_FIELD).text;
}

/**
 * A tool input as one line: `venue=kuru market=MON-USDC side=buy size=10
 * price=3.5`, the trading keys first, then the rest in their own order.
 */
export function summariseInput(input: unknown, secrets: readonly string[] = []): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return redact(truncate(safeJson(input), MAX_SUMMARY).text, secrets);
  }
  const record = input as Record<string, unknown>;
  const keys = [
    ...LEAD_KEYS.filter((k) => k in record),
    ...Object.keys(record).filter((k) => !LEAD_KEYS.includes(k)),
  ];
  const line = keys
    .filter((k) => record[k] !== undefined)
    .map((k) => `${k}=${SECRET_KEY.test(k) ? '[redacted]' : scalar(record[k])}`)
    .join(' ');
  return redact(truncate(line || '{}', MAX_SUMMARY).text, secrets);
}

/** The market a tool input is about, if it names one. */
export function marketOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const market = record['market'] ?? record['symbol'];
  return typeof market === 'string' && market.length > 0 ? market.slice(0, MAX_FIELD) : undefined;
}

/** Fields of an order or position result worth a line, when the result is one. */
const RESULT_KEYS = [
  'status',
  'symbol',
  'side',
  'type',
  'size',
  'filledSize',
  'averageFillPrice',
  'price',
  'recorded',
  'txHash',
];

/** A tool outcome as one line: an order's status and fill, a read's size, a refusal's reason. */
export function summariseOutcome(
  outcome: ToolOutcome,
  secrets: readonly string[] = [],
): { status: ToolResultStatus; layer?: RefusalLayer; code?: string; summary: string } {
  if (!outcome.ok) {
    const summary = redact(truncate(outcome.message, MAX_SUMMARY).text, secrets);
    return outcome.refusal
      ? { status: 'refused', layer: outcome.refusal.layer, code: outcome.refusal.code, summary }
      : { status: 'error', summary };
  }
  const result = outcome.result;
  let summary: string;
  if (Array.isArray(result)) {
    summary = `${result.length} item${result.length === 1 ? '' : 's'}: ${safeJson(result)}`;
  } else if (typeof result === 'object' && result !== null) {
    const record = result as Record<string, unknown>;
    const lead = RESULT_KEYS.filter((k) => record[k] !== undefined).map(
      (k) => `${k}=${scalar(record[k])}`,
    );
    summary = lead.length >= 2 ? lead.join(' ') : safeJson(result);
  } else {
    summary = safeJson(result);
  }
  return { status: 'ok', summary: redact(truncate(summary, MAX_SUMMARY).text, secrets) };
}

// ─── Reading a model turn ───────────────────────────────────────────────────

/** OpenRouter adds `usage.cost` (USD) to each response; the SDK does not type it. */
export function costOf(message: BetaMessage): number | undefined {
  const cost = (message.usage as unknown as { cost?: unknown } | undefined)?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/**
 * The entries one assistant message produces, in the order the model wrote
 * them: thinking, text and tool calls interleaved as its content blocks are,
 * then the turn's usage.
 */
export function entriesOfTurn(
  message: BetaMessage,
  turn: number,
  secrets: readonly string[] = [],
): TranscriptEntryBody[] {
  const out: TranscriptEntryBody[] = [];
  // A provider that answers in chat-completions style may put its reasoning
  // beside the content rather than in a block. Not in the SDK's types.
  const loose = message as unknown as { reasoning?: unknown };
  if (typeof loose.reasoning === 'string' && loose.reasoning.trim()) {
    out.push(thinkingEntry(turn, loose.reasoning, 'reasoning', secrets));
  }
  for (const block of message.content as readonly { type: string }[]) {
    const b = block as Record<string, unknown> & { type: string };
    switch (b.type) {
      case 'thinking': {
        const text = typeof b['thinking'] === 'string' ? b['thinking'] : '';
        out.push(
          text.trim()
            ? thinkingEntry(turn, text, 'thinking', secrets)
            : { kind: 'thinking', turn, visibility: 'omitted', source: 'thinking' },
        );
        break;
      }
      case 'redacted_thinking':
        out.push({ kind: 'thinking', turn, visibility: 'redacted', source: 'thinking' });
        break;
      case 'reasoning': {
        const text =
          typeof b['reasoning'] === 'string'
            ? b['reasoning']
            : typeof b['text'] === 'string'
              ? b['text']
              : '';
        out.push(
          text.trim()
            ? thinkingEntry(turn, text, 'reasoning', secrets)
            : { kind: 'thinking', turn, visibility: 'omitted', source: 'reasoning' },
        );
        break;
      }
      case 'text': {
        const raw = typeof b['text'] === 'string' ? b['text'].trim() : '';
        if (!raw) break;
        const { text, truncated } = truncate(redact(raw, secrets), MAX_TEXT);
        out.push({ kind: 'text', turn, text, ...(truncated ? { truncated } : {}) });
        break;
      }
      case 'tool_use': {
        const market = marketOf(b['input']);
        out.push({
          kind: 'tool_call',
          turn,
          toolUseId: String(b['id'] ?? ''),
          tool: String(b['name'] ?? ''),
          ...(market ? { market } : {}),
          input: summariseInput(b['input'], secrets),
        });
        break;
      }
      default:
        break;
    }
  }
  const cost = costOf(message);
  out.push({
    kind: 'usage',
    turn,
    inputTokens: message.usage?.input_tokens ?? 0,
    outputTokens: message.usage?.output_tokens ?? 0,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    stopReason: message.stop_reason ?? null,
  });
  return out;
}

function thinkingEntry(
  turn: number,
  raw: string,
  source: 'thinking' | 'reasoning',
  secrets: readonly string[],
): TranscriptEntryBody {
  const { text, truncated } = truncate(redact(raw.trim(), secrets), MAX_THINKING);
  return {
    kind: 'thinking',
    turn,
    visibility: 'visible',
    source,
    text,
    ...(truncated ? { truncated } : {}),
  };
}

/** The instruction as the `start` entry shows it: redacted and short. */
export function startInstruction(instruction: string | undefined, secrets: readonly string[]) {
  const trimmed = instruction?.trim();
  return trimmed ? truncate(redact(trimmed, secrets), MAX_INSTRUCTION).text : undefined;
}
