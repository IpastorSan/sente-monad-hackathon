import type { Address, Hash, Hex } from 'viem';
import type { UserOperation, UserOperationReceipt } from 'viem/account-abstraction';

/** DI token for the bundler. */
export const BUNDLER = Symbol('BUNDLER');

/** EntryPoint v0.7 UserOperation, fully populated and ready to hash. */
export type SenteUserOperation = UserOperation<'0.7'>;

/** Everything except the fields the bundler is asked to size. */
export type UserOperationGasEstimate = {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
};

export type UserOperationFees = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

/**
 * The ERC-4337 bundler, behind an interface for two reasons:
 *
 *   1. It is the only piece of `wallet/` that must reach the network, so the
 *      service is unit testable by handing it a fake.
 *   2. Alchemy's Bundler API is a drop-in for Pimlico's at this surface — the
 *      four methods below are all standard `eth_*`/ERC-4337 RPC apart from the
 *      fee oracle, which is why `fees()` is a method rather than a raw call.
 */
export interface Bundler {
  /** Human-readable, for logs. Never the URL: it carries the API key. */
  readonly name: string;

  /**
   * Fee bid for the next UserOperation.
   *
   * NOTE for Monad: the fee is charged on the gas LIMIT, not gas used, so the
   * limits handed back by `estimate()` are spent in full. That is the
   * paymaster's money when sponsorship is on, and the account's when it is not.
   */
  fees(): Promise<UserOperationFees>;

  /** `eth_estimateUserOperationGas`. */
  estimate(
    userOperation: Omit<
      SenteUserOperation,
      'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas'
    > &
      Partial<UserOperationGasEstimate>,
  ): Promise<UserOperationGasEstimate>;

  /** `eth_sendUserOperation`. Returns the UserOperation hash. */
  send(userOperation: SenteUserOperation): Promise<Hash>;

  /**
   * `eth_getUserOperationReceipt`. `null` while the operation is still in the
   * mempool or the bundler's indexer is lagging.
   */
  receipt(userOpHash: Hash): Promise<UserOperationReceipt | null>;
}

/** The EntryPoint every account in this repo uses. */
export type EntryPointRef = {
  address: Address;
  version: '0.7';
};

/** A UserOperation with its signature slot still empty. */
export type UnsignedUserOperation = Omit<SenteUserOperation, 'signature'> & { signature: Hex };
