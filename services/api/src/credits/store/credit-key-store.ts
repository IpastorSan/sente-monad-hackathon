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
 * In memory: the specs, and a plain `pnpm start` with no `STATE_DIR`. With
 * `STATE_DIR` set the module binds `FileCreditKeyStore` instead (SEN-204),
 * because a store that forgets on restart lets every user mint a second key.
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
