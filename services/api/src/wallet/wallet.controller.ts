import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Address, Hash } from 'viem';

import { Auth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import {
  ExecuteWalletOperationDto,
  PrepareWalletOperationDto,
  RegisterWalletDto,
  UserOpHashParamDto,
  type AuthorizationPayloadDto,
  type ExecuteWalletOperationResponseDto,
  type PrepareWalletOperationResponseDto,
  type UserOperationDto,
  type UserOperationStatusDto,
  type WalletAccountResponseDto,
} from './dto/wallet.dto';
import { ENTRY_POINT_ADDRESS } from './chain/kernel-account.factory';
import type { TrackedOperation } from './confirmation/operation-tracker';
import { walletRefusalToHttpException } from './wallet.errors';
import {
  WALLET_CHAIN_ID,
  WalletService,
  type PrepareResult,
  type WalletAccountView,
} from './wallet.service';

/**
 * AUTH: the shared seam rather than a second one of its own —
 * `SessionAuthGuard` (SEN-37) populates a request-scoped principal from the
 * caller's verified session token (see `wallet.module.ts`).
 *
 * The envelope on `POST /wallet/execute` is not redundant now that the session
 * is real: the token proves who is calling, and the EIP-712 signature proves
 * the owner key approved THIS operation on THIS route. A stolen token still
 * cannot move funds, which is the property worth keeping.
 */
@Controller('wallet')
@UseGuards(SessionAuthGuard)
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly auth: Auth,
  ) {}

  /** The caller's smart account. 404 until it has been registered. */
  @Get()
  async account(): Promise<WalletAccountResponseDto> {
    return this.guard(async () => toAccountResponse(await this.wallet.account(this.principal())));
  }

  /**
   * Binds the caller to their Mera owner key and returns the Kernel account it
   * derives. Idempotent for the same owner.
   */
  @Post('register')
  @HttpCode(HttpStatus.OK)
  async register(@Body() body: RegisterWalletDto): Promise<WalletAccountResponseDto> {
    return this.guard(async () =>
      toAccountResponse(await this.wallet.register(this.principal(), body.owner)),
    );
  }

  /**
   * PHASE 1 of prepare -> sign -> execute. Returns a fully-populated,
   * gas-sponsored UserOperation and the EIP-712 envelope to sign. Broadcasts
   * nothing.
   */
  @Post('prepare')
  @HttpCode(HttpStatus.OK)
  async prepare(
    @Body() body: PrepareWalletOperationDto,
  ): Promise<PrepareWalletOperationResponseDto> {
    return this.guard(async () =>
      toPrepareResponse(
        await this.wallet.prepare(this.principal(), {
          calls: body.calls.map((call) => ({
            to: call.to as Address,
            ...(call.value !== undefined ? { value: BigInt(call.value) } : {}),
            ...(call.data !== undefined ? { data: call.data as `0x${string}` } : {}),
          })),
          ...(body.sender !== undefined ? { sender: body.sender } : {}),
        }),
      ),
    );
  }

  /** PHASE 3. Verifies both signatures and submits to the bundler. */
  @Post('execute')
  @HttpCode(HttpStatus.OK)
  async execute(
    @Body() body: ExecuteWalletOperationDto,
  ): Promise<ExecuteWalletOperationResponseDto> {
    return this.guard(async () => {
      const result = await this.wallet.execute(this.principal(), {
        prepareId: body.prepareId,
        userOpSignature: body.userOpSignature as `0x${string}`,
        authorizationSignature: body.authorizationSignature as `0x${string}`,
      });
      return {
        userOpHash: result.userOpHash,
        status: result.status,
        sponsored: result.sponsored,
      };
    });
  }

  /**
   * Our own status view. The client polls this against the bundler's
   * `eth_getUserOperationReceipt` and takes whichever answers first — see
   * `confirmation/operation-tracker.ts`.
   */
  @Get('operations/:userOpHash')
  async status(@Param() params: UserOpHashParamDto): Promise<UserOperationStatusDto> {
    return this.guard(async () =>
      toStatusResponse(await this.wallet.status(params.userOpHash as Hash)),
    );
  }

  private principal() {
    return this.auth.principal();
  }

  /** Refusals become a clean 4xx/5xx with a stable `reason`; the rest fall through. */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw walletRefusalToHttpException(error);
    }
  }
}

function toAccountResponse(view: WalletAccountView): WalletAccountResponseDto {
  return {
    userId: view.userId,
    owner: view.owner,
    address: view.address,
    deployed: view.deployed,
    chainId: WALLET_CHAIN_ID,
    entryPoint: ENTRY_POINT_ADDRESS,
    sponsorshipAvailable: view.sponsorshipAvailable,
  };
}

function toPrepareResponse(result: PrepareResult): PrepareWalletOperationResponseDto {
  return {
    prepareId: result.prepareId,
    chainId: result.chainId,
    entryPoint: result.entryPoint,
    sender: result.sender,
    owner: result.owner,
    userOperation: toUserOperationDto(result.userOperation),
    userOpHash: result.userOpHash,
    sponsored: result.sponsored,
    expiresAt: result.expiresAt.toISOString(),
    authorization: toAuthorizationDto(result.authorization),
  };
}

/** bigint is not JSON-serialisable, so every numeric field crosses as a string. */
function toUserOperationDto(operation: PrepareResult['userOperation']): UserOperationDto {
  return {
    sender: operation.sender,
    nonce: operation.nonce.toString(),
    ...(operation.factory ? { factory: operation.factory } : {}),
    ...(operation.factoryData ? { factoryData: operation.factoryData } : {}),
    callData: operation.callData,
    callGasLimit: operation.callGasLimit.toString(),
    verificationGasLimit: operation.verificationGasLimit.toString(),
    preVerificationGas: operation.preVerificationGas.toString(),
    maxFeePerGas: operation.maxFeePerGas.toString(),
    maxPriorityFeePerGas: operation.maxPriorityFeePerGas.toString(),
    ...(operation.paymaster ? { paymaster: operation.paymaster } : {}),
    ...(operation.paymasterVerificationGasLimit !== undefined
      ? { paymasterVerificationGasLimit: operation.paymasterVerificationGasLimit.toString() }
      : {}),
    ...(operation.paymasterPostOpGasLimit !== undefined
      ? { paymasterPostOpGasLimit: operation.paymasterPostOpGasLimit.toString() }
      : {}),
    ...(operation.paymasterData ? { paymasterData: operation.paymasterData } : {}),
    signature: operation.signature,
  };
}

function toAuthorizationDto(payload: PrepareResult['authorization']): AuthorizationPayloadDto {
  return {
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: {
      ...payload.message,
      // uint64 as a string for the same reason as above; viem parses it back.
      expiresAt: payload.message.expiresAt.toString(),
    },
  };
}

function toStatusResponse(tracked: TrackedOperation): UserOperationStatusDto {
  return {
    userOpHash: tracked.userOpHash,
    status: tracked.status,
    ...(tracked.transactionHash ? { transactionHash: tracked.transactionHash } : {}),
    ...(tracked.blockNumber !== undefined ? { blockNumber: tracked.blockNumber.toString() } : {}),
    ...(tracked.actualGasCost !== undefined
      ? { actualGasCost: tracked.actualGasCost.toString() }
      : {}),
    ...(tracked.status === 'unknown'
      ? {}
      : { sender: tracked.sender, sponsored: tracked.sponsored }),
  };
}
