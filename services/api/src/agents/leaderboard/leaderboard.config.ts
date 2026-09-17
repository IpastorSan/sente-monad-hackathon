import type { Logger } from '@nestjs/common';

/** DI token for the resolved leaderboard configuration. */
export const LEADERBOARD_CONFIG = Symbol('LEADERBOARD_CONFIG');

export interface LeaderboardConfig {
  /**
   * Envio HyperIndex's GraphQL endpoint (SEN-25). `undefined` when unset, which
   * is the honest default: the API boots, and `GET /leaderboard` says it is
   * unconfigured rather than ranking nothing.
   */
  readonly envioGraphqlUrl: string | undefined;
}

/**
 * Pure env -> config, so a typo in the URL fails at boot instead of as an
 * empty board later, and so it is testable without Nest. No message ever
 * contains the value, only the variable name.
 */
export function loadLeaderboardConfig(env: NodeJS.ProcessEnv = process.env): LeaderboardConfig {
  const raw = env['ENVIO_GRAPHQL_URL']?.trim();
  if (raw === undefined || raw === '') return { envioGraphqlUrl: undefined };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('ENVIO_GRAPHQL_URL is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ENVIO_GRAPHQL_URL must be an http(s) URL');
  }
  return { envioGraphqlUrl: url.toString() };
}

export function describeLeaderboardConfig(config: LeaderboardConfig, logger: Logger): void {
  logger.log(
    config.envioGraphqlUrl === undefined
      ? 'leaderboard: no indexer configured (ENVIO_GRAPHQL_URL unset)'
      : 'leaderboard: reading it from the Envio indexer',
  );
}
