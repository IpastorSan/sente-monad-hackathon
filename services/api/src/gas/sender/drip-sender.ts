import type { Address, Hash } from 'viem';

/** DI token for the rotating pool of faucet senders. */
export const SENDER_POOL = Symbol('SENDER_POOL');

export interface DripSendResult {
  hash: Hash;
  /** Nonce actually used. Unique per sender address — asserted in the tests. */
  nonce: number;
  sender: Address;
}

export interface DripSender {
  readonly address: Address;
  /**
   * `gasLimit` is per send because it depends on the recipient: 21k for an
   * EOA, more for an address with code. Always explicit, never estimated —
   * Monad charges the limit (CLAUDE.md gotcha 4).
   */
  send(to: Address, valueWei: bigint, gasLimit: bigint): Promise<DripSendResult>;
}

/**
 * The slice of a viem public client the nonce manager needs. Narrow on purpose:
 * a test fake is three lines, and viem's generics stay out of the unit tests.
 */
export interface NonceSource {
  getTransactionCount(args: { address: Address; blockTag: 'pending' }): Promise<number>;
}

/** The slice of a viem wallet client the nonce manager needs. */
export interface TransactionBroadcaster {
  sendTransaction(args: { to: Address; value: bigint; gas: bigint; nonce: number }): Promise<Hash>;
}
