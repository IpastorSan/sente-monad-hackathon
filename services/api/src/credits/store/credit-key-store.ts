import { Injectable } from '@nestjs/common';

/** DI token for the userId -> OpenRouter key binding. */
export const CREDIT_KEYS = Symbol('CREDIT_KEYS');

export type CreditKeyRecord = {
  userId: string;
  /** OpenRouter's identifier for the key; what the management API addresses. */
  hash: string;
  /**
   * The plaintext `sk-or-...` key. OpenRouter returns it exactly once, in the
   * create response, so losing it means minting a new key. SECRET: it is spent
   * against the user's budget by whoever holds it, so it never leaves the
   * server and never appears in an HTTP response or a log line.
   */
  key: string;
  createdAt: Date;
};

export type CreditKeyClaim =
  | { ok: true; record: CreditKeyRecord }
  /** Someone else's write landed first; `existing` is the one that counts. */
  | { ok: false; existing: CreditKeyRecord };

/**
 * ---------------------------------------------------------------------------
 * PERSISTENCE BOUNDARY — same seam as `gas/ledger/drip-ledger.ts` and
 * `wallet/store/smart-account-registry.ts`.
 *
 * `claim()` is first-write-wins: one user owns at most one key. Two concurrent
 * provisions may both reach OpenRouter, but only one record can land here, and
 * the loser is told which key won so it can delete its own. A SQL
 * implementation is an INSERT against a UNIQUE (user_id) index that returns the
 * existing row on conflict.
 *
 * A real store must encrypt `key` at rest: it is a bearer credential with
 * money behind it.
 * ---------------------------------------------------------------------------
 */
export interface CreditKeyStore {
  find(userId: string): Promise<CreditKeyRecord | undefined>;
  claim(record: Omit<CreditKeyRecord, 'createdAt'>): Promise<CreditKeyClaim>;
}

/**
 * PERSISTENCE: in memory, because this repo has no database yet. Restarting
 * the API forgets every binding while the keys live on at OpenRouter, so a
 * restart followed by a provision mints a second key for the same user (the
 * first is orphaned, still capped by its own limit). Acceptable until a real
 * store is bound to `CREDIT_KEYS`; nothing else in `credits/` changes then.
 */
@Injectable()
export class InMemoryCreditKeyStore implements CreditKeyStore {
  private readonly byUserId = new Map<string, CreditKeyRecord>();

  find(userId: string): Promise<CreditKeyRecord | undefined> {
    return Promise.resolve(this.byUserId.get(userId));
  }

  claim(record: Omit<CreditKeyRecord, 'createdAt'>): Promise<CreditKeyClaim> {
    const existing = this.byUserId.get(record.userId);
    if (existing) {
      return Promise.resolve({ ok: false, existing });
    }
    const created: CreditKeyRecord = { ...record, createdAt: new Date() };
    this.byUserId.set(record.userId, created);
    return Promise.resolve({ ok: true, record: created });
  }
}
