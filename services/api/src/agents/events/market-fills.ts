/**
 * One market's fills across the caller's agents (SEN-157), for the purple
 * stones on the asset chart and the "Fills on MON" list under it. A pure
 * function of the event logs, like `summary.ts`: nothing is stored, so it can
 * never disagree with `GET /agents/:id/events`.
 *
 * Reads the `fill` event `tools/gate.ts#fillOf` writes: `symbol`, `side`,
 * `filledSize`, `averageFillPrice`, `orderId`, `txHash`, and `venue` when the
 * tool's intent named one.
 */
import type { AgentEvent } from './agent-event-log';

export type FillVenue = 'kuru' | 'perpl';

export interface MarketFillsQuery {
  readonly venue?: FillVenue;
  readonly symbol?: string;
  /** Unix ms; only fills at or after it. */
  readonly since?: number;
  readonly limit: number;
}

export interface AgentFillDto {
  /** Stable across the whole log: a list key, and the tiebreak for equal `at`s. */
  seq: number;
  agentId: string;
  agentName: string;
  venue: FillVenue;
  symbol: string;
  side: 'buy' | 'sell' | null;
  /** Decimal strings, as the venue reported them. `price` is the order's average. */
  price: string | null;
  size: string;
  orderId: string | null;
  txHash: string | null;
  /** Unix ms, when the fill was recorded. */
  at: number;
}

export interface AgentLog {
  readonly agent: { readonly id: string; readonly name: string };
  /** Oldest first, as the log lists them; any kinds — non-fills are skipped. */
  readonly events: readonly AgentEvent[];
}

/** Newest first, at most `limit`, across every log given. */
export function marketFills(logs: readonly AgentLog[], query: MarketFillsQuery): AgentFillDto[] {
  const fills: AgentFillDto[] = [];
  for (const { agent, events } of logs) {
    for (const event of events) {
      if (event.kind !== 'fill') continue;
      if (query.since !== undefined && event.at < query.since) continue;
      const fill = toFill(event, agent.name);
      if (fill === undefined) continue;
      if (query.venue !== undefined && fill.venue !== query.venue) continue;
      if (query.symbol !== undefined && fill.symbol !== query.symbol) continue;
      fills.push(fill);
    }
  }
  return fills.sort((a, b) => b.at - a.at || b.seq - a.seq).slice(0, Math.max(0, query.limit));
}

function toFill(event: AgentEvent, agentName: string): AgentFillDto | undefined {
  const d = event.detail;
  const symbol = stringOf(d['symbol']);
  const size = stringOf(d['filledSize']);
  // A fill that names no market cannot be placed on any chart.
  if (symbol === undefined || size === undefined) return undefined;
  const side = d['side'];
  return {
    seq: event.seq,
    agentId: event.agentId,
    agentName,
    venue: venueOf(event),
    symbol,
    side: side === 'buy' || side === 'sell' ? side : null,
    price: stringOf(d['averageFillPrice']) ?? null,
    size,
    orderId: stringOf(d['orderId']) ?? null,
    txHash: stringOf(d['txHash']) ?? null,
    at: event.at,
  };
}

/**
 * The same rule `verdict.ts#venueOf` settles by: the declared venue, else a
 * leverage means Perpl (only Perpl orders carry one), else Kuru — so a fill
 * from before `venue` was recorded is not dropped from a venue-scoped read.
 */
function venueOf(event: AgentEvent): FillVenue {
  const declared = event.detail['venue'];
  if (declared === 'kuru' || declared === 'perpl') return declared;
  return typeof event.detail['leverage'] === 'number' ? 'perpl' : 'kuru';
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
