/**
 * `ENVIO_GRAPHQL_URL` -> config (SEN-26). Pure, no Nest.
 *
 * A malformed URL has to fail at boot rather than as an unexplained empty
 * board later, and nothing in a message may contain the value — an Envio
 * endpoint can carry a token in its query.
 */
import { loadLeaderboardConfig } from './leaderboard.config';

describe('loadLeaderboardConfig', () => {
  it('is unconfigured when the variable is unset, empty or blank', () => {
    expect(loadLeaderboardConfig({}).envioGraphqlUrl).toBeUndefined();
    expect(loadLeaderboardConfig({ ENVIO_GRAPHQL_URL: '' }).envioGraphqlUrl).toBeUndefined();
    expect(loadLeaderboardConfig({ ENVIO_GRAPHQL_URL: '   ' }).envioGraphqlUrl).toBeUndefined();
  });

  it('accepts an http(s) endpoint and normalises it', () => {
    expect(
      loadLeaderboardConfig({ ENVIO_GRAPHQL_URL: 'https://indexer.envio.dev/v1/graphql' })
        .envioGraphqlUrl,
    ).toBe('https://indexer.envio.dev/v1/graphql');
    expect(
      loadLeaderboardConfig({ ENVIO_GRAPHQL_URL: '  http://localhost:8080/v1/graphql  ' })
        .envioGraphqlUrl,
    ).toBe('http://localhost:8080/v1/graphql');
  });

  it('fails fast on something that is not a URL, naming the variable only', () => {
    expect(() => loadLeaderboardConfig({ ENVIO_GRAPHQL_URL: 'indexer' })).toThrow(
      /ENVIO_GRAPHQL_URL is not a URL/,
    );

    let caught: Error | undefined;
    try {
      loadLeaderboardConfig({ ENVIO_GRAPHQL_URL: 'ftp://indexer.test?token=super-secret' });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe('ENVIO_GRAPHQL_URL must be an http(s) URL');
    expect(caught?.message).not.toContain('super-secret');
  });
});
