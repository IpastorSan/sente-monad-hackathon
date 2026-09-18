import { Inject, Injectable, Scope, UnauthorizedException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

/**
 * ---------------------------------------------------------------------------
 * THE AUTH SEAM
 *
 * Every guarded route derives the caller's identity from the authenticated
 * session and NEVER from the request body — a body-supplied userId turns "one
 * drip per user, ever" into "one drip per string the attacker invents".
 *
 * Two moving parts, and services see neither:
 *
 *   1. A guard (`SessionAuthGuard`) verifies the caller and parks a `Principal`
 *      on the request object.
 *   2. `RequestContextAuth` is the request-scoped provider that reads it back
 *      out, injected as `Auth`.
 *
 * Services take a `Principal` argument instead, so they can be tested without
 * an HTTP request and cannot accidentally reach for a header.
 *
 * SEN-37 moved this file out of `gas/auth/`, where the seam was first built for
 * `POST /gas/drip`, and renamed `GasDripAuth`/`GasDripPrincipal` to `Auth` and
 * `Principal`: the seam now carries every route in the API, and a name that
 * says "gas drip" made every other module read like it was borrowing something.
 * ---------------------------------------------------------------------------
 */
export interface Principal {
  /**
   * Stable identity of the authenticated user, and the dedupe key.
   *
   * Under session auth this is the caller's lowercase EOA address — the same
   * string agent ownership (`AgentRecord.userId`) and the drip ledger already
   * store, which is why real auth needed no migration.
   */
  userId: string;
}

/**
 * Abstract class used as the DI token, so consumers inject `Auth` without an
 * `@Inject()` decorator and the implementation is swappable per module.
 */
export abstract class Auth {
  /** The authenticated caller. Throws 401 when there is none. */
  abstract principal(): Principal;
}

/** Where the guard parks the principal on the request object. */
const PRINCIPAL_KEY = '__sentePrincipal';

type PrincipalCarrier = Record<string, unknown>;

export function attachPrincipal(request: object, principal: Principal): void {
  (request as PrincipalCarrier)[PRINCIPAL_KEY] = principal;
}

export function readPrincipal(request: object): Principal | undefined {
  const value = (request as PrincipalCarrier)[PRINCIPAL_KEY];
  return isPrincipal(value) ? value : undefined;
}

function isPrincipal(value: unknown): value is Principal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Principal).userId === 'string' &&
    (value as Principal).userId.length > 0
  );
}

/**
 * Reads the principal a guard put on the current request. Request-scoped, which
 * makes the controller request-scoped too; the ledger, sender pool and rate
 * limiter stay singletons, so no cross-request state is lost.
 */
@Injectable({ scope: Scope.REQUEST })
export class RequestContextAuth extends Auth {
  constructor(@Inject(REQUEST) private readonly request: object) {
    super();
  }

  override principal(): Principal {
    const principal = readPrincipal(this.request);
    if (!principal) {
      // Reaching here means a route used Auth without an auth guard.
      throw new UnauthorizedException('No authenticated principal on this request');
    }
    return principal;
  }
}
