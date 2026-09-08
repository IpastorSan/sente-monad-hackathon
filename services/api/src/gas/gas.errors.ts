import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Every way a drip can be refused. These strings are part of the API contract —
 * the mobile app branches on them — so treat renames as breaking changes.
 */
export const DRIP_REFUSAL_REASONS = [
  'rate_limited',
  'user_already_dripped',
  'address_already_dripped',
  'address_already_funded',
  'daily_cap_reached',
  'faucet_unconfigured',
] as const;

export type DripRefusalReason = (typeof DRIP_REFUSAL_REASONS)[number];

/**
 * A refusal is a domain outcome, not an HTTP concern: the service throws this
 * so it stays testable without a request context, and the controller maps it to
 * a status code exactly once (`refusalToHttpException`).
 */
export class GasDripRefusedError extends Error {
  constructor(
    readonly reason: DripRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'GasDripRefusedError';
  }
}

const REFUSAL_STATUS: Record<DripRefusalReason, HttpStatus> = {
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  user_already_dripped: HttpStatus.CONFLICT,
  address_already_dripped: HttpStatus.CONFLICT,
  address_already_funded: HttpStatus.CONFLICT,
  // The faucet is fine, it is just out of budget for today / not set up.
  daily_cap_reached: HttpStatus.SERVICE_UNAVAILABLE,
  faucet_unconfigured: HttpStatus.SERVICE_UNAVAILABLE,
};

export function refusalStatus(reason: DripRefusalReason): HttpStatus {
  return REFUSAL_STATUS[reason];
}

/** Maps a refusal to a clean 4xx/503. Anything else is rethrown untouched. */
export function refusalToHttpException(error: unknown): unknown {
  if (!(error instanceof GasDripRefusedError)) {
    return error;
  }
  const statusCode = refusalStatus(error.reason);
  return new HttpException(
    { statusCode, reason: error.reason, message: error.message },
    statusCode,
  );
}
