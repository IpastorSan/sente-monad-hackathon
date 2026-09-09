import { Injectable } from '@nestjs/common';
import type { Address } from 'viem';

/** DI token for the userId -> smart account binding. */
export const SMART_ACCOUNT_REGISTRY = Symbol('SMART_ACCOUNT_REGISTRY');

export type SmartAccountBinding = {
  userId: string;
  /** The Mera EOA that owns the Kernel account. */
  owner: Address;
  /** The Kernel smart account address, derived from `owner`. */
  address: Address;
  boundAt: Date;
};

/**
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE ONLY PLACE A SENDER MAY COME FROM
 *
 * At Charms, resolving the wallet from a client-supplied address instead of
 * from the authenticated user's identity produced a real bug: a stale address
 * cached on a shared device leaked across accounts, so one user's request was
 * built against another user's wallet. Nothing about the request looked wrong.
 *
 * So the rule here is absolute — a request body may CARRY a sender, and the
 * service will compare it, but the sender that gets used is always the one this
 * registry returns for the authenticated principal. A mismatch is logged and
 * rejected rather than tolerated, because a client that has drifted is a client
 * about to sign for the wrong account.
 *
 * The binding is first-write-wins: the Kernel address is a pure function of the
 * owner (CREATE2, see `apps/mobile/src/wallet/kernel.ts`), so a second, DIFFERENT
 * owner for the same user is not a re-registration, it is a different account
 * and almost certainly a bug or an attack.
 * ---------------------------------------------------------------------------
 */
export interface SmartAccountRegistry {
  find(userId: string): Promise<SmartAccountBinding | undefined>;

  /**
   * Binds `userId` to `owner`/`address`, or returns the existing binding when
   * one already matches. Rejects a conflicting owner.
   */
  bind(binding: Omit<SmartAccountBinding, 'boundAt'>): Promise<BindResult>;
}

export type BindResult =
  | { ok: true; binding: SmartAccountBinding; created: boolean }
  | { ok: false; existing: SmartAccountBinding };

/**
 * PERSISTENCE: in memory, because this repo has no database yet — the same
 * choice `gas/ledger` made. Bind `SMART_ACCOUNT_REGISTRY` to a real store and
 * nothing else in `wallet/` changes.
 *
 * The cost of losing it on restart is small: a client simply re-registers, and
 * the derivation is deterministic, so it lands on the same address.
 */
@Injectable()
export class InMemorySmartAccountRegistry implements SmartAccountRegistry {
  private readonly byUserId = new Map<string, SmartAccountBinding>();

  find(userId: string): Promise<SmartAccountBinding | undefined> {
    return Promise.resolve(this.byUserId.get(userId));
  }

  bind(binding: Omit<SmartAccountBinding, 'boundAt'>): Promise<BindResult> {
    const existing = this.byUserId.get(binding.userId);
    if (existing) {
      const sameOwner = existing.owner.toLowerCase() === binding.owner.toLowerCase();
      return Promise.resolve(
        sameOwner ? { ok: true, binding: existing, created: false } : { ok: false, existing },
      );
    }
    const created: SmartAccountBinding = { ...binding, boundAt: new Date() };
    this.byUserId.set(binding.userId, created);
    return Promise.resolve({ ok: true, binding: created, created: true });
  }
}
