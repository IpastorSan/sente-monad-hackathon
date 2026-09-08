import type { Address, Hash } from 'viem';

/**
 * ---------------------------------------------------------------------------
 * PERSISTENCE BOUNDARY
 *
 * There is no database in this repo yet and adding one is out of scope for
 * MOV-252. `DripLedger` is the seam: everything the drip service needs to know
 * about durable state goes through this interface, and the only implementation
 * today is `InMemoryDripLedger` (process-local, lost on restart).
 *
 * Consequences of the in-memory implementation, stated plainly:
 *   - restarting the API resets "one drip per user/address, ever"
 *   - the daily cap resets on restart
 *   - it is correct for exactly one process; two API replicas each get their
 *     own cap and their own dedupe tables
 *
 * Swapping in a real store means implementing this interface and rebinding the
 * DRIP_LEDGER token in GasModule. Nothing else changes. A SQL implementation
 * should express `claim()` as one transaction with UNIQUE indexes on
 * (user_id) and (address) and a `SELECT ... FOR UPDATE` on the day row, which
 * is why the cap check lives inside `claim()` rather than in the service.
 * ---------------------------------------------------------------------------
 */

/** Refusals the ledger itself can produce. A subset of DripRefusalReason. */
export type LedgerRefusalReason =
  'user_already_dripped' | 'address_already_dripped' | 'daily_cap_reached';

export type DripStatus = 'reserved' | 'confirmed';

export interface DripRecord {
  id: string;
  userId: string;
  /** Lowercased. The service normalises before it reaches the ledger. */
  address: Address;
  amountWei: bigint;
  /** UTC calendar day, `YYYY-MM-DD`. The cap is per day, per faucet. */
  day: string;
  status: DripStatus;
  txHash?: Hash;
  createdAt: Date;
}

export interface DripClaimInput {
  userId: string;
  address: Address;
  amountWei: bigint;
  dailyCapWei: bigint;
  now: Date;
}

export type DripClaimResult =
  | { ok: true; reservation: DripRecord; dailyTotalWei: bigint }
  | { ok: false; reason: LedgerRefusalReason };

export interface DripLedger {
  /**
   * Atomically check the per-user, per-address and per-day limits and reserve
   * the amount. MUST be all-or-nothing: two concurrent claims for the same user
   * or address, or that together cross the cap, cannot both return ok.
   */
  claim(input: DripClaimInput): Promise<DripClaimResult>;
  /** Promote a reservation to confirmed once the transaction is broadcast. */
  confirm(reservationId: string, txHash: Hash): Promise<void>;
  /** Roll a reservation back — the send failed, so it must not consume budget. */
  release(reservationId: string): Promise<void>;
  findByUserId(userId: string): Promise<DripRecord | undefined>;
  findByAddress(address: Address): Promise<DripRecord | undefined>;
  dailyTotalWei(day: string): Promise<bigint>;
}

export const DRIP_LEDGER = Symbol('DRIP_LEDGER');

/** UTC calendar day key. Deliberately UTC so the cap does not move with a deploy region. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}
