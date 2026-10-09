import type { Address, Hash } from 'viem';

import { utcDay } from '../gas/ledger/drip-ledger';
import { JsonRecordFile } from '../state/json-file';

/** DI token for the once-per-user record of who got a starter kit. */
export const STARTER_KIT_STORE = Symbol('STARTER_KIT_STORE');

export type StarterKitSymbol = 'AUSD' | 'USDC';

export interface StarterKitRecord {
  userId: string;
  /** The wallet the kit was sent to. */
  address: Address;
  status: 'pending' | 'sent' | 'failed';
  /** Each transfer's hash, once broadcast. */
  txs: Partial<Record<StarterKitSymbol, Hash>>;
  /** Why it failed, for the operator. Never on the wire. */
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type StarterKitClaim = 'claimed' | 'exists' | 'capped';

/**
 * Who has been sent a starter kit (SEN-170): one record per user, ever.
 *
 * Synchronous on purpose, like `JsonRecordFile`: `claim` checks the user, checks
 * the day's cap and writes the record with no `await` in between, so two
 * concurrent registers for one user cannot both claim, and fifty-one users at
 * once cannot all fit under a cap of fifty.
 *
 * With a path (`STATE_DIR` set) every mutation is written through, so a
 * redeploy does not send a second kit to everybody who already had one. A
 * record still `pending` at boot was interrupted mid-send by the restart: it
 * is loaded as `failed` and never retried, because a transfer may have landed.
 */
export class StarterKitStore {
  readonly #file: JsonRecordFile<StarterKitRecord> | undefined;
  readonly #byUserId = new Map<string, StarterKitRecord>();

  constructor(path?: string) {
    this.#file = path ? new JsonRecordFile<StarterKitRecord>(path) : undefined;
    let interrupted = false;
    for (const record of this.#file?.load() ?? []) {
      if (record.status === 'pending') {
        interrupted = true;
        this.#byUserId.set(record.userId, {
          ...record,
          status: 'failed',
          reason: 'interrupted by a restart while sending; not retried',
        });
      } else {
        this.#byUserId.set(record.userId, record);
      }
    }
    if (interrupted) this.#save();
  }

  get path(): string | undefined {
    return this.#file?.path;
  }

  get size(): number {
    return this.#byUserId.size;
  }

  find(userId: string): StarterKitRecord | undefined {
    const record = this.#byUserId.get(userId);
    return record ? structuredClone(record) : undefined;
  }

  /**
   * Records a pending kit for `userId`, unless they already have one or the
   * day's cap is spent. Failed attempts count against the cap: each one may
   * have cost gas.
   */
  claim(userId: string, address: Address, dailyCap: number, now: Date): StarterKitClaim {
    if (this.#byUserId.has(userId)) return 'exists';
    // The cap resets at 00:00 UTC, as the gas drip's does.
    const day = utcDay(now);
    let today = 0;
    for (const record of this.#byUserId.values()) {
      if (utcDay(record.createdAt) === day) today += 1;
    }
    if (today >= dailyCap) return 'capped';

    this.#byUserId.set(userId, {
      userId,
      address,
      status: 'pending',
      txs: {},
      createdAt: now,
      updatedAt: now,
    });
    try {
      this.#save();
    } catch (error) {
      // Unpersisted means a restart would forget it and send again: undo.
      this.#byUserId.delete(userId);
      throw error;
    }
    return 'claimed';
  }

  update(userId: string, patch: Partial<Omit<StarterKitRecord, 'userId'>>, now: Date): void {
    const record = this.#byUserId.get(userId);
    if (!record) return;
    this.#byUserId.set(userId, { ...record, ...patch, updatedAt: now });
    this.#save();
  }

  #save(): void {
    this.#file?.save([...this.#byUserId.values()]);
  }
}
