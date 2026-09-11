import { type Logger } from '@nestjs/common';

/** DI token for the resolved, validated credits configuration. */
export const CREDITS_CONFIG = Symbol('CREDITS_CONFIG');

export interface CreditsConfig {
  /**
   * OpenRouter management key. It can mint, read, re-limit and delete API keys
   * but cannot itself call a model. Undefined leaves the API booting with
   * credits refusing `credits_unconfigured` — the honest state, same as the
   * wallet's `paymaster: none`.
   */
  managementKey: string | undefined;
  /** Hard monthly spending limit, in USD, on every newly provisioned key. */
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
  return {
    managementKey: env.OPENROUTER_MANAGEMENT_KEY?.trim() || undefined,
    defaultLimitUsd: parsePositiveUsd(
      env.OPENROUTER_DEFAULT_LIMIT_USD,
      CREDITS_DEFAULTS.defaultLimitUsd,
      'OPENROUTER_DEFAULT_LIMIT_USD',
    ),
  };
}

/** Boot-time summary. Says whether the management key is set, never what it is. */
export function describeCreditsConfig(config: CreditsConfig, logger: Logger): void {
  logger.log(
    `openrouter management key ${config.managementKey ? 'set' : 'NOT set'}, ` +
      `default limit $${config.defaultLimitUsd}/month`,
  );
  if (!config.managementKey) {
    logger.warn(
      'OPENROUTER_MANAGEMENT_KEY is not set: /credits will refuse with credits_unconfigured.',
    );
  }
}
