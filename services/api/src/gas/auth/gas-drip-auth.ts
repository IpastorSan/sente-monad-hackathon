/**
 * The auth seam moved to `src/auth/principal.ts` in SEN-37, where `GasDripAuth`
 * became `Auth` and `GasDripPrincipal` became `Principal`: it was built here
 * for `POST /gas/drip`, and now carries every route in the API.
 *
 * This file survives only because `agents/leaderboard/` imports `readPrincipal`
 * from this path and SEN-37 could not edit that directory. Import from
 * `src/auth/principal.ts`; when the leaderboard route is rebound to
 * `SessionAuthGuard`, delete this file with it.
 *
 * @deprecated Use `src/auth/principal.ts`.
 */
export { readPrincipal, type Principal } from '../../auth/principal';
