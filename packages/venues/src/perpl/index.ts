/**
 * `@sente/venues/perpl` — the Perpl perps adapter.
 *
 * A subpath rather than part of the root entry, so consumers of the shared
 * interface do not load viem and noble just to import a type.
 */
export * from './decimal.ts';
export * from './enroll.ts';
export * from './onboarding.ts';
export * from './rest.ts';
export * from './signing.ts';
export * from './trading.ts';
export * from './venue.ts';
export * from './wire.ts';
export * from './ws.ts';
