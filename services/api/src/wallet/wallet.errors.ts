import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Every way a wallet request can be refused. These strings are part of the API
 * contract — the mobile app branches on them — so treat renames as breaking
 * changes. Mirrors `gas/gas.errors.ts`.
 */
export const WALLET_REFUSAL_REASONS = [
  /** No `POST /wallet/register` for this user yet. */
  'account_not_registered',
  /** The user is already bound to a different owner key. First write wins. */
  'owner_conflict',
  /**
   * The client supplied a sender that is not the one the server resolved from
   * the authenticated user. Always a bug or an attack; never tolerated.
   */
  'sender_mismatch',
  /** Unknown, expired or already-used prepare id. */
  'prepare_expired',
  /** The authorization envelope did not verify against the bound owner key. */
  'invalid_authorization',
  /** The paymaster is not configured, or declined this operation. */
  'sponsorship_unavailable',
  /** The bundler rejected the UserOperation (AA2x/AA3x, fee too low, ...). */
  'bundler_rejected',
  /**
   * `devicePublicKey` is not the base64 SPKI DER of a P-256 public key — the
   * one encoding a Privy key quorum accepts (SEN-40).
   */
  'invalid_device_key',
  /**
   * This user already has a wallet owned by a DIFFERENT device key. A Privy
   * wallet's address is not derived from its owner, so minting a second one
   * would strand the first; see `store/user-wallet-registry.ts`.
   */
  'device_key_mismatch',
  /** No Privy credentials, so no user wallet can be created. */
  'user_wallets_unconfigured',
  /** Privy itself refused or was unreachable. */
  'user_wallet_provider_failed',
] as const;

export type WalletRefusalReason = (typeof WALLET_REFUSAL_REASONS)[number];

/**
 * A refusal is a domain outcome, not an HTTP concern: the service throws this
 * so it stays testable without a request context, and the controller maps it to
 * a status code exactly once.
 */
export class WalletRefusedError extends Error {
  readonly reason: WalletRefusalReason;

  constructor(reason: WalletRefusalReason, message: string) {
    super(message);
    this.name = 'WalletRefusedError';
    this.reason = reason;
  }
}

const REFUSAL_STATUS: Record<WalletRefusalReason, HttpStatus> = {
  account_not_registered: HttpStatus.NOT_FOUND,
  owner_conflict: HttpStatus.CONFLICT,
  // 403, not 400: the request is well-formed, the caller is just not allowed to
  // spend from that account.
  sender_mismatch: HttpStatus.FORBIDDEN,
  prepare_expired: HttpStatus.GONE,
  invalid_authorization: HttpStatus.UNAUTHORIZED,
  sponsorship_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  bundler_rejected: HttpStatus.BAD_GATEWAY,
  invalid_device_key: HttpStatus.BAD_REQUEST,
  // 409 for the same reason `owner_conflict` is: the request is valid, it just
  // contradicts a binding that already exists and will not be overwritten.
  device_key_mismatch: HttpStatus.CONFLICT,
  user_wallets_unconfigured: HttpStatus.SERVICE_UNAVAILABLE,
  user_wallet_provider_failed: HttpStatus.BAD_GATEWAY,
};

export function walletRefusalStatus(reason: WalletRefusalReason): HttpStatus {
  return REFUSAL_STATUS[reason];
}

/** Maps a refusal to a clean 4xx/5xx. Anything else is rethrown untouched. */
export function walletRefusalToHttpException(error: unknown): unknown {
  if (!(error instanceof WalletRefusedError)) {
    return error;
  }
  const statusCode = walletRefusalStatus(error.reason);
  return new HttpException(
    { statusCode, reason: error.reason, message: error.message },
    statusCode,
  );
}
