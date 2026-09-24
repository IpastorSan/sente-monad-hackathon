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
 * Erasable syntax only and no Nest import (CLAUDE.md gotcha 10): the SEN-44 and
 * SEN-42 live probes load this file under node's type stripping. It is constructed by
 * `AgentsService` rather than injected for the same reason a lock map is —
 * it is process-local state, not a collaborator a caller would swap.
 */

import type { AuthorizationPayload } from '@sente/mandate';

import type { EnclaveRequest } from './agent-wallet.provider.ts';

/**
 * What a prepared request is FOR. The phone shows it, and the commit route
 * checks it, so a prepare made for a revoke can never be committed as an amend.
 *
 * `wallet_send` is SEN-42's: one transfer out of the user's own device-owned
 * wallet, prepared and committed through this same store.
 */
export type PreparedApprovalKind = 'mandate_amend' | 'mandate_revoke' | 'wallet_send';

/**
 * How long a prepared change stays committable.
 *
 * Five minutes: long enough for a biometric prompt and a moment's reading, short
 * enough that an approval is about what is on screen now. There is no refresh —
 * a stale prepare is prepared again, over the current state.
 *
 * SEN-42's transfers use this rather than `WALLET_PREPARE_TTL_MS`: that one is
 * short because a Kernel prepare carries a GAS QUOTE that goes stale, and a
 * device-signed send carries none. What expires here is consent, not a price.
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
  /**
   * WHAT this prepare is about, and the second half of its identity: the agent
   * whose policy a mandate change would replace, or the wallet a `wallet_send`
   * would spend from. The commit route checks it, so a signature prepared for
   * one subject can never be committed against another.
   */
  readonly subject: string;
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
  /** `userId:subject` -> the one live prepare for it. See {@link put}. */
  readonly #bySubject = new Map<string, string>();

  /**
   * Stores a prepared request, replacing whatever was pending for the same user
   * and subject.
   *
   * One live prepare per subject per user, on purpose. It is all any screen
   * uses — you approve the change in front of you — and without it every
   * abandoned prepare (a cancelled sheet, an edited mandate, a retyped amount,
   * a retried tap) would hold a request body for the whole TTL, on a route that
   * does no network I/O and can therefore be called in a loop.
   */
  put(approval: PreparedApproval<TContext>): void {
    this.sweep(approval.createdAt);
    const subject = subjectKey(approval);
    const superseded = this.#bySubject.get(subject);
    if (superseded !== undefined) this.#byId.delete(superseded);
    this.#byId.set(approval.id, approval);
    this.#bySubject.set(subject, approval.id);
  }

  /** Undefined for unknown, expired, already-taken, or another user's id. */
  take(id: string, userId: string, now: Date): PreparedApproval<TContext> | undefined {
    const found = this.#byId.get(id);
    if (!found) return undefined;
    // Not deleted on a mismatch: a wrong-user guess must not consume the
    // owner's prepare.
    if (found.userId !== userId) return undefined;
    this.forget(found);
    return found.expiresAt.getTime() <= now.getTime() ? undefined : found;
  }

  /**
   * Drops what has expired, and stops at the first entry that has not.
   *
   * Every entry gets the same TTL and a `Map` iterates in insertion order, so
   * the map is already ordered by expiry: the walk is the length of what it
   * deletes rather than of everything being held.
   */
  private sweep(now: Date): void {
    for (const approval of this.#byId.values()) {
      if (approval.expiresAt.getTime() > now.getTime()) return;
      this.forget(approval);
    }
  }

  private forget(approval: PreparedApproval<TContext>): void {
    this.#byId.delete(approval.id);
    const subject = subjectKey(approval);
    if (this.#bySubject.get(subject) === approval.id) this.#bySubject.delete(subject);
  }
}

/** The key `#bySubject` is indexed by: one live prepare per user per subject. */
function subjectKey(approval: Pick<PreparedApproval<unknown>, 'userId' | 'subject'>): string {
  return `${approval.userId}:${approval.subject}`;
}
