/**
 * The wire shapes of `/trade/perpl/enroll/*` (SEN-100, plan M-T18,
 * "Architecture §4"). Validated by the global ValidationPipe; nothing here
 * names a user — identity is the session subject.
 */
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, IsUUID, Matches } from 'class-validator';
import type { Hex } from 'viem';

/** Base64, as a DER ECDSA P-256 signature from the device key crosses. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** `POST /trade/perpl/enroll/prepare`. */
export class PerplEnrollPrepareDto {
  /** The phone's Ed25519 trade key (HKDF, D2): `0x` + 32 bytes of hex. */
  @Matches(/^0x[0-9a-fA-F]{64}$/, { message: 'publicKeyHex must be 0x + 64 hex characters' })
  publicKeyHex!: Hex;

  /** Shown in the user's Perpl key list. Printable ASCII, so it reads the same everywhere. */
  @IsString()
  @Matches(/^[\x20-\x7e]{1,40}$/, { message: 'label must be 1-40 printable ASCII characters' })
  label!: string;
}

/** `POST /trade/perpl/enroll/commit`. */
export class PerplEnrollCommitDto {
  @IsUUID('4')
  prepareId!: string;

  /** One device signature per prepared item, by index: `[trade, read]`. */
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsString({ each: true })
  @Matches(BASE64, { each: true, message: 'each signature must be base64 (DER ECDSA P-256)' })
  signatures!: string[];

  /** The trade key's Ed25519 proof-of-possession over the trade item's EIP-712 digest. */
  @Matches(/^0x[0-9a-fA-F]{128}$/, { message: 'popSignature must be 0x + 128 hex characters' })
  popSignature!: Hex;
}
