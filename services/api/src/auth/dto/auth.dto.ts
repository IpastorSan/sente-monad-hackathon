import { IsEthereumAddress, IsString, Matches, MaxLength } from 'class-validator';

/**
 * A secp256k1 signature as hex: 65 bytes for `r,s,v`, and longer for the ERC-2098
 * or wrapped forms viem also accepts. Bounded so a multi-megabyte body cannot
 * reach the verifier, and hex-only so nothing else can.
 */
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]+$/;
const SIGNATURE_MAX = 2_048;

export class ChallengeRequestDto {
  @IsString()
  @IsEthereumAddress()
  address!: string;
}

/**
 * No nonce and no message: the server holds the challenge it issued for this
 * address and signs nothing the client chose. A client-supplied message would
 * turn sign-in into "sign anything you like", which is the attack the nonce
 * exists to prevent.
 */
export class SessionRequestDto {
  @IsString()
  @IsEthereumAddress()
  address!: string;

  @IsString()
  @MaxLength(SIGNATURE_MAX)
  @Matches(SIGNATURE_PATTERN, { message: 'signature must be 0x-prefixed hex' })
  signature!: string;
}

export interface ChallengeResponseDto {
  address: string;
  nonce: string;
  /** The exact string to sign, as EIP-191 personal_sign text. */
  message: string;
  /** ISO 8601. */
  expiresAt: string;
}

export interface SessionResponseDto {
  address: string;
  /** Send it as `authorization: Bearer <token>`. */
  token: string;
  /** ISO 8601. */
  expiresAt: string;
}
