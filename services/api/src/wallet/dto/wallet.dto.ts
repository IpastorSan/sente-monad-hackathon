import type { AuthorizationPayload } from '@sente/mandate';
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
 * Identity comes from the auth guard (`auth/principal.ts`), and the
 * global ValidationPipe runs with `forbidNonWhitelisted`, so a request that
 * smuggles one in is rejected with a 400 rather than silently ignored.
 */

export class RegisterWalletDto {
  /** The Mera EOA. The smart account address is derived from it, never sent. */
  @IsString()
  @IsEthereumAddress()
  owner!: string;
}

/** Base64 (standard alphabet, padded). A P-256 SPKI DER is 91 bytes -> 124 chars. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class RegisterUserWalletDto {
  /**
   * The PUBLIC half of the phone's `device` P-256 key (SEN-38), base64 SPKI
   * DER — exactly what `key_quorums.public_keys[]` takes. It becomes the OWNER
   * of the Privy wallet, so the server can never sign for it.
   *
   * The shape is checked twice on purpose: here, cheaply, and again in
   * `agents/privy/user-wallet.ts`, which actually decodes it and checks the
   * curve. A key the phone cannot sign with owns the wallet forever.
   */
  @IsString()
  @MaxLength(512)
  @Matches(BASE64, { message: 'devicePublicKey must be base64 (SPKI DER of a P-256 public key)' })
  devicePublicKey!: string;
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

/**
 * `POST /wallet/send/prepare` (SEN-42).
 *
 * Three fields, each checked again in the service against something real: the
 * recipient against the caller's own agents, the token against the sendable
 * list, the amount for being a positive whole number of atoms. What is here is
 * only shape — a 400 before any of that is cheaper for everyone.
 */
export class PrepareSendDto {
  /** The recipient: the caller's own wallet, or one of the caller's agents. */
  @IsString()
  @IsEthereumAddress()
  to!: string;

  /** The token's contract, or the zero address for native MON. */
  @IsString()
  @IsEthereumAddress()
  token!: string;

  /**
   * ATOMS, as a decimal string — `1000000` is one USDC, not one million. A
   * decimal-shifted figure would need this server to guess a token's decimals
   * from a string, and a wrong guess is a transfer of the wrong size.
   */
  @IsNumberString({ no_symbols: true })
  @MaxLength(78)
  amount!: string;
}

/** `POST /wallet/send/execute` (SEN-42): the prepare id and the phone's signature. */
export class ExecuteSendDto {
  @IsString()
  @MaxLength(128)
  prepareId!: string;

  /**
   * The device key's signature over the payload `prepare` returned. Forwarded to
   * Privy verbatim — this server cannot produce one and does not check it: a
   * signature over other bytes is refused by Privy with a 401, which is the
   * check that matters. Ours would be a second opinion about a key we do not
   * hold.
   */
  @IsString()
  @MaxLength(512)
  // The same base64 as a device PUBLIC key above; a DER ECDSA P-256 signature
  // is ~96 bytes of it.
  @Matches(BASE64, { message: 'signature must be base64 (DER ECDSA P-256)' })
  signature!: string;
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

export interface TokenBalanceDto {
  symbol: string;
  /** The ERC-20, or the zero address for native MON. */
  address: string;
  decimals: number;
  /** Atoms, as a decimal string: bigint is not JSON. */
  raw: string;
  /** The same number decimal-shifted, e.g. "1.5" USDC. What the app shows. */
  amount: string;
}

/** `GET /wallet` and `POST /wallet/register` — the user's Privy wallet (SEN-40). */
export interface UserWalletResponseDto {
  userId: string;
  /** Privy's wallet id. SEN-42 addresses its `/rpc` with this. */
  walletId: string;
  address: string;
  /**
   * The 1-key quorum that owns the wallet. Echoed because recovery (adding a
   * second device key) is a PATCH to THIS id, and only the device key can
   * authorize it.
   */
  ownerQuorumId: string;
  /** Echoed so the phone can confirm the server bound the key it just derived. */
  devicePublicKey: string;
  chainId: number;
  /** ISO-8601. */
  createdAt: string;
  /** MON, USDC and AUSD, in that order. */
  balances: TokenBalanceDto[];
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

/** What a prepared or submitted transfer is, in the API's words (SEN-42). */
export interface SendSummaryDto {
  from: string;
  to: string;
  /** `{ kind: 'self' }`, or the agent this funds. */
  recipient: { kind: 'self' } | { kind: 'agent'; agentId: string; agentName: string };
  symbol: string;
  tokenAddress: string;
  decimals: number;
  /** Atoms, as a decimal string. */
  atoms: string;
  /** The same amount decimal-shifted, for reading. */
  amount: string;
  chainId: number;
  sponsored: boolean;
}

export interface PrepareSendResponseDto {
  prepareId: string;
  /**
   * The exact Privy authorization payload to sign.
   *
   * REBUILD IT FROM THE INTENT BEFORE SIGNING. It is composed by this server,
   * and signing it unread would hand the server the authority the device key
   * exists to withhold — `apps/mobile/src/wallet/send.ts` is that check.
   */
  payload: AuthorizationPayload;
  /** ISO-8601. After this the prepare id is dead and must be prepared again. */
  expiresAt: string;
  summary: SendSummaryDto;
}

export interface SendResponseDto {
  /**
   * The USER OPERATION hash (gotcha 8), which is what a sponsored send returns.
   * Poll `GET /wallet/operations/:userOpHash` for it — that reads the
   * operation's own success flag, not the carrying transaction's status.
   */
  userOpHash?: string;
  /** Only when Privy broadcast a plain transaction instead of sponsoring one. */
  transactionHash?: string;
  /** Privy's own id for the attempt. Not a chain hash. */
  transactionId?: string;
  status: 'pending' | 'unknown';
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
