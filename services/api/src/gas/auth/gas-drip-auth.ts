import { Inject, Injectable, Scope, UnauthorizedException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

/**
 * ---------------------------------------------------------------------------
 * AUTH SEAM
 *
 * `POST /gas/drip` must derive the caller's identity from the authenticated
 * session and NEVER from the request body — a body-supplied userId turns "one
 * drip per user, ever" into "one drip per string the attacker invents".
 *
 * MOV-251 lands real Mera passkey auth. Until it does, this seam has exactly
 * two moving parts and both are meant to be replaced wholesale:
 *
 *   1. `PlaceholderGasDripAuthGuard` — populates the request-scoped principal.
 *      Today it trusts an `x-sente-user-id` header. It refuses to run under
 *      NODE_ENV=production.
 *   2. `RequestContextGasDripAuth` — the request-scoped provider that reads
 *      that principal back out.
 *
 * `GasDripService` never sees either: it takes a `GasDripPrincipal` argument.
 * When MOV-251 arrives, swap the guard for the Mera session guard and bind
 * `GasDripAuth` to an implementation that reads the verified session. No other
 * file in `gas/` needs to change.
 * ---------------------------------------------------------------------------
 */
export interface GasDripPrincipal {
  /** Stable identity of the authenticated user. The dedupe key. */
  userId: string;
}

/**
 * Abstract class used as the DI token, so consumers inject `GasDripAuth`
 * without an `@Inject()` decorator and the implementation is swappable in
 * `GasModule`.
 */
export abstract class GasDripAuth {
  /** The authenticated caller. Throws 401 when there is none. */
  abstract principal(): GasDripPrincipal;
}

/** Where the guard parks the principal on the request object. */
const PRINCIPAL_KEY = '__senteGasDripPrincipal';

type PrincipalCarrier = Record<string, unknown>;

export function attachPrincipal(request: object, principal: GasDripPrincipal): void {
  (request as PrincipalCarrier)[PRINCIPAL_KEY] = principal;
}

export function readPrincipal(request: object): GasDripPrincipal | undefined {
  const value = (request as PrincipalCarrier)[PRINCIPAL_KEY];
  return isPrincipal(value) ? value : undefined;
}

function isPrincipal(value: unknown): value is GasDripPrincipal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as GasDripPrincipal).userId === 'string' &&
    (value as GasDripPrincipal).userId.length > 0
  );
}

/**
 * Reads the principal a guard put on the current request. Request-scoped, which
 * makes the controller request-scoped too; the ledger, sender pool and rate
 * limiter stay singletons, so no cross-request state is lost.
 */
@Injectable({ scope: Scope.REQUEST })
export class RequestContextGasDripAuth extends GasDripAuth {
  constructor(@Inject(REQUEST) private readonly request: object) {
    super();
  }

  override principal(): GasDripPrincipal {
    const principal = readPrincipal(this.request);
    if (!principal) {
      // Reaching here means a route used GasDripAuth without an auth guard.
      throw new UnauthorizedException('No authenticated principal on this request');
    }
    return principal;
  }
}
