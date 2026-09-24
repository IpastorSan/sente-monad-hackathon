/**
 * The Agent Ledger's data model (SEN-23).
 *
 * One pure function turns the API's event trail (SEN-20) into the entries the
 * Ledger renders. No React, no React Native, no fetch — `ledger.test.ts` runs
 * it under plain `node --test`, so the shape of an entry is pinned without a
 * device and without an API.
 *
 * Five kinds and only five. A `run` summary is not an entry: it is a header
 * over events that already say more. Anything the Ledger cannot show is
 * dropped rather than half-shown.
 *
 * `deposit` is the odd one and the reason SEN-50 exists: it is the only kind no
 * tool produces (the Alchemy Notify webhook appends it — SEN-30), and it was
 * dropped here for a while, so funding an agent reached the phone and rendered
 * as nothing. An event the API appends and serves but this file does not map is
 * invisible end to end, which is the failure mode to watch for when a kind is
 * added on the server.
 *
 * READ THIS BEFORE NARROWING `kind`: `LedgerEvent['kind']` is a plain string on
 * purpose. `verdict` is SEN-22's and is not in the API's `AGENT_EVENT_KINDS`
 * union on this HEAD, so typing the input as that union would make this file
 * stop compiling the day verdicts land.
 */
import { formatAtoms, formatFixedAtoms, groupThousands, normalizeDecimal } from './amounts.ts';
import { BALANCE_PLACES } from '../ui/format.ts';

/** The five things the Ledger shows. */
export type LedgerEntryKind = 'thesis' | 'trade' | 'refusal' | 'verdict' | 'deposit';

/** Which way the agent is positioned. */
export type Direction = 'long' | 'short';

/** Who refused. `sente` is our own pre-check (layer 1), `enclave` is Privy. */
export type RefusalLayer = 'sente' | 'enclave';

/** Epoch ms at which each Monad commit state was first observed, as the API keys them. */
export type CommitTimes = Partial<Record<'proposed' | 'voted' | 'finalized' | 'verified', number>>;

/**
 * Where Monad has taken the block a trade landed in, exactly as the event
 * carries it (SEN-21, SEN-35). The API attaches this to EVERY event that names a
 * block — it gates on the data, not on a list of kinds — so the ramp is seeded
 * from the row it is drawn under rather than from a request per row, and a new
 * block-bearing kind gets the ramp with no server change. A `deposit` is exactly
 * that case: it carries `blockNumber`, so it arrives with `consensus` already
 * attached (SEN-50 verified it against `agents.controller.ts`'s `withConsensus`).
 */
export type EventConsensus = {
  /** `Proposed` | `Voted` | `Finalized` | `Verified`, or `unknown` past the API's window. */
  readonly state: string;
  /** Empty when `state` is `unknown`. */
  readonly at: CommitTimes;
};

/** The states Monad's commit process ends at. Both mean "the block is final". */
export const FINAL_CONSENSUS_STATES: readonly string[] = ['Finalized', 'Verified'];

/**
 * Whether this row still has anything to ask the API about its block.
 *
 * This is what makes the Ledger cheap (SEN-35): a row whose event already says
 * `Finalized`, or that the block is past the API's window, is settled the
 * moment it arrives, so a screenful of finished trades issues NO consensus
 * requests at all. Only a block that can still move is polled — and an event
 * with no `consensus` at all means an API older than SEN-21, where the ramp has
 * no choice but to ask.
 */
export function consensusNeedsPolling(consensus: EventConsensus | null | undefined): boolean {
  if (!consensus) return true;
  if (consensus.state === 'unknown' || consensus.state === 'reorged') return false;
  return !FINAL_CONSENSUS_STATES.includes(consensus.state);
}

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
  /** Absent on an event with no block, and on an API that predates SEN-21. */
  readonly consensus?: EventConsensus;
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
  /** The block's consensus state as the event reported it. What seeds the ramp. */
  consensus: EventConsensus | null;
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
  /**
   * A `close` lands in a block like any other trade, so it gets the ramp too
   * (SEN-35 — it did not before). SEN-22's own `verdict` is a judgement rather
   * than a transaction and carries neither of these.
   */
  blockNumber: number | null;
  consensus: EventConsensus | null;
};

/**
 * Funds ARRIVING at the agent's wallet (SEN-30) — the one row nothing the agent
 * did produced, so it names the sender rather than a venue and carries no
 * `runId` and no tool. Its `detail` is the API's `AgentDepositDetail`.
 *
 * Two amounts, on purpose. `amount` is Alchemy's already-scaled figure, which
 * is a float it stringified; `rawAmount` (with `decimals`) is the exact integer
 * from the log. `depositAmount` prefers the exact pair and falls back to the
 * float, so the row never rounds a quantity it could have read exactly.
 */
export type DepositEntry = Base & {
  kind: 'deposit';
  /** The token symbol, or `null` when the delivery named none. Never invented. */
  asset: string | null;
  /** Alchemy's scaled figure, exactly as the event carried it. */
  amount: string;
  /** The exact integer from the log — hex or decimal — when the delivery had one. */
  rawAmount: string | null;
  /** The token's precision. `rawAmount` means nothing without it. */
  decimals: number | null;
  /** Who funded the agent. */
  from: string | null;
  txHash: string | null;
  /** A transfer lands in a block like a trade does, so the row gets the ramp. */
  blockNumber: number | null;
  consensus: EventConsensus | null;
};

export type LedgerEntry = ThesisEntry | TradeEntry | RefusalEntry | VerdictEntry | DepositEntry;

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
    // Funds arriving, from the Alchemy webhook rather than from a tool (SEN-30).
    case 'deposit':
      return depositEntry(event);
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
      text(detail, 'averageFillPrice') ?? text(asked, 'price') ?? text(asked, 'slippageLimitPrice'),
    leverage: numberAt(detail, 'leverage') ?? numberAt(asked, 'leverage'),
    txHash: text(detail, 'txHash'),
    blockNumber: numberAt(detail, 'blockNumber'),
    consensus: event.consensus ?? null,
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
    blockNumber: numberAt(detail, 'blockNumber'),
    consensus: event.consensus ?? null,
  };
}

/**
 * What the API writes when Alchemy named no asset
 * (`UNKNOWN_ASSET` in `services/api/src/webhooks/alchemy.ts`). It is a
 * placeholder, not a symbol, so it becomes `null` here and the row shows the
 * figure alone rather than "250.00 unknown".
 */
const UNKNOWN_ASSET = 'unknown';

function depositEntry(event: LedgerEvent): DepositEntry {
  const detail = event.detail;
  const asset = text(detail, 'asset');
  return {
    kind: 'deposit',
    seq: event.seq,
    at: event.at,
    ...runOf(event),
    asset: asset === UNKNOWN_ASSET ? null : asset,
    amount: text(detail, 'amount') ?? '',
    rawAmount: text(detail, 'rawAmount'),
    decimals: numberAt(detail, 'decimals'),
    from: text(detail, 'from'),
    txHash: text(detail, 'txHash'),
    blockNumber: numberAt(detail, 'blockNumber'),
    consensus: event.consensus ?? null,
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
 * A deposit as a figure: `+250.00`, `+1,204.5`, and a real `+` because funds
 * arriving is the whole point of the row.
 *
 * The precision policy is `BALANCE_PLACES` — the same one every balance in the
 * app shows (`ui/format.ts`), because a deposit is money in that same wallet and
 * two screens quoting it at different precisions reads as a bug in the number.
 *
 * Read from `rawAmount` + `decimals` when the delivery carried them, so the
 * exact integer from the log decides the figure and Alchemy's float is never
 * trusted to reconstruct it.
 */
export function depositAmount(entry: DepositEntry): string {
  const exact = exactAtoms(entry);
  if (exact !== null) {
    const { atoms, decimals } = exact;
    const places = (entry.asset !== null ? BALANCE_PLACES[entry.asset] : undefined) ?? 2;
    const fixed = formatFixedAtoms(atoms, decimals, { places });
    // `formatFixedAtoms` truncates, which is right for a balance and wrong for
    // an arrival: `+0.00` for a deposit that did happen says nothing happened.
    // A figure that truncates away is shown at the token's own precision.
    const dust = atoms > 0n && /^0(\.0*)?$/.test(fixed);
    return `+${dust ? formatAtoms(atoms, decimals) : fixed}`;
  }
  // No exact integer in the delivery: Alchemy's own scaled figure. Grouped when
  // it reads as a plain decimal, handed back untouched when it does not — an
  // exponential float (`1e-7`) or a field that was never a number is shown as it
  // came rather than rewritten into something the chain did not say.
  const normal = normalizeDecimal(entry.amount);
  if (normal === null) return entry.amount === '' ? '—' : entry.amount;
  const [whole = '0', fraction = ''] = normal.split('.');
  return `+${groupThousands(whole)}${fraction ? `.${fraction}` : ''}`;
}

/** `rawAmount` (hex or decimal) read as atoms, or `null` when it cannot be. */
function exactAtoms(entry: DepositEntry): { atoms: bigint; decimals: number } | null {
  const { rawAmount, decimals } = entry;
  if (rawAmount === null || decimals === null) return null;
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return null;
  let atoms: bigint;
  try {
    // `BigInt` takes `0x…` and a decimal string and throws on anything else,
    // which is exactly the acceptance this needs.
    atoms = BigInt(rawAmount);
  } catch {
    return null;
  }
  return atoms < 0n ? null : { atoms, decimals };
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
      // Funding comes first because it has to: an agent trades what it was
      // given. Its consensus is already `Finalized` and minutes old, so the
      // sample's ramp draws as a settled record and asks the API for nothing —
      // a made-up block height is not worth a request burst.
      kind: 'deposit',
      seq: 1,
      at: at(18),
      asset: 'USDC',
      amount: '500',
      rawAmount: '500000000',
      decimals: 6,
      from: '0x8f1d7a30586c2e4f9b1d7a30586c2e4f9b1d7a30',
      txHash: '0x9c1e7b3d5086a2f4e9c1b7d3058a6c2e4f9b1d7a30586c2e4f9b1d7a30584f2a',
      blockNumber: 12_345_601,
      consensus: {
        state: 'Finalized',
        at: { proposed: at(18), voted: at(18) + 216, finalized: at(18) + 498 },
      },
    },
    {
      kind: 'thesis',
      seq: 2,
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
      seq: 3,
      at: at(13),
      venue: 'kuru',
      market: 'MON-USDC',
      direction: 'long',
      size: '260.00',
      price: '0.9812',
      leverage: null,
      txHash: '0x4f2a9c1e7b3d5086a2f4e9c1b7d3058a6c2e4f9b1d7a30586c2e4f9b1d7a3058',
      blockNumber: 12_345_678,
      consensus: null,
      filled: true,
      status: 'filled',
    },
    {
      kind: 'refusal',
      seq: 4,
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
      seq: 5,
      at: at(6),
      market: 'BTC-PERP',
      direction: 'short',
      thesis: 'Funding has been positive for nine hours and the basis is stretched. Fading it.',
      invalidation: 'Two consecutive hourly closes above the range high.',
    },
    {
      kind: 'verdict',
      seq: 6,
      at: at(1),
      pnl: '12.4',
      held: true,
      market: 'MON-USDC',
      blockNumber: null,
      consensus: null,
    },
  ];
}
