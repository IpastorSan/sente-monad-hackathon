/**
 * Changes waiting for their owner's signature — the prepare half of every
 * prepare/commit pair (SEN-44).
 *
 * A device-owned Privy resource can only be changed by a request the phone
 * signed, and the phone is not in the request that asks for the change. So the
 * server composes the exact enclave request, keeps it here, hands the phone the
 * payload to sign, and sends the STORED request when the signature comes back.
 *
 * Why store the request rather than round-trip it through the client: the
 * signature covers the method, URL and body byte for byte, so a request rebuilt
 * at commit time is a request that can differ from the one that was approved.
 * The same reasoning as `wallet/store/prepared-operation-store.ts`, and the
 * same two properties: entries are SINGLE-USE (a signature that stays spendable
 * is one waiting to be replayed) and SHORT-LIVED (an approval a user gave ten
 * minutes ago is not consent for a change they have since reconsidered).
 *
 * Deliberately generic — kind, request, context, TTL — because SEN-42 sends
 * funds from the user's own device-owned wallet through the same shape. The
 * kinds are a union rather than a free string so a new operation has to be
 * declared here, next to the rule that every kind is one enclave request.
 *
 * PERSISTENCE: in memory, per process, like the agent store it sits beside.
 * Restarting the API loses prepared changes, which costs a user one extra
 * prepare and can never lose a committed one.
 *
 * Erasable syntax only and no Nest import (CLAUDE.md gotcha 10): the SEN-44
 * live probe loads this file under node's type stripping. It is constructed by
 * `AgentsService` rather than injected for the same reason a lock map is —
 * it is process-local state, not a collaborator a caller would swap.
 */

import type { AuthorizationPayload } from '@sente/mandate';

import type { EnclaveRequest } from './agent-wallet.provider.ts';

/**
 * What a prepared request is FOR. The phone shows it, and the commit route
 * checks it, so a prepare made for a revoke can never be committed as an amend.
 *
 * SEN-42 adds its own member here when transfers land.
 */
export type PreparedApprovalKind = 'mandate_amend' | 'mandate_revoke';

/**
 * How long a prepared change stays committable.
 *
 * Five minutes: long enough for a biometric prompt and a moment's reading, short
 * enough that an approval is about the mandate on screen now. There is no
 * refresh — a stale prepare is prepared again, over the current state.
 */
export const PREPARED_APPROVAL_TTL_MS = 5 * 60 * 1000;

/**
 * One request held between prepare and commit.
 *
 * `context` is whatever the committing code needs that the request itself does
 * not carry — for a mandate change, the parsed mandate to store once the
 * enclave has accepted it. It never reaches the phone.
 */
export interface PreparedApproval<TContext> {
  readonly id: string;
  readonly kind: PreparedApprovalKind;
  /** The principal that prepared it. Another user's prepare id is not found. */
  readonly userId: string;
  /** The agent whose policy this changes: the commit route's `:id` must match. */
  readonly agentId: string;
  /** Sent verbatim at commit. */
  readonly request: EnclaveRequest;
  /** Exactly what the owner signs. The phone rebuilds it and compares. */
  readonly payload: AuthorizationPayload;
  readonly context: TContext;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * The prepared changes one process is holding.
 *
 * `take` is the only read, and it consumes: there is no way to look at a
 * prepared request without spending it, so two commits of one signature cannot
 * both find it.
 */
export class PreparedApprovals<TContext> {
  readonly #byId = new Map<string, PreparedApproval<TContext>>();

  put(approval: PreparedApproval<TContext>): void {
    this.sweep(approval.createdAt);
    this.#byId.set(approval.id, approval);
  }

  /** Undefined for unknown, expired, already-taken, or another user's id. */
  take(id: string, userId: string, now: Date): PreparedApproval<TContext> | undefined {
    const found = this.#byId.get(id);
    if (!found) return undefined;
    // Not deleted on a mismatch: a wrong-user guess must not consume the
    // owner's prepare.
    if (found.userId !== userId) return undefined;
    this.#byId.delete(id);
    return found.expiresAt.getTime() <= now.getTime() ? undefined : found;
  }

  /** Drops what has expired. Cheap, and bounded by how often prepares happen. */
  private sweep(now: Date): void {
    for (const [id, approval] of this.#byId) {
      if (approval.expiresAt.getTime() <= now.getTime()) this.#byId.delete(id);
    }
  }
}
