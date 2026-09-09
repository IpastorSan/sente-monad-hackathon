import { Logger } from '@nestjs/common';
import { createClient, http, hexToBigInt, numberToHex, type Address, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';

import { ENTRY_POINT } from '../bundler/pimlico-bundler';
import {
  SponsorshipUnavailableError,
  type PartialUserOperation,
  type Sponsorship,
  type SponsorshipQuote,
} from './sponsorship';

/** ERC-7677's wire shape: every numeric field is hex, and casing is camelCase. */
type PaymasterResponse = {
  paymaster?: Address;
  paymasterData?: Hex;
  paymasterVerificationGasLimit?: Hex;
  paymasterPostOpGasLimit?: Hex;
};

type Erc7677Method = 'pm_getPaymasterStubData' | 'pm_getPaymasterData';

/**
 * ERC-7677 paymaster client, covering Pimlico and Alchemy with one
 * implementation.
 *
 * The only vendor-specific part is the `context` object in the fourth
 * parameter: Pimlico wants `{ sponsorshipPolicyId }` and Alchemy wants
 * `{ policyId }`. Everything else is the standard.
 */
export class Erc7677Sponsorship implements Sponsorship {
  readonly name: string;
  readonly available = true;

  private readonly logger = new Logger(Erc7677Sponsorship.name);
  private readonly rpc: ReturnType<typeof createClient>;
  private readonly context: Record<string, string>;

  constructor(provider: 'pimlico' | 'alchemy', url: string, policyId: string) {
    this.name = provider;
    this.rpc = createClient({ chain: monadTestnet, transport: http(url, { retryCount: 2 }) });
    this.context = provider === 'alchemy' ? { policyId } : { sponsorshipPolicyId: policyId };
  }

  stub(userOperation: PartialUserOperation): Promise<SponsorshipQuote> {
    return this.call('pm_getPaymasterStubData', userOperation);
  }

  quote(userOperation: PartialUserOperation): Promise<SponsorshipQuote> {
    return this.call('pm_getPaymasterData', userOperation);
  }

  private async call(
    method: Erc7677Method,
    userOperation: PartialUserOperation,
  ): Promise<SponsorshipQuote> {
    let response: PaymasterResponse;
    try {
      response = await this.rpc.request<{
        method: Erc7677Method;
        Parameters: [Record<string, unknown>, Address, Hex, Record<string, string>];
        ReturnType: PaymasterResponse;
      }>({
        method,
        params: [
          toWire(userOperation),
          ENTRY_POINT.address,
          numberToHex(monadTestnet.id),
          this.context,
        ],
      });
    } catch (error) {
      throw new SponsorshipUnavailableError(this.name, `${method} failed: ${describe(error)}`);
    }

    if (!response.paymaster || !response.paymasterData) {
      // A provider that answers without a paymaster address is declining to
      // sponsor. Treating that as "sponsored" would produce a UserOperation the
      // account has to pay for, silently.
      throw new SponsorshipUnavailableError(
        this.name,
        `${method} returned no paymaster; the policy declined this operation`,
      );
    }

    this.logger.debug(`${method} -> paymaster=${response.paymaster}`);
    return {
      paymaster: response.paymaster,
      paymasterData: response.paymasterData,
      ...(response.paymasterVerificationGasLimit
        ? { paymasterVerificationGasLimit: hexToBigInt(response.paymasterVerificationGasLimit) }
        : {}),
      ...(response.paymasterPostOpGasLimit
        ? { paymasterPostOpGasLimit: hexToBigInt(response.paymasterPostOpGasLimit) }
        : {}),
    };
  }
}

/**
 * No paymaster configured.
 *
 * Deliberately not a silent pass-through: `available === false` makes the
 * service report `sponsored: false` on every prepared operation, so nothing in
 * this repo can claim gas is sponsored when it is not.
 */
export class UnconfiguredSponsorship implements Sponsorship {
  readonly name = 'none';
  readonly available = false;

  stub(): Promise<SponsorshipQuote> {
    return Promise.reject(this.refuse());
  }

  quote(): Promise<SponsorshipQuote> {
    return Promise.reject(this.refuse());
  }

  private refuse(): SponsorshipUnavailableError {
    return new SponsorshipUnavailableError(
      this.name,
      'No paymaster configured; set PIMLICO_BUNDLER_URL and PIMLICO_SPONSORSHIP_POLICY_ID ' +
        '(or ALCHEMY_RPC_URL and ALCHEMY_GAS_POLICY_ID)',
    );
  }
}

/** bigint -> hex for the wire, dropping the fields a paymaster must not see. */
function toWire(userOperation: PartialUserOperation): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    sender: userOperation.sender,
    nonce: numberToHex(userOperation.nonce),
    callData: userOperation.callData,
    callGasLimit: numberToHex(userOperation.callGasLimit),
    verificationGasLimit: numberToHex(userOperation.verificationGasLimit),
    preVerificationGas: numberToHex(userOperation.preVerificationGas),
    maxFeePerGas: numberToHex(userOperation.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(userOperation.maxPriorityFeePerGas),
  };
  if (userOperation.factory) {
    wire.factory = userOperation.factory;
    wire.factoryData = userOperation.factoryData;
  }
  return wire;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
