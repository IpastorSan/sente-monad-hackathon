import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Address, Hash } from 'viem';

import {
  utcDay,
  type AgentDripClaimInput,
  type AgentDripClaimResult,
  type DripClaimInput,
  type DripClaimResult,
  type DripLedger,
  type DripRecord,
} from './drip-ledger';

/**
 * Process-local DripLedger. See the header of `drip-ledger.ts` for what this
 * costs you and how to replace it.
 *
 * `claim()` and `claimAgent()` are atomic here for free: their bodies contain
 * no `await`, so the V8 event loop cannot interleave two claims. That is
 * exactly the property a SQL implementation has to reproduce with a
 * transaction.
 */
@Injectable()
export class InMemoryDripLedger implements DripLedger {
  private readonly byId = new Map<string, DripRecord>();
  private readonly byUserId = new Map<string, string>();
  private readonly byAgentId = new Map<string, string>();
  /** Shared by user and agent drips: an address is funded once, whoever asked. */
  private readonly byAddress = new Map<string, string>();
  private readonly dailyTotals = new Map<string, bigint>();
  /** `${day}|${userId}` -> agents that user has had funded that day. */
  private readonly agentDripsPerUserDay = new Map<string, number>();

  claim(input: DripClaimInput): Promise<DripClaimResult> {
    const address = input.address.toLowerCase() as Address;

    if (this.byUserId.has(input.userId)) {
      return Promise.resolve({ ok: false, reason: 'user_already_dripped' });
    }
    if (this.byAddress.has(address)) {
      return Promise.resolve({ ok: false, reason: 'address_already_dripped' });
    }

    const day = utcDay(input.now);
    const next = (this.dailyTotals.get(day) ?? 0n) + input.amountWei;
    if (next > input.dailyCapWei) {
      return Promise.resolve({ ok: false, reason: 'daily_cap_reached' });
    }

    const reservation = this.reserve({
      userId: input.userId,
      address,
      amountWei: input.amountWei,
      day,
      now: input.now,
    });
    this.byUserId.set(reservation.userId, reservation.id);
    this.dailyTotals.set(day, next);

    return Promise.resolve({ ok: true, reservation, dailyTotalWei: next });
  }

  claimAgent(input: AgentDripClaimInput): Promise<AgentDripClaimResult> {
    const address = input.address.toLowerCase() as Address;

    if (this.byAgentId.has(input.agentId)) {
      return Promise.resolve({ ok: false, reason: 'agent_already_dripped' });
    }
    if (this.byAddress.has(address)) {
      return Promise.resolve({ ok: false, reason: 'address_already_dripped' });
    }

    const day = utcDay(input.now);
    const perUserKey = `${day}|${input.userId}`;
    const funded = this.agentDripsPerUserDay.get(perUserKey) ?? 0;
    // The more specific refusal first: the user hit THEIR limit, not the faucet's.
    if (funded >= input.maxPerUserPerDay) {
      return Promise.resolve({ ok: false, reason: 'agent_daily_limit_reached' });
    }
    const next = (this.dailyTotals.get(day) ?? 0n) + input.amountWei;
    if (next > input.dailyCapWei) {
      return Promise.resolve({ ok: false, reason: 'daily_cap_reached' });
    }

    const reservation = this.reserve({
      userId: input.userId,
      agentId: input.agentId,
      address,
      amountWei: input.amountWei,
      day,
      now: input.now,
    });
    this.byAgentId.set(input.agentId, reservation.id);
    this.agentDripsPerUserDay.set(perUserKey, funded + 1);
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
    this.byAddress.delete(record.address);
    if (record.agentId === undefined) {
      this.byUserId.delete(record.userId);
    } else {
      this.byAgentId.delete(record.agentId);
      const perUserKey = `${record.day}|${record.userId}`;
      const funded = this.agentDripsPerUserDay.get(perUserKey) ?? 0;
      this.agentDripsPerUserDay.set(perUserKey, funded > 0 ? funded - 1 : 0);
    }
    const spent = this.dailyTotals.get(record.day) ?? 0n;
    const remaining = spent - record.amountWei;
    this.dailyTotals.set(record.day, remaining > 0n ? remaining : 0n);
    return Promise.resolve();
  }

  findByUserId(userId: string): Promise<DripRecord | undefined> {
    return Promise.resolve(this.lookup(this.byUserId.get(userId)));
  }

  findByAgentId(agentId: string): Promise<DripRecord | undefined> {
    return Promise.resolve(this.lookup(this.byAgentId.get(agentId)));
  }

  findByAddress(address: Address): Promise<DripRecord | undefined> {
    return Promise.resolve(this.lookup(this.byAddress.get(address.toLowerCase())));
  }

  dailyTotalWei(day: string): Promise<bigint> {
    return Promise.resolve(this.dailyTotals.get(day) ?? 0n);
  }

  /** Records a reservation under its id and address. Callers add their own key. */
  private reserve(input: {
    userId: string;
    agentId?: string;
    address: Address;
    amountWei: bigint;
    day: string;
    now: Date;
  }): DripRecord {
    const reservation: DripRecord = {
      id: randomUUID(),
      userId: input.userId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      address: input.address,
      amountWei: input.amountWei,
      day: input.day,
      status: 'reserved',
      createdAt: input.now,
    };
    this.byId.set(reservation.id, reservation);
    this.byAddress.set(input.address, reservation.id);
    return reservation;
  }

  private lookup(id: string | undefined): DripRecord | undefined {
    return id === undefined ? undefined : this.byId.get(id);
  }
}
