import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Every way a credits request can be refused. These strings are part of the API
 * contract — the mobile app branches on them — so treat renames as breaking
 * changes. Mirrors `gas/gas.errors.ts` and `wallet/wallet.errors.ts`.
 */
export const CREDITS_REFUSAL_REASONS = [
  /** OPENROUTER_MANAGEMENT_KEY is not set, so no key can be minted or read. */
  'credits_unconfigured',
  /** No `POST /credits/provision` for this user yet. */
  'not_provisioned',
  /** OpenRouter refused or failed to mint the user's key. */
  'provision_failed',
  /** The key exists but OpenRouter could not report its limit and usage. */
  'status_unavailable',
] as const;

export type CreditsRefusalReason = (typeof CREDITS_REFUSAL_REASONS)[number];

/**
 * A refusal is a domain outcome, not an HTTP concern: the service throws this
 * so it stays testable without a request context, and the controller maps it to
 * a status code exactly once.
 */
export class CreditsRefusedError extends Error {
  readonly reason: CreditsRefusalReason;

  constructor(reason: CreditsRefusalReason, message: string) {
    super(message);
    this.name = 'CreditsRefusedError';
    this.reason = reason;
  }
}

const REFUSAL_STATUS: Record<CreditsRefusalReason, HttpStatus> = {
  credits_unconfigured: HttpStatus.SERVICE_UNAVAILABLE,
  not_provisioned: HttpStatus.NOT_FOUND,
  // Upstream failures: the request was fine, OpenRouter was not.
  provision_failed: HttpStatus.BAD_GATEWAY,
  status_unavailable: HttpStatus.BAD_GATEWAY,
};

export function creditsRefusalStatus(reason: CreditsRefusalReason): HttpStatus {
  return REFUSAL_STATUS[reason];
}

/** Maps a refusal to a clean 4xx/5xx. Anything else is rethrown untouched. */
export function creditsRefusalToHttpException(error: unknown): unknown {
  if (!(error instanceof CreditsRefusedError)) {
    return error;
  }
  const statusCode = creditsRefusalStatus(error.reason);
  return new HttpException(
    { statusCode, reason: error.reason, message: error.message },
    statusCode,
  );
}
