import type { UserWalletRegistry } from '../wallet/store/user-wallet-registry';
import type { AgentMandateOwnerMode } from './agents.config';

/** DI token for {@link MandateOwners}. */
export const MANDATE_OWNERS = Symbol('MANDATE_OWNERS');

/**
 * ---------------------------------------------------------------------------
 * WHO OWNS A NEW AGENT'S MANDATE (SEN-43, Phase 3)
 *
 * A Privy policy and wallet are owned by a key quorum, and only that quorum can
 * change them. Until Phase 3 it was always the server's `PRIVY_MANDATE_QUORUM_ID`
 * — so the guarantee we were selling ("an agent cannot exceed the mandate its
 * owner granted") held against the AGENT and not against US.
 *
 * In `device` mode the owner is instead the 1-key quorum holding the caller's
 * phone `device` key, the same one that owns their user wallet (SEN-40). The
 * server creates the policy — creation needs no owner signature — and from that
 * moment cannot touch it: `PRIVY_MANDATE_OWNER_KEY` gets 401 on any PATCH.
 * Verified live, see docs/privy-policy-enforcement.md §Phase 3.
 *
 * This is a seam rather than a direct `UserWalletRegistry` injection so that
 * `agents/` states what it needs — one quorum id per user — instead of reaching
 * into `wallet/`'s storage shape, and so a spec can run either mode with no
 * registry at all.
 * ---------------------------------------------------------------------------
 */
export interface MandateOwners {
  readonly mode: AgentMandateOwnerMode;
  /**
   * The quorum that must own this user's new agent policies and wallets, or
   * `undefined` when they have no registered wallet yet. Never called in
   * `server` mode.
   */
  ownerQuorumFor(userId: string): Promise<string | undefined>;
}

/**
 * Server mode: no per-user owner, so `provision` falls back to the provider's
 * own mandate quorum. The pre-SEN-43 behaviour, kept for the scripted refusal
 * demo and every unit spec — and refused in production by `agents.config.ts`.
 */
export class ServerMandateOwners implements MandateOwners {
  readonly mode = 'server' as const;

  ownerQuorumFor(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

/** Device mode: the owner is the quorum holding the user's phone key (SEN-40). */
export class DeviceMandateOwners implements MandateOwners {
  readonly mode = 'device' as const;
  readonly #registry: UserWalletRegistry;

  constructor(registry: UserWalletRegistry) {
    this.#registry = registry;
  }

  async ownerQuorumFor(userId: string): Promise<string | undefined> {
    return (await this.#registry.find(userId))?.ownerQuorumId;
  }
}
