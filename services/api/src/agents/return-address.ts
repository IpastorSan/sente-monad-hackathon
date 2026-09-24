import { getAddress, type Address } from 'viem';

import type { UserWalletRegistry } from '../wallet/store/user-wallet-registry';

/** DI token for {@link ReturnAddresses}. */
export const RETURN_ADDRESSES = Symbol('RETURN_ADDRESSES');

/**
 * ---------------------------------------------------------------------------
 * WHERE AN AGENT'S MONEY GOES HOME TO (SEN-17)
 *
 * `mandate.returnTo` is the one address an agent's wallet may send an ERC-20 to,
 * compiled into its enclave policy (SEN-15). It is resolved HERE, server-side,
 * from the caller's registered user wallet (SEN-40) — never taken from the
 * request body. A client that could name the exit could name its own.
 *
 * It is the user's PRIVY WALLET address, which is what Phase 3 made the user's
 * account: the Kernel smart account is on its way out (SEN-45), and an exit
 * pinned to an address the user no longer controls is worse than no exit.
 *
 * A seam rather than a direct `UserWalletRegistry` injection, for the same
 * reason as `mandate-owner.ts`: `agents/` says what it needs — one home address
 * per user — instead of reaching into `wallet/`'s storage shape, and a spec can
 * run with no registry at all.
 * ---------------------------------------------------------------------------
 */
export interface ReturnAddresses {
  /**
   * Where this user's agents send funds back to, or `undefined` when they have
   * no registered wallet. `undefined` means an agent hired now gets NO exit
   * rule, which is the fail-closed answer: a guessed address would be a rule
   * pointing at somebody else.
   */
  addressFor(userId: string): Promise<Address | undefined>;
}

/** The registry `POST /wallet/register` writes: the user's own Privy wallet. */
export class RegistryReturnAddresses implements ReturnAddresses {
  readonly #registry: UserWalletRegistry;

  constructor(registry: UserWalletRegistry) {
    this.#registry = registry;
  }

  async addressFor(userId: string): Promise<Address | undefined> {
    const binding = await this.#registry.find(userId);
    // Checksummed here as well as in the registry: this string becomes a policy
    // condition, and Privy compares conditions as literals.
    return binding ? getAddress(binding.address) : undefined;
  }
}

/** No user wallets at all: every hire compiles without an exit rule. For specs. */
export class NoReturnAddresses implements ReturnAddresses {
  addressFor(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}
