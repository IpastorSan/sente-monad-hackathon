/**
 * Manual trades from the user's own wallet, held between prepare, commit and
 * the last receipt (SEN-88, plan M-T6).
 *
 * A trade is a short list of device-signed enclave requests — approve, deposit,
 * place — composed at prepare and sent verbatim at commit, for the same reason
 * `agents/prepared-approval.ts` stores its request instead of rebuilding it: the
 * signature covers the request byte for byte. What differs from that store is
 * the lifetime. A prepared approval is consumed by its commit; a trade outlives
 * it, because the phone polls its steps and the portfolio lists it afterwards.
 * So entries are never taken, only CLAIMED: `claimForCommit` moves a trade from
 * `prepared` to `executing` exactly once, and every later commit sees
 * `'committed'` and resends nothing.
 *
 * Idempotency (plan "Server API"): a trade is also found by the phone's
 * `clientTradeId`, and `intentHash` is what decides whether a retry is the same
 * trade or a conflicting one. `put` re-checks that itself, because planning is
 * asynchronous — two prepares with one id can both miss `byClientId` and race to
 * store, and exactly one of them may win.
 *
 * PERSISTENCE: in memory, per process (the repo standard). A restart loses
 * unsent signatures and in-flight step statuses, never a balance — the portfolio
 * re-reads chain and venue state.
 *
 * Erasable syntax only and `.ts` specifiers (CLAUDE.md gotcha 10), like the
 * prepared-approval store it follows, so a live probe can load it under node's
 * type stripping. No Nest import; the trade module constructs it.
 */

import type { AuthorizationPayload } from '@sente/mandate';
import type { KuruMarketParams } from '@sente/venues/kuru';
import type { Address, Hex } from 'viem';

import type { EnclaveRequest } from '../agents/agent-wallet.provider.ts';

/** `TradeIntent['kind']` from the plan's shared wire types. */
export type TradeKind = 'kuru.place' | 'kuru.cancel' | 'kuru.withdraw' | 'perpl.onboard';

export type StepKind =
  | 'approve'
  | 'deposit'
  | 'approveBuilder'
  | 'place'
  | 'cancel'
  | 'withdraw'
  | 'perpl.approve'
  | 'perpl.createAccount'
  | 'perpl.allowForwarding'
  | 'batch';

export type StepStatus =
  'awaiting_signature' | 'queued' | 'submitted' | 'included' | 'reverted' | 'not_sent' | 'unknown';

/**
 * `expired` is never stored: it is how a `prepared` trade past `expiresAt`
 * reads (see {@link withExpiry}), so no timer has to flip it.
 */
export type TradeStatus = 'prepared' | 'executing' | 'completed' | 'failed' | 'expired';

export type KuruPlaceResult = {
  status: 'filled' | 'partially_filled' | 'resting' | 'cancelled' | 'rejected';
  orderId?: string;
  requestedSize: string;
  filledSize: string;
  avgPrice?: string;
  fee: string;
  feeAsset: 'USDC';
  fills: { price: string; size: string; tradeId: string }[];
  unfilledCancelled?: string;
  /**
   * Sente's builder fee these fills paid (SEN-184), read from AccountCore's
   * `BuilderFeeAccrued`, in `feeAsset`. Present only when the order carried a
   * builder fee; `"0"` when it took nothing.
   */
  senteFee?: string;
};

/**
 * What decoding a place's receipt needs and the trade would otherwise not
 * know (SEN-97): the planner's view of the order and its funding, kept from
 * prepare. Server-side only — `toView` never sends it.
 */
export type KuruPlaceContext = {
  readonly market: Address;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly orderType: 'market' | 'limit';
  readonly timeInForce: 'GTC' | 'IOC' | 'POST_ONLY';
  /** Requested size, in book size units. */
  readonly quantity: bigint;
  /** Limit price or the market order's worst price, as the planner rendered it. */
  readonly price: string;
  readonly params: KuruMarketParams;
  readonly quoteDecimals: number;
  /** The token the order is funded in and how much of it this trade deposits (atoms; may be 0). */
  readonly funding: {
    readonly symbol: string;
    readonly decimals: number;
    readonly deposit: bigint;
  };
  /** The builder the order pays (SEN-184), when it pays one. */
  readonly builder?: { readonly address: Address; readonly feePps: number };
};

export type TradeFunds = { where: 'wallet' | 'kuru' | 'perpl'; symbol: string; amount: string }[];

export type TradeStep = {
  readonly index: number;
  readonly kind: StepKind;
  readonly title: string;
  /** Sent verbatim at commit. Never leaves the server. */
  readonly request: EnclaveRequest;
  /** Exactly what the device key signs. The phone rebuilds it and compares. */
  readonly payload: AuthorizationPayload;
  readonly status: StepStatus;
  readonly userOpHash?: Hex;
  readonly transactionHash?: Hex;
  readonly blockNumber?: string;
  readonly error?: string;
};

export type Trade = {
  readonly id: string;
  /** The session subject that prepared it. Another user's id is not found. */
  readonly userId: string;
  readonly clientTradeId: string;
  /** Hash of the canonical intent: same id + same hash is a retry, else a conflict. */
  readonly intentHash: string;
  readonly kind: TradeKind;
  readonly walletId: string;
  readonly address: Address;
  readonly steps: readonly TradeStep[];
  readonly status: TradeStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Commit deadline. Meaningless once the trade is claimed. */
  readonly expiresAt: Date;
  readonly result?: KuruPlaceResult;
  readonly funds?: TradeFunds;
  /** Set for a `kuru.place` trade; what M-T15 decodes the receipt against. */
  readonly place?: KuruPlaceContext;
};

/** What the executor may change once a trade is claimed. */
export type TradePatch = Partial<Pick<Trade, 'status' | 'steps' | 'result' | 'funds'>>;

/**
 * How long a trade is kept after it stops changing — after its last update, or
 * after `expiresAt` for one never committed.
 *
 * 24 hours because that is how long Privy deduplicates a repeated
 * `privy-idempotency-key` (`agents/privy/privy.client.ts`). Inside that window a
 * retried `clientTradeId` must still find its trade and get 409 or the same
 * trade back; forgetting it sooner would let a retry prepare fresh requests
 * under keys Privy would silently drop.
 */
export const TRADE_RETENTION_MS = 24 * 60 * 60 * 1000;

export class TradeStore {
  readonly #byId = new Map<string, Trade>();
  /** `userId:clientTradeId` -> trade id. */
  readonly #byClientId = new Map<string, string>();

  /**
   * Stores a newly prepared trade, unless its `clientTradeId` is taken.
   *
   * Returns the trade now held under that client id: `trade` itself, the
   * earlier one when the intent hashes match (a racing retry — the caller must
   * answer with what is stored, whose payloads may already be on the phone), or
   * `'conflict'` for a different intent. An earlier trade that expired without
   * a commit sent nothing, so it is replaced rather than blocking the id.
   */
  put(trade: Trade, now: Date = trade.createdAt): Trade | 'conflict' {
    this.sweep(now);
    const key = clientKey(trade.userId, trade.clientTradeId);
    const existingId = this.#byClientId.get(key);
    const existing = existingId === undefined ? undefined : this.#byId.get(existingId);
    if (existing && withExpiry(existing, now).status !== 'expired') {
      return existing.intentHash === trade.intentHash ? withExpiry(existing, now) : 'conflict';
    }
    if (existing) this.#byId.delete(existing.id);
    this.#byId.set(trade.id, trade);
    this.#byClientId.set(key, trade.id);
    return trade;
  }

  byClientId(userId: string, clientTradeId: string, now: Date = new Date()): Trade | undefined {
    const id = this.#byClientId.get(clientKey(userId, clientTradeId));
    return id === undefined ? undefined : this.get(userId, id, now);
  }

  /** Undefined for an unknown id, and for another user's — never a 403 that confirms it exists. */
  get(userId: string, id: string, now: Date = new Date()): Trade | undefined {
    const found = this.#byId.get(id);
    return found && found.userId === userId ? withExpiry(found, now) : undefined;
  }

  /**
   * The one transition out of `prepared`, and atomic: the check and the write
   * happen in one synchronous call, so of two concurrent commits exactly one
   * gets the trade and the other gets `'committed'`.
   *
   * `'expired'` is separate from not-found so the route can answer
   * `trade_expired` rather than `trade_not_found` (the plan's signature has
   * only the latter).
   */
  claimForCommit(
    userId: string,
    id: string,
    now: Date,
  ): Trade | 'committed' | 'expired' | undefined {
    const found = this.get(userId, id, now);
    if (!found) return undefined;
    if (found.status === 'expired') return 'expired';
    if (found.status !== 'prepared') return 'committed';
    return this.#replace(found, { status: 'executing' }, now);
  }

  /**
   * Applies the executor's progress. Keyed by id alone: only code already
   * holding a claimed trade calls it, and the claim checked the user.
   */
  update(id: string, patch: TradePatch, now: Date = new Date()): Trade | undefined {
    const found = this.#byId.get(id);
    return found ? this.#replace(found, patch, now) : undefined;
  }

  /**
   * The user's newest `limit` trades, newest first.
   *
   * A scan of everything held: retention bounds it to a day of manual trades,
   * which is far below the size where an index per user would pay for itself.
   */
  listRecent(userId: string, limit: number, now: Date = new Date()): Trade[] {
    const mine: Trade[] = [];
    for (const trade of this.#byId.values()) {
      if (trade.userId === userId) mine.push(withExpiry(trade, now));
    }
    return mine
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, Math.max(0, limit));
  }

  /**
   * Forgets trades past retention. Never an executing one: its steps are still
   * landing, and forgetting it would turn the phone's next poll into a 404
   * while money moves.
   *
   * Unlike the prepared-approval sweep this cannot stop at the first live
   * entry — expiry and retention give entries different lifetimes, so
   * insertion order is not expiry order.
   */
  sweep(now: Date): void {
    for (const trade of this.#byId.values()) {
      if (trade.status === 'executing') continue;
      const lastChange = trade.status === 'prepared' ? trade.expiresAt : trade.updatedAt;
      if (lastChange.getTime() + TRADE_RETENTION_MS > now.getTime()) continue;
      this.#byId.delete(trade.id);
      const key = clientKey(trade.userId, trade.clientTradeId);
      if (this.#byClientId.get(key) === trade.id) this.#byClientId.delete(key);
    }
  }

  #replace(trade: Trade, patch: TradePatch, now: Date): Trade {
    const next: Trade = { ...trade, ...patch, updatedAt: now };
    this.#byId.set(trade.id, next);
    return next;
  }
}

/** A `prepared` trade past its deadline reads as `expired`; nothing else changes. */
function withExpiry(trade: Trade, now: Date): Trade {
  return trade.status === 'prepared' && trade.expiresAt.getTime() <= now.getTime()
    ? { ...trade, status: 'expired' }
    : trade;
}

function clientKey(userId: string, clientTradeId: string): string {
  return `${userId}:${clientTradeId}`;
}
