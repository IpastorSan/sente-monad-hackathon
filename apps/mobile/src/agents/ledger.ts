/**
 * The Agent Ledger's data model (SEN-23).
 *
 * One pure function turns the API's event trail (SEN-20) into the entries the
 * Ledger renders. No React, no React Native, no fetch — `ledger.test.ts` runs
 * it under plain `node --test`, so the shape of an entry is pinned without a
 * device and without an API.
 *
 * Four kinds and only four. A `run` summary is not an entry: it is a header
 * over events that already say more. Anything the Ledger cannot show is
 * dropped rather than half-shown.
 *
 * READ THIS BEFORE NARROWING `kind`: `LedgerEvent['kind']` is a plain string on
 * purpose. `verdict` is SEN-22's and is not in the API's `AGENT_EVENT_KINDS`
 * union on this HEAD, so typing the input as that union would make this file
 * stop compiling the day verdicts land.
 */
import { groupThousands } from './amounts.ts';

/** The four things the Ledger shows. */
export type LedgerEntryKind = 'thesis' | 'trade' | 'refusal' | 'verdict';

/** Which way the agent is positioned. */
export type Direction = 'long' | 'short';

/** Who refused. `sente` is our own pre-check (layer 1), `enclave` is Privy. */
export type RefusalLayer = 'sente' | 'enclave';

/**
 * An event as `GET /agents/:id/events` returns it (SEN-20). Structurally a
 * `WireAgentEvent`, restated here so this module owns its own input contract
 * and stays free of the API client.
 */
export type LedgerEvent = {
  readonly seq: number;
  readonly at: number;
  readonly kind: string;
  readonly layer?: string;
  readonly tool?: string;
  readonly runId?: string;
  readonly detail: Readonly<Record<string, unknown>>;
};

type Base = {
  /** The event's `seq`: stable across polls, so it is the list key. */
  seq: number;
  /** Unix epoch milliseconds, exactly as the API reported it. */
  at: number;
  /** The run that produced it, when the event had one. */
  runId?: string;
};

/** The agent's own words, written before execution. The Ledger's first fact. */
export type ThesisEntry = Base & {
  kind: 'thesis';
  market: string;
  direction: Direction | null;
  thesis: string;
  /** What would prove it wrong. Empty when the agent did not say. */
  invalidation: string;
};

/**
 * One order, as a single dense line. `filled: false` means the order never
 * landed — the row says so rather than vanishing, because an agent whose
 * orders silently disappear is not an agent you can audit.
 */
export type TradeEntry = Base & {
  kind: 'trade';
  venue: string | null;
  market: string;
  direction: Direction | null;
  /** The venue's own decimal string. Never re-rounded or re-formatted here. */
  size: string;
  price: string | null;
  leverage: number | null;
  /** Chain facts: the screen sets these in mono. */
  txHash: string | null;
  blockNumber: number | null;
  filled: boolean;
  status: string | null;
};

/**
 * The layer that refused, and its code. An enclave refusal is the product
 * working, so it is rendered as a positive event, never as an error.
 */
export type RefusalEntry = Base & {
  kind: 'refusal';
  layer: RefusalLayer;
  code: string;
  message: string;
  tool: string | null;
};

/** A close, or SEN-22's verdict: what the position actually did. */
export type VerdictEntry = Base & {
  kind: 'verdict';
  /** Realised PnL as a decimal string, or null when nothing reported one. */
  pnl: string | null;
  /** `null` when the event did not say — a venue close, or a quiet venue. */
  held: boolean | null;
  market: string | null;
};

export type LedgerEntry = ThesisEntry | TradeEntry | RefusalEntry | VerdictEntry;

/**
 * The event trail -> the Ledger, oldest first.
 *
 * Sorted by `seq` rather than trusting page order, so appending a page after a
 * poll cannot interleave the list.
 */
export function toLedgerEntries(events: readonly LedgerEvent[]): LedgerEntry[] {
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .map(toLedgerEntry)
    .filter((entry): entry is LedgerEntry => entry !== null);
}

/** `null` for an event the Ledger does not show. */
function toLedgerEntry(event: LedgerEvent): LedgerEntry | null {
  switch (event.kind) {
    case 'thesis':
      return thesisEntry(event);
    case 'fill':
      return tradeEntry(event);
    // An order that filled already emitted its own `fill`; only the ones that
    // did not land become rows, and they are marked as such.
    case 'order':
      return text(event.detail, 'status') === 'failed' ? tradeEntry(event) : null;
    // A close carries the venue's realised PnL but cannot say whether the
    // thesis held — that is SEN-22's verdict, and it is a separate event.
    case 'close':
    case 'verdict':
      return verdictEntry(event);
    case 'refusal':
      return refusalEntry(event);
    default:
      // `run` is a summary, and the Ledger shows what happened, not that the
      // runner woke up.
      return null;
  }
}

function thesisEntry(event: LedgerEvent): ThesisEntry {
  return {
    kind: 'thesis',
    seq: event.seq,
    at: event.at,
    ...runOf(event),
    market: text(event.detail, 'market') ?? '—',
    direction: directionOf(text(event.detail, 'direction')),
    thesis: text(event.detail, 'thesis') ?? '',
    invalidation: text(event.detail, 'invalidation') ?? '',
  };
}

function tradeEntry(event: LedgerEvent): TradeEntry {
  const detail = event.detail;
  // A `fill` describes what landed. A failed `order` describes what was asked
  // for, which is all there is when nothing filled.
  const failed = event.kind === 'order';
  const asked = failed ? asRecord(detail['args']) : {};
  return {
    kind: 'trade',
    seq: event.seq,
    at: event.at,
    ...runOf(event),
    venue: text(detail, 'venue') ?? text(asked, 'venue'),
    market: text(detail, 'symbol') ?? text(asked, 'market') ?? '—',
    direction: directionOf(text(detail, 'side') ?? text(asked, 'side')),
    size: text(detail, 'filledSize') ?? text(asked, 'size') ?? '—',
    price:
      text(detail, 'averageFillPrice') ??
      text(asked, 'price') ??
      text(asked, 'slippageLimitPrice'),
    leverage: numberAt(detail, 'leverage') ?? numberAt(asked, 'leverage'),
    txHash: text(detail, 'txHash'),
    blockNumber: numberAt(detail, 'blockNumber'),
    filled: !failed,
    status: text(detail, 'status'),
  };
}

function refusalEntry(event: LedgerEvent): RefusalEntry {
  return {
    kind: 'refusal',
    seq: event.seq,
    at: event.at,
    ...runOf(event),
    // The log only ever sets `layer` on a refusal, and only to one of the two.
    // Falling back to `sente` keeps a malformed event honest rather than
    // crediting the enclave with a refusal it did not make.
    layer: event.layer === 'enclave' ? 'enclave' : 'sente',
    code: text(event.detail, 'code') ?? 'refused',
    message: text(event.detail, 'message') ?? '',
    tool: event.tool ?? null,
  };
}

function verdictEntry(event: LedgerEvent): VerdictEntry {
  const detail = event.detail;
  return {
    kind: 'verdict',
    seq: event.seq,
    at: event.at,
    ...runOf(event),
    // `pnl` is the verdict's own field and `realizedPnl` is what a venue close
    // carries; either one is the same number to the user.
    pnl: text(detail, 'pnl') ?? text(detail, 'realizedPnl'),
    held: booleanAt(detail, 'held') ?? booleanAt(detail, 'thesisHeld'),
    market: text(detail, 'symbol') ?? text(detail, 'market'),
  };
}

function runOf(event: LedgerEvent): { runId?: string } {
  return event.runId !== undefined ? { runId: event.runId } : {};
}

/**
 * A venue `side` read as a position: a buy opens a long, a sell a short. This
 * is the only honest source on a fill — the fill record does not carry the
 * thesis' direction — and `null` when the venue did not say.
 */
function directionOf(side: string | null): Direction | null {
  if (side === 'buy' || side === 'long') return 'long';
  if (side === 'sell' || side === 'short') return 'short';
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function text(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A number the venue may have sent as a JS number or as a decimal string. */
function numberAt(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanAt(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === 'boolean' ? value : null;
}

// ---------------------------------------------------------------------------
// Display. Pure, so the screen holds no formatting logic worth testing.

/** `at` as `HH:MM:SS` in UTC — the same string on every device, like `isoDate`. */
export function clockTime(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

export function directionLabel(direction: Direction | null): string {
  if (direction === 'long') return 'LONG';
  if (direction === 'short') return 'SHORT';
  return '—';
}

/** `kuru` -> `Kuru`. */
export function venueLabel(venue: string | null): string {
  if (venue === null || venue === '') return '—';
  return venue.charAt(0).toUpperCase() + venue.slice(1);
}

export function refusalLayerLabel(layer: RefusalLayer): string {
  return layer === 'enclave' ? 'Enclave' : 'Sente';
}

/** `0x4f2a9c…3058`. Chain facts only — nothing else in the Ledger is mono. */
export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

/**
 * `+12.4` / `−12.4`, with a real minus sign. Grouped by hand, not through
 * `Intl`: Hermes ships a partial `Intl` and this must read the same everywhere.
 */
export function signedPnl(pnl: string | null): string {
  if (pnl === null || pnl === '') return '—';
  const value = Number(pnl);
  if (!Number.isFinite(value)) return pnl;
  // Keep the venue's precision, up to six decimals, without float noise from
  // the multiply. Past 1e21 `String` goes exponential, so hand that back as-is.
  const rounded = Math.round(Math.abs(value) * 1e6) / 1e6;
  const plain = String(rounded);
  if (plain.includes('e') || plain.includes('E')) return pnl;
  const [whole = '0', fraction = ''] = plain.split('.');
  return `${value < 0 ? '−' : '+'}${groupThousands(whole)}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Whether the thesis held. A mere close cannot say — the venue reports the
 * number, not the judgement — so "not recorded" is a real answer here.
 */
export function heldLabel(held: boolean | null): string {
  if (held === true) return 'Thesis held';
  if (held === false) return 'Thesis did not hold';
  return 'Thesis not recorded';
}

/** The consensus ramp's labels (SEN-24). Monad's own block-state vocabulary. */
export const CONSENSUS_STOPS = ['PROPOSED', 'VOTED', 'FINALIZED'] as const;

/**
 * A short ledger for an agent that has not run, so the screen opens on content
 * rather than on an empty page — the plan's "land on content, not a zero
 * state". The screen labels it a sample, because it is not this agent's
 * history and must never read as one.
 */
export function demoLedger(now: number = Date.now()): LedgerEntry[] {
  const at = (minutesAgo: number) => now - minutesAgo * 60_000;
  return [
    {
      kind: 'thesis',
      seq: 1,
      at: at(14),
      market: 'MON-USDC',
      direction: 'long',
      thesis:
        'MON has held 0.9680 three times this session and spot is bid while the perp sits flat. ' +
        'Buying the range low with a stop under it is the cheap side of that trade.',
      invalidation:
        'A 15m close below 0.9680. I cut there and take no new long until it reclaims the level.',
    },
    {
      kind: 'trade',
      seq: 2,
      at: at(13),
      venue: 'kuru',
      market: 'MON-USDC',
      direction: 'long',
      size: '260.00',
      price: '0.9812',
      leverage: null,
      txHash: '0x4f2a9c1e7b3d5086a2f4e9c1b7d3058a6c2e4f9b1d7a30586c2e4f9b1d7a3058',
      blockNumber: 12_345_678,
      filled: true,
      status: 'filled',
    },
    {
      kind: 'refusal',
      seq: 3,
      at: at(9),
      layer: 'enclave',
      code: 'policy_violation',
      tool: 'place_market',
      message:
        'The order was refused before it was signed: 480.00 exceeds this mandate’s maximum ' +
        'order notional.',
    },
    {
      kind: 'thesis',
      seq: 4,
      at: at(6),
      market: 'BTC-PERP',
      direction: 'short',
      thesis: 'Funding has been positive for nine hours and the basis is stretched. Fading it.',
      invalidation: 'Two consecutive hourly closes above the range high.',
    },
    {
      kind: 'verdict',
      seq: 5,
      at: at(1),
      pnl: '12.4',
      held: true,
      market: 'MON-USDC',
    },
  ];
}
