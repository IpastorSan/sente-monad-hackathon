import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';

/** DI token for the resolved, validated auth configuration. */
export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

/** Bytes of `AUTH_SESSION_SECRET`. 32 = the HMAC-SHA256 block's worth of key. */
export const SESSION_SECRET_BYTES = 32;

/** How long a signed challenge stays spendable. Not configurable on purpose. */
export const CHALLENGE_TTL_S = 300;

export const DEFAULT_SESSION_TTL_S = 86_400;
/** A session token cannot outlive a week; past that, sign in again. */
export const MAX_SESSION_TTL_S = 7 * 86_400;

export type AuthMode =
  /** Only a verified session token authenticates. The only production mode. */
  | 'session'
  /** Session tokens PLUS the legacy `x-sente-user-id` header. Never production. */
  | 'placeholder';

export interface AuthConfig {
  mode: AuthMode;
  /** HMAC key for session tokens. Always present — see `loadAuthConfig`. */
  sessionSecret: Buffer;
  /** True when the secret was generated at boot, so tokens die with the process. */
  ephemeralSecret: boolean;
  /** Lifetime of a minted session token, seconds. */
  sessionTtlS: number;
  /** Lifetime of a challenge nonce, seconds. */
  challengeTtlS: number;
}

/**
 * Reads and validates the auth environment, or throws.
 *
 * THE BOOT REFUSALS, both deliberate:
 *
 *   - `AUTH_PLACEHOLDER=1` under `NODE_ENV=production`. The placeholder trusts
 *     a header anyone can set; a deployment that turns it on is a deployment
 *     with no auth at all, and it must fail loudly at boot rather than serve.
 *   - No `AUTH_SESSION_SECRET` outside placeholder mode. Without a key there is
 *     nothing to sign tokens with, and guessing a default would mean every
 *     deployment shares a forgeable one.
 *
 * In placeholder mode a missing secret is filled with 32 random bytes instead,
 * so the challenge → token flow works in development exactly as it does in
 * production; those tokens simply do not survive a restart.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const production = env.NODE_ENV === 'production';
  const placeholderRequested = env.AUTH_PLACEHOLDER === '1' || env.AUTH_PLACEHOLDER === 'true';

  if (placeholderRequested && production) {
    throw new Error(
      'AUTH_PLACEHOLDER trusts the x-sente-user-id header and is refused under NODE_ENV=production. Unset it and set AUTH_SESSION_SECRET.',
    );
  }

  const configured = readSecret(env.AUTH_SESSION_SECRET);
  if (!configured && !placeholderRequested) {
    throw new Error(
      `AUTH_SESSION_SECRET is required: ${SESSION_SECRET_BYTES} random bytes as hex (openssl rand -hex ${SESSION_SECRET_BYTES}). Development may set AUTH_PLACEHOLDER=1 instead.`,
    );
  }

  return {
    mode: placeholderRequested ? 'placeholder' : 'session',
    sessionSecret: configured ?? randomBytes(SESSION_SECRET_BYTES),
    ephemeralSecret: configured === undefined,
    sessionTtlS: readTtl(env.AUTH_SESSION_TTL_S),
    challengeTtlS: CHALLENGE_TTL_S,
  };
}

function readSecret(raw: string | undefined): Buffer | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;

  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (!new RegExp(`^[0-9a-fA-F]{${SESSION_SECRET_BYTES * 2}}$`).test(hex)) {
    throw new Error(
      `AUTH_SESSION_SECRET must be ${SESSION_SECRET_BYTES} bytes of hex (${SESSION_SECRET_BYTES * 2} hex characters), optionally 0x-prefixed`,
    );
  }
  return Buffer.from(hex, 'hex');
}

function readTtl(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === '') return DEFAULT_SESSION_TTL_S;

  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_SESSION_TTL_S) {
    throw new Error(
      `AUTH_SESSION_TTL_S must be a whole number of seconds between 1 and ${MAX_SESSION_TTL_S}`,
    );
  }
  return seconds;
}

/**
 * The process-wide configuration, read once.
 *
 * Guards are bound per controller in five modules and are constructed by Nest
 * in each of them, so a guard with no constructor dependency is a one-line
 * binding everywhere and is trivially constructible in a spec. The config it
 * needs is process-wide and immutable, so it is memoised here rather than
 * threaded through five providers. `AuthModule` resolves it at boot through
 * this same function, which is what turns a bad environment into a failed boot
 * instead of a failed request.
 */
let cached: AuthConfig | undefined;

export function authConfig(): AuthConfig {
  return (cached ??= loadAuthConfig());
}

/** Test seam: drops the memo so a spec can re-read a changed environment. */
export function resetAuthConfig(): void {
  cached = undefined;
}

export function describeAuthConfig(config: AuthConfig, logger: Logger): void {
  if (config.mode === 'placeholder') {
    logger.warn(
      `PLACEHOLDER AUTH ENABLED (AUTH_PLACEHOLDER): the x-sente-user-id header authenticates anyone. Development only.`,
    );
  }
  if (config.ephemeralSecret) {
    logger.warn(
      'No AUTH_SESSION_SECRET: session tokens are signed with an ephemeral key and stop verifying when this process restarts.',
    );
  }
  logger.log(
    `auth mode=${config.mode} sessionTtl=${config.sessionTtlS}s challengeTtl=${config.challengeTtlS}s`,
  );
}
