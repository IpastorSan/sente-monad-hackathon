/**
 * A mandate `expiresAt` (unix seconds) a year from when the suite loads.
 *
 * `AgentsService` refuses a mandate whose `expiresAt` is behind the real clock,
 * so a spec that hires through it with a fixed epoch (it used to be
 * `2_000_000_000`) starts failing on its own the day that epoch passes
 * (SEN-140). Specs that pin their own clock can keep a fixed value.
 */
export const EXPIRES_IN_A_YEAR = Math.floor(Date.now() / 1000) + 365 * 86_400;
