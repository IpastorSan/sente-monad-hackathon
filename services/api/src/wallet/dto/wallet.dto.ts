import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEthereumAddress,
  IsHexadecimal,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** 0x-prefixed, even-length hex. `IsHexadecimal` alone accepts neither. */
const HEX = /^0x([0-9a-fA-F]{2})*$/;
const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{2,4000}$/;

/**
 * NOTE on identity, in all three DTOs: there is deliberately no `userId` field.
 * Identity comes from the auth guard (`gas/auth/gas-drip-auth.ts`), and the
 * global ValidationPipe runs with `forbidNonWhitelisted`, so a request that
 * smuggles one in is rejected with a 400 rather than silently ignored.
 */

export class RegisterWalletDto {
  /** The Mera EOA. The smart account address is derived from it, never sent. */
  @IsString()
  @IsEthereumAddress()
  owner!: string;
}

export class CallDto {
  @IsString()
  @IsEthereumAddress()
  to!: string;

  /**
   * Wei, as a decimal string. bigint is not JSON-serialisable, and a JS number
   * silently loses precision above 2^53, so the wire type is a string in both
   * directions.
   */
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  value?: string;

  @IsOptional()
  @Matches(HEX, { message: 'data must be 0x-prefixed, even-length hex' })
  @MaxLength(2 + 2 * 128 * 1024)
  data?: string;
}

export class PrepareWalletOperationDto {
  @IsArray()
  @ArrayMinSize(1)
  // A batch this long is a bug, and every leg costs gas the paymaster pays.
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => CallDto)
  calls!: CallDto[];

  /**
   * OPTIONAL and never trusted. When present it is compared against the sender
   * the server resolves from the authenticated user, and a mismatch is refused
   * with `sender_mismatch`. Sending it is how a client finds out its cached
   * address has drifted — see `store/smart-account-registry.ts`.
   */
  @IsOptional()
  @IsString()
  @IsEthereumAddress()
  sender?: string;
}

export class ExecuteWalletOperationDto {
  @IsString()
  @MaxLength(128)
  prepareId!: string;

  /** Kernel's ECDSA validator signature over the UserOperation hash. */
  @Matches(SIGNATURE, { message: 'userOpSignature must be hex' })
  userOpSignature!: string;

  /** EIP-712 signature over the authorization envelope, by the owner key. */
  @Matches(SIGNATURE, { message: 'authorizationSignature must be hex' })
  authorizationSignature!: string;
}

export class UserOpHashParamDto {
  @IsHexadecimal()
  @Matches(HEX_32_BYTES, { message: 'userOpHash must be a 32-byte hex hash' })
  userOpHash!: string;
}

// ---------------------------------------------------------------------------
// Responses. Every bigint crosses the wire as a decimal string.
// ---------------------------------------------------------------------------

export interface WalletAccountResponseDto {
  userId: string;
  owner: string;
  address: string;
  /** Whether the Kernel account has been deployed on chain yet. */
  deployed: boolean;
  chainId: number;
  entryPoint: string;
  /** Whether a paymaster is configured AND willing. Never optimistic. */
  sponsorshipAvailable: boolean;
}

export interface UserOperationDto {
  sender: string;
  nonce: string;
  factory?: string;
  factoryData?: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster?: string;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
  paymasterData?: string;
  signature: string;
}

export interface AuthorizationPayloadDto {
  domain: { name: string; version: string; chainId: number };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: {
    method: string;
    path: string;
    owner: string;
    sender: string;
    userOpHash: string;
    bodyHash: string;
    nonce: string;
    expiresAt: string;
  };
}

export interface PrepareWalletOperationResponseDto {
  prepareId: string;
  chainId: number;
  entryPoint: string;
  sender: string;
  owner: string;
  userOperation: UserOperationDto;
  userOpHash: string;
  /** True only when a paymaster actually quoted this operation. */
  sponsored: boolean;
  /** ISO-8601. After this the prepare id is dead and must be re-prepared. */
  expiresAt: string;
  authorization: AuthorizationPayloadDto;
}

export interface ExecuteWalletOperationResponseDto {
  userOpHash: string;
  status: UserOperationStatusDto['status'];
  sponsored: boolean;
}

export interface UserOperationStatusDto {
  userOpHash: string;
  /**
   * `pending`  submitted, no receipt yet
   * `included` mined AND the UserOperation itself succeeded
   * `reverted` mined but the UserOperation reverted — a bundle transaction can
   *            succeed while the operation inside it fails, so this is a
   *            distinct state and not an error
   * `unknown`  we have no record of this hash
   */
  status: 'pending' | 'included' | 'reverted' | 'unknown';
  transactionHash?: string;
  blockNumber?: string;
  actualGasCost?: string;
  sender?: string;
  sponsored?: boolean;
}
