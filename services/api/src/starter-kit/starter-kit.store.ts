// Erasable syntax and `.ts` specifiers: the SQLite store beside this file is
// loaded by the import script under node's type stripping (CLAUDE.md gotcha 10).
import { createHash } from 'node:crypto';

import type { Address, Hash } from 'viem';

import { utcDay } from '../gas/ledger/drip-ledger.ts';
import { JsonRecordFile } from '../state/json-file.ts';

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
  /**
   * SHA-256 of the client IP the claiming register came from (SEN-204), so
   * the per-IP cap survives a restart without keeping addresses at rest.
   * Absent on records from before it, and when the request had no IP.
   */
  ipHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type StarterKitClaim = 'claimed' | 'exists' | 'capped' | 'ip_capped';

/** The per-IP half of a claim (SEN-204): the caller's IP and how many kits it may have a day. */
export interface StarterKitIpLimit {
  ip: string;
  cap: number;
}

/** What a record keeps of an IP: enough to count by, not the address itself. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(`sente/starter-kit/ip/${ip}`).digest('hex');
}

/** What a `pending` record found at boot becomes: a restart interrupted it mid-send. */
export function interrupted(record: StarterKitRecord): StarterKitRecord {
  return {
    ...record,
    status: 'failed',
    reason: 'interrupted by a restart while sending; not retried',
  };
}

/** The record `claim` writes. */
export function pendingKit(
  userId: string,
  address: Address,
  now: Date,
  ipHash: string | undefined,
): StarterKitRecord {
  return {
    userId,
    address,
    status: 'pending',
    txs: {},
    ...(ipHash !== undefined ? { ipHash } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Who has been sent a starter kit (SEN-170): one record per user, ever.
 *
 * Synchronous on purpose, like `JsonRecordFile` and `node:sqlite`: `claim`
 * checks the user, checks the day's cap and writes the record with no `await`
 * in between, so two concurrent registers for one user cannot both claim, and
 * fifty-one users at once cannot all fit under a cap of fifty.
 *
 * Persistent stores write every mutation through, so a redeploy does not send
 * a second kit to everybody who already had one. A record still `pending` at
 * boot was interrupted mid-send by the restart: it becomes `failed` and is
 * never retried, because a transfer may have landed.
 *
 * `FileStarterKitStore` (in memory without a path) and `SqliteStarterKitStore`
 * (`STORE_BACKEND=sqlite`, SEN-205).
 */
export interface StarterKitStore {
  find(userId: string): StarterKitRecord | undefined;
  /**
   * Records a pending kit for `userId`, unless they already have one, the
   * day's cap is spent, or (with `ipLimit`) the day's cap for that IP is.
   * Failed attempts count against both caps: each one may have cost gas.
   * The caps reset at 00:00 UTC, as the gas drip's does.
   */
  claim(
    userId: string,
    address: Address,
    dailyCap: number,
    now: Date,
    ipLimit?: StarterKitIpLimit,
  ): StarterKitClaim;
  update(userId: string, patch: Partial<Omit<StarterKitRecord, 'userId'>>, now: Date): void;
}

/** With a path (`STATE_DIR` set) every mutation is written through to `starter-kits.json`. */
export class FileStarterKitStore implements StarterKitStore {
  readonly #file: JsonRecordFile<StarterKitRecord> | undefined;
  readonly #byUserId = new Map<string, StarterKitRecord>();

  constructor(path?: string) {
    this.#file = path ? new JsonRecordFile<StarterKitRecord>(path) : undefined;
    let wasInterrupted = false;
    for (const record of this.#file?.load() ?? []) {
      if (record.status === 'pending') {
        wasInterrupted = true;
        this.#byUserId.set(record.userId, interrupted(record));
      } else {
        this.#byUserId.set(record.userId, record);
      }
    }
    if (wasInterrupted) this.#save();
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

  claim(
    userId: string,
    address: Address,
    dailyCap: number,
    now: Date,
    ipLimit?: StarterKitIpLimit,
  ): StarterKitClaim {
    if (this.#byUserId.has(userId)) return 'exists';
    const day = utcDay(now);
    const ipHash = ipLimit ? hashIp(ipLimit.ip) : undefined;
    let today = 0;
    let fromIp = 0;
    for (const record of this.#byUserId.values()) {
      if (utcDay(record.createdAt) !== day) continue;
      today += 1;
      if (ipHash !== undefined && record.ipHash === ipHash) fromIp += 1;
    }
    if (today >= dailyCap) return 'capped';
    if (ipLimit && fromIp >= ipLimit.cap) return 'ip_capped';

    this.#byUserId.set(userId, pendingKit(userId, address, now, ipHash));
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
