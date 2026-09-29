/**
 * Which of an agent's Kuru orders may still fill, read off its own event log
 * (SEN-149), and the `fill` event a later fill of one becomes.
 *
 * The gate records the fills an order gets AT PLACEMENT. A GTC limit that
 * rests and fills minutes later never passes through the gate again, so
 * before SEN-149 it produced no `fill`: the FIFO cost basis stayed partial, a
 * thesis closed by a resting sell never got its verdict, and trade counts came
 * up short. `resting-fill.watcher.ts` closes that gap; this file is its pure
 * half, so the rules below are pinned without a chain.
 *
 * An order is watched from the `order` event that rested it (`place_limit`
 * whose result is `open` or `partially_filled` with a `"<slot>:<id>"` id)
 * until its fills account for its whole size, a later fill reports nothing
 * left on the book, or it was cancelled and the watcher has read the chain up
 * to the cancel (a fill can land between the last read and the cancel).
 *
 * Pure. Money stays in decimal strings; sizes are compared exactly.
 */
import type { MakerFill } from '@sente/venues/kuru';

import type { AgentEvent, NewAgentEvent } from '../events/agent-event-log';
import { addScaled, decimalOf, subScaled, type Scaled } from '../events/verdict';

/** `detail.source` on a fill the watcher recorded, as opposed to one at placement. */
export const RESTING_FILL_SOURCE = 'resting';

const RESTING_ID = /^\d{1,3}:\d{1,20}$/;
const RESTING_STATUSES = new Set(['open', 'partially_filled']);

export interface RestingOrder {
  readonly agentId: string;
  readonly symbol: string;
  /** Sente's resting-order id, `"<slotIdx>:<orderId>"`. */
  readonly orderId: string;
  /** The tool that placed it, stamped on its later fills. */
  readonly tool: string;
  /**
   * Where a scan for its fills has to start: the block of the last later fill
   * already recorded (inclusive, so a second fill in that block is not
   * skipped), else the placement's block. `undefined` when the placement did
   * not report one.
   */
  readonly fromBlock: bigint | undefined;
  /** Epoch ms of a cancel that landed, if one did. */
  readonly cancelledAt: number | undefined;
}

export interface RestingState {
  /** Orders that may still fill, oldest placement first. */
  readonly open: RestingOrder[];
  /** Dedupe keys of every later fill already on the log. */
  readonly recorded: ReadonlySet<string>;
}

interface Tracked {
  order: RestingOrder;
  size: Scaled;
  filled: Scaled;
  done: boolean;
}

/** The orders of one agent's log that may still fill. */
export function restingKuruOrders(events: readonly AgentEvent[]): RestingState {
  const tracked = new Map<string, Tracked>();
  const recorded = new Set<string>();

  for (const event of events) {
    const detail = event.detail;
    if (event.kind === 'fill') {
      const key = detail['tradeKey'];
      if (typeof key === 'string') recorded.add(key);
      if (detail['venue'] !== 'kuru') continue;
      const entry = tracked.get(keyOf(detail['symbol'], detail['orderId']));
      const size = decimalOf(detail['filledSize']);
      if (!entry || !size) continue;
      entry.filled = addScaled(entry.filled, size);
      if (detail['remainingSize'] === '0') entry.done = true;
      const block = detail['blockNumber'];
      if (detail['source'] === RESTING_FILL_SOURCE && typeof block === 'number') {
        entry.order = { ...entry.order, fromBlock: BigInt(block) };
      }
      continue;
    }
    if (event.kind !== 'order' || detail['status'] !== 'ok') continue;
    const args = record(detail['args']);
    const result = record(detail['result']);
    if (args?.['venue'] !== 'kuru' || !result) continue;

    if (event.tool === 'cancel_order') {
      const entry = tracked.get(keyOf(args['market'], args['orderId']));
      if (entry) entry.order = { ...entry.order, cancelledAt: event.at };
      continue;
    }
    const id = result['id'];
    const symbol = result['symbol'];
    const size = decimalOf(result['size']);
    if (
      typeof id !== 'string' ||
      !RESTING_ID.test(id) ||
      typeof symbol !== 'string' ||
      !RESTING_STATUSES.has(String(result['status'])) ||
      !size
    ) {
      continue;
    }
    const block = result['blockNumber'];
    tracked.set(keyOf(symbol, id), {
      order: {
        agentId: event.agentId,
        symbol,
        orderId: id,
        tool: event.tool ?? 'place_limit',
        fromBlock: typeof block === 'number' ? BigInt(block) : undefined,
        cancelledAt: undefined,
      },
      size,
      // The placement's own fill is on the log as a `fill` naming this id,
      // right after this event, and is counted there — not here, twice.
      filled: { units: 0n, scale: 0 },
      done: false,
    });
  }

  const open = [...tracked.values()]
    .filter((entry) => !entry.done && subScaled(entry.size, entry.filled).units > 0n)
    .map((entry) => entry.order);
  return { open, recorded };
}

/**
 * The dedupe key of one later fill: where the chain reported it. A log is
 * identified by its transaction and index, and one taker sweep reports every
 * maker it hit as a record of ONE log, so the record index is part of it.
 * Stable across re-polls and restarts, which is what makes recording
 * idempotent.
 */
export function tradeKeyOf(fill: MakerFill): string {
  return `kuru:${fill.transactionHash.toLowerCase()}:${fill.logIndex}:${fill.recordIndex}`;
}

/**
 * The `fill` event for a later fill of `order`, in the shape the gate's
 * `fillOf` writes (so the cost basis, verdicts and the Ledger read it with no
 * change), plus what only a later fill has: `source`, the dedupe `tradeKey`,
 * the venue's `tradeId` and what is still resting.
 *
 * No `runId`: no run caused it. `tool` is the one that placed the order.
 */
export function laterFillEvent(order: RestingOrder, fill: MakerFill): NewAgentEvent {
  return {
    agentId: order.agentId,
    kind: 'fill',
    tool: order.tool,
    detail: {
      orderId: order.orderId,
      venue: 'kuru',
      symbol: fill.symbol,
      side: fill.side,
      type: 'limit',
      status: fill.remainingSize === '0' ? 'filled' : 'partially_filled',
      filledSize: fill.size,
      // A maker fills at its own resting price, so each fill has one price.
      averageFillPrice: fill.price,
      txHash: fill.transactionHash,
      blockNumber: Number(fill.blockNumber),
      fee: fill.fee,
      feeAsset: fill.feeAsset,
      remainingSize: fill.remainingSize,
      source: RESTING_FILL_SOURCE,
      tradeKey: tradeKeyOf(fill),
      tradeId: fill.tradeId.toString(),
    },
  };
}

function keyOf(symbol: unknown, orderId: unknown): string {
  return `${String(symbol)}|${String(orderId)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
