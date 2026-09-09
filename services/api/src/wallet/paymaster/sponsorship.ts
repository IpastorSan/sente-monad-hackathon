import type { Address, Hex } from 'viem';

import type { SenteUserOperation } from '../bundler/bundler';

/** DI token for the sponsorship provider. */
export const SPONSORSHIP = Symbol('SPONSORSHIP');

/**
 * The paymaster fields an ERC-7677 service hands back. Every one of them goes
 * into the UserOperation the user signs, so a paymaster cannot be attached
 * after the fact.
 */
export type SponsorshipQuote = {
  paymaster: Address;
  paymasterData: Hex;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
};

/**
 * ---------------------------------------------------------------------------
 * THE SWAP SEAM
 *
 * Pimlico today; Alchemy's Gas Manager is a live option on Monad testnet (their
 * chain table lists bundler, sponsorship and ERC-20 gas as supported) and
 * `aa-sdk` takes the same viem `LocalAccount` we already have. Keeping the
 * paymaster behind this interface makes that a config change, not a rewrite.
 *
 * Both vendors implement ERC-7677 (`pm_getPaymasterStubData` /
 * `pm_getPaymasterData`), so one implementation covers both — see
 * `erc7677-sponsorship.ts`. This interface exists for the case where that stops
 * being true.
 * ---------------------------------------------------------------------------
 */
export interface Sponsorship {
  /** Provider name, for logs and for the `sponsored` flag on responses. */
  readonly name: string;

  /** False when no paymaster is configured. The service refuses rather than guesses. */
  readonly available: boolean;

  /**
   * Cheap placeholder paymaster fields, used ONLY to make gas estimation
   * account for the paymaster's own validation and postOp cost. ERC-7677 splits
   * this from the real quote precisely because estimation has to run in
   * between.
   */
  stub(userOperation: PartialUserOperation): Promise<SponsorshipQuote>;

  /** The real, signed sponsorship for a fully-sized UserOperation. */
  quote(userOperation: PartialUserOperation): Promise<SponsorshipQuote>;
}

/** What the paymaster needs to see. Gas fields may still be zero at stub time. */
export type PartialUserOperation = Omit<SenteUserOperation, 'signature'> & {
  signature?: Hex;
};

/** Raised when sponsorship was asked for and the provider could not give it. */
export class SponsorshipUnavailableError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = 'SponsorshipUnavailableError';
    this.provider = provider;
  }
}
