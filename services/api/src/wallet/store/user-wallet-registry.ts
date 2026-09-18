import { Injectable } from '@nestjs/common';
import type { Address } from 'viem';

/** DI token for the userId -> Privy user wallet binding. */
export const USER_WALLET_REGISTRY = Symbol('USER_WALLET_REGISTRY');

export type UserWalletBinding = {
  userId: string;
  /** Privy's wallet id. What a future `/rpc` call is addressed to. */
  walletId: string;
  /** The EVM address, checksummed. */
  address: Address;
  /** The 1-key quorum that owns the wallet. PATCH target when recovery lands. */
  ownerQuorumId: string;
  /** base64 SPKI DER of the phone's P-256 `device` key — the owner. */
  devicePublicKey: string;
  createdAt: Date;
};

/**
 * ---------------------------------------------------------------------------
 * ONE WALLET PER USER, AND THE DEVICE KEY IS PART OF THE IDENTITY
 *
 * `bind` is first-write-wins on `userId`, like `smart-account-registry.ts`, but
 * the conflict it guards is sharper. A Privy wallet's address is NOT a function
 * of its owner key: creating a second one for the same user does not land on
 * the same address, it makes a second account, and whatever the first one holds
 * is then invisible to the app. So a register call carrying a different device
 * key is refused (`device_key_mismatch`) rather than honoured.
 *
 * That refusal is the correct answer for the case it is most likely to see —
 * a reinstall, or a second phone, where the passkey re-derives a device key
 * that is not the one the quorum holds. Recovery (adding the new key to the
 * owner quorum, which only the OLD key can authorize) is deliberately out of
 * scope here: see SEN-40's notes. Silently minting a second wallet would look
 * like success and lose the user's funds.
 * ---------------------------------------------------------------------------
 */
export interface UserWalletRegistry {
  find(userId: string): Promise<UserWalletBinding | undefined>;

  /**
   * Binds `userId` to this wallet, or returns the existing binding when the
   * device key matches. Rejects a different device key.
   */
  bind(binding: Omit<UserWalletBinding, 'createdAt'>): Promise<UserWalletBindResult>;
}

export type UserWalletBindResult =
  | { ok: true; binding: UserWalletBinding; created: boolean }
  | { ok: false; existing: UserWalletBinding };

/**
 * PERSISTENCE: in memory, the repo's current standard (see
 * `smart-account-registry.ts`, `gas/ledger`). The cost of losing this one on
 * restart is higher than the Kernel registry's, though, and it is worth being
 * honest about: a Privy wallet is not re-derivable, so a lost binding means the
 * next register creates a SECOND wallet and the funded one is orphaned. The
 * wallet itself survives — Privy has it, owned by the same device key — but
 * nothing here remembers its id. Point this token at a real store before
 * anything of value lands in a user wallet.
 */
@Injectable()
export class InMemoryUserWalletRegistry implements UserWalletRegistry {
  private readonly byUserId = new Map<string, UserWalletBinding>();

  find(userId: string): Promise<UserWalletBinding | undefined> {
    return Promise.resolve(this.byUserId.get(userId));
  }

  bind(binding: Omit<UserWalletBinding, 'createdAt'>): Promise<UserWalletBindResult> {
    const existing = this.byUserId.get(binding.userId);
    if (existing) {
      // Exact string compare: both halves are the canonical base64 SPKI DER
      // `authorization-key.ts` produces, and base64 has no case folding.
      const sameKey = existing.devicePublicKey === binding.devicePublicKey;
      return Promise.resolve(
        sameKey ? { ok: true, binding: existing, created: false } : { ok: false, existing },
      );
    }
    const created: UserWalletBinding = { ...binding, createdAt: new Date() };
    this.byUserId.set(binding.userId, created);
    return Promise.resolve({ ok: true, binding: created, created: true });
  }
}
