import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Address, Hash } from 'viem';

import {
  utcDay,
  type DripClaimInput,
  type DripClaimResult,
  type DripLedger,
  type DripRecord,
} from './drip-ledger';

/**
 * Process-local DripLedger. See the header of `drip-ledger.ts` for what this
 * costs you and how to replace it.
 *
 * `claim()` is atomic here for free: the body contains no `await`, so the V8
 * event loop cannot interleave two claims. That is exactly the property a SQL
 * implementation has to reproduce with a transaction.
 */
@Injectable()
export class InMemoryDripLedger implements DripLedger {
  private readonly byId = new Map<string, DripRecord>();
  private readonly byUserId = new Map<string, string>();
  private readonly byAddress = new Map<string, string>();
  private readonly dailyTotals = new Map<string, bigint>();

  claim(input: DripClaimInput): Promise<DripClaimResult> {
    const address = input.address.toLowerCase() as Address;

    if (this.byUserId.has(input.userId)) {
      return Promise.resolve({ ok: false, reason: 'user_already_dripped' });
    }
    if (this.byAddress.has(address)) {
      return Promise.resolve({ ok: false, reason: 'address_already_dripped' });
    }

    const day = utcDay(input.now);
    const spent = this.dailyTotals.get(day) ?? 0n;
    const next = spent + input.amountWei;
    if (next > input.dailyCapWei) {
      return Promise.resolve({ ok: false, reason: 'daily_cap_reached' });
    }

    const reservation: DripRecord = {
      id: randomUUID(),
      userId: input.userId,
      address,
      amountWei: input.amountWei,
      day,
      status: 'reserved',
      createdAt: input.now,
    };

    this.byId.set(reservation.id, reservation);
    this.byUserId.set(reservation.userId, reservation.id);
    this.byAddress.set(address, reservation.id);
    this.dailyTotals.set(day, next);

    return Promise.resolve({ ok: true, reservation, dailyTotalWei: next });
  }

  confirm(reservationId: string, txHash: Hash): Promise<void> {
    const record = this.byId.get(reservationId);
    if (record) {
      record.status = 'confirmed';
      record.txHash = txHash;
    }
    return Promise.resolve();
  }

  release(reservationId: string): Promise<void> {
    const record = this.byId.get(reservationId);
    // Only a reservation can be released; a confirmed drip is on chain and the
    // money is gone whatever the ledger says.
    if (!record || record.status !== 'reserved') {
      return Promise.resolve();
    }
    this.byId.delete(record.id);
    this.byUserId.delete(record.userId);
    this.byAddress.delete(record.address);
    const spent = this.dailyTotals.get(record.day) ?? 0n;
    const remaining = spent - record.amountWei;
    this.dailyTotals.set(record.day, remaining > 0n ? remaining : 0n);
    return Promise.resolve();
  }

  findByUserId(userId: string): Promise<DripRecord | undefined> {
    return Promise.resolve(this.lookup(this.byUserId.get(userId)));
  }

  findByAddress(address: Address): Promise<DripRecord | undefined> {
    return Promise.resolve(this.lookup(this.byAddress.get(address.toLowerCase())));
  }

  dailyTotalWei(day: string): Promise<bigint> {
    return Promise.resolve(this.dailyTotals.get(day) ?? 0n);
  }

  private lookup(id: string | undefined): DripRecord | undefined {
    return id === undefined ? undefined : this.byId.get(id);
  }
}
