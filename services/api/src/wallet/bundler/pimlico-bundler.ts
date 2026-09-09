import { Logger } from '@nestjs/common';
import { createClient, http, hexToBigInt, type Hash, type Hex } from 'viem';
import {
  createBundlerClient,
  entryPoint07Abi,
  type UserOperationReceipt,
} from 'viem/account-abstraction';
import { monadTestnet } from 'viem/chains';

import type {
  Bundler,
  SenteUserOperation,
  UserOperationFees,
  UserOperationGasEstimate,
} from './bundler';

type GasPriceTier = { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };

/**
 * Pimlico's ERC-4337 bundler.
 *
 * Works against both the keyless public endpoint and a keyed one; the only
 * difference is that sponsorship methods refuse without a key (see
 * `wallet.config.ts`). The bundler methods themselves are standard, so an
 * Alchemy bundler URL would work here unchanged apart from `fees()`.
 */
export class PimlicoBundler implements Bundler {
  readonly name = 'pimlico';

  private readonly logger = new Logger(PimlicoBundler.name);
  private readonly client: ReturnType<typeof createBundlerClient>;
  private readonly rpc: ReturnType<typeof createClient>;

  constructor(url: string) {
    const transport = http(url, { retryCount: 2 });
    this.client = createBundlerClient({ chain: monadTestnet, transport });
    // A plain client for the vendor-specific methods viem does not model.
    this.rpc = createClient({ chain: monadTestnet, transport });
  }

  async fees(): Promise<UserOperationFees> {
    try {
      const price = await this.rpc.request<{
        method: 'pimlico_getUserOperationGasPrice';
        Parameters: [];
        ReturnType: { slow: GasPriceTier; standard: GasPriceTier; fast: GasPriceTier };
      }>({ method: 'pimlico_getUserOperationGasPrice', params: [] });

      // `standard` rather than `fast`: on Monad the bid multiplies the gas
      // LIMIT, so overbidding is money genuinely spent. Blocks are ~300ms and
      // testnet is not congested, so the extra tier buys nothing.
      return {
        maxFeePerGas: hexToBigInt(price.standard.maxFeePerGas),
        maxPriorityFeePerGas: hexToBigInt(price.standard.maxPriorityFeePerGas),
      };
    } catch (error) {
      // Not fatal, and not Pimlico-specific: any EIP-1559 chain answers these.
      this.logger.warn(
        `pimlico_getUserOperationGasPrice unavailable (${describe(error)}); falling back to eth_* fees`,
      );
      const [maxPriorityFeePerGas, block] = await Promise.all([
        this.rpc.request<{ method: 'eth_maxPriorityFeePerGas'; Parameters: []; ReturnType: Hex }>({
          method: 'eth_maxPriorityFeePerGas',
          params: [],
        }),
        this.rpc.request<{
          method: 'eth_getBlockByNumber';
          Parameters: ['latest', false];
          ReturnType: { baseFeePerGas: Hex | null };
        }>({ method: 'eth_getBlockByNumber', params: ['latest', false] }),
      ]);
      const tip = hexToBigInt(maxPriorityFeePerGas);
      const base = block.baseFeePerGas === null ? 0n : hexToBigInt(block.baseFeePerGas);
      return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip };
    }
  }

  async estimate(
    userOperation: Omit<
      SenteUserOperation,
      'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas'
    > &
      Partial<UserOperationGasEstimate>,
  ): Promise<UserOperationGasEstimate> {
    const estimate = await this.client.estimateUserOperationGas({
      entryPointAddress: ENTRY_POINT_ADDRESS,
      ...userOperation,
    } as Parameters<typeof this.client.estimateUserOperationGas>[0]);

    // Returned verbatim, with NO safety multiplier. On Monad an inflated limit
    // is money spent rather than reserved (CLAUDE.md gotcha 4), and the bundler
    // has already simulated the exact operation. Pad only with a measured
    // number, per call, if one is ever needed.
    return {
      callGasLimit: estimate.callGasLimit,
      verificationGasLimit: estimate.verificationGasLimit,
      preVerificationGas: estimate.preVerificationGas,
      ...(estimate.paymasterVerificationGasLimit !== undefined
        ? { paymasterVerificationGasLimit: estimate.paymasterVerificationGasLimit }
        : {}),
      ...(estimate.paymasterPostOpGasLimit !== undefined
        ? { paymasterPostOpGasLimit: estimate.paymasterPostOpGasLimit }
        : {}),
    };
  }

  send(userOperation: SenteUserOperation): Promise<Hash> {
    return this.client.sendUserOperation({
      entryPointAddress: ENTRY_POINT_ADDRESS,
      ...userOperation,
    } as Parameters<typeof this.client.sendUserOperation>[0]);
  }

  async receipt(userOpHash: Hash): Promise<UserOperationReceipt | null> {
    try {
      return await this.client.getUserOperationReceipt({ hash: userOpHash });
    } catch {
      // viem throws `UserOperationReceiptNotFoundError` while the operation is
      // still in the mempool. That is the normal case during polling, not an
      // error worth surfacing.
      return null;
    }
  }
}

/** EntryPoint v0.7, confirmed deployed on Monad testnet. */
const ENTRY_POINT_ADDRESS = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;

/** Kept exported so the module wiring does not re-import viem's constant. */
export const ENTRY_POINT = {
  address: ENTRY_POINT_ADDRESS,
  version: '0.7',
  abi: entryPoint07Abi,
} as const;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
