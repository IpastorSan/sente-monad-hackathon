import { type Logger } from '@nestjs/common';

/** DI token for the resolved, validated credits configuration. */
export const CREDITS_CONFIG = Symbol('CREDITS_CONFIG');

/**
 * How inference is paid for.
 * - `per-user`: OPENROUTER_MANAGEMENT_KEY mints one capped key per user. The production design.
 * - `shared`: OPENROUTER_API_KEY, one inference key every user draws on. Dev only (SEN-18):
 *   no per-user limits, so it refuses to boot in production.
 * - `unconfigured`: neither is set; /credits and the runner refuse with `credits_unconfigured`.
 */
export type CreditsMode = 'per-user' | 'shared' | 'unconfigured';

export interface CreditsConfig {
  /**
   * OpenRouter management key. It can mint, read, re-limit and delete API keys
   * but cannot itself call a model.
   */
  managementKey: string | undefined;
  /** One OpenRouter inference key shared by every user. Dev only. */
  sharedKey: string | undefined;
  mode: CreditsMode;
  /** Hard monthly spending limit, in USD, on every newly provisioned key (per-user mode). */
  defaultLimitUsd: number;
}

export const CREDITS_DEFAULTS = {
  defaultLimitUsd: 5,
} as const;

function parsePositiveUsd(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of USD, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Pure env -> config, so a bad deployment fails at boot rather than on the
 * first provision, and so it can be unit tested without Nest.
 */
export function loadCreditsConfig(env: NodeJS.ProcessEnv = process.env): CreditsConfig {
  const managementKey = env.OPENROUTER_MANAGEMENT_KEY?.trim() || undefined;
  const sharedKey = env.OPENROUTER_API_KEY?.trim() || undefined;
  const mode: CreditsMode = managementKey ? 'per-user' : sharedKey ? 'shared' : 'unconfigured';
  if (mode === 'shared' && env.NODE_ENV === 'production') {
    // Every user would spend one budget with no per-user cap.
    throw new Error(
      'OPENROUTER_API_KEY (one shared inference key) is dev-only; set OPENROUTER_MANAGEMENT_KEY in production',
    );
  }
  return {
    managementKey,
    sharedKey,
    mode,
    defaultLimitUsd: parsePositiveUsd(
      env.OPENROUTER_DEFAULT_LIMIT_USD,
      CREDITS_DEFAULTS.defaultLimitUsd,
      'OPENROUTER_DEFAULT_LIMIT_USD',
    ),
  };
}

/** Boot-time summary. Says which mode is active and whether keys are set, never what they are. */
export function describeCreditsConfig(config: CreditsConfig, logger: Logger): void {
  logger.log(
    `openrouter credits mode ${config.mode}` +
      (config.mode === 'per-user' ? `, default limit $${config.defaultLimitUsd}/month` : ''),
  );
  if (config.mode === 'shared') {
    logger.warn(
      'OPENROUTER_API_KEY: every user shares one inference key with no per-user limit (dev only).',
    );
  }
  if (config.mode === 'per-user' && config.sharedKey) {
    logger.warn('Both OpenRouter keys are set: per-user mode wins, OPENROUTER_API_KEY is ignored.');
  }
  if (config.mode === 'unconfigured') {
    logger.warn(
      'Neither OPENROUTER_MANAGEMENT_KEY nor OPENROUTER_API_KEY is set: /credits will refuse with credits_unconfigured.',
    );
  }
}
