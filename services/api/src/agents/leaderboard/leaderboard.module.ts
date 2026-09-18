import { Logger, Module, type Provider } from '@nestjs/common';

import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { AgentsModule } from '../agents.module';
import {
  EnvioIndexerStats,
  INDEXER_STATS,
  UnconfiguredIndexerStats,
  describeIndexerConfig,
  type IndexerStats,
} from './indexer';
import { LeaderboardController } from './leaderboard.controller';
import {
  LEADERBOARD_CONFIG,
  describeLeaderboardConfig,
  loadLeaderboardConfig,
  type LeaderboardConfig,
} from './leaderboard.config';
import { LeaderboardService } from './leaderboard.service';

const configProvider: Provider = {
  provide: LEADERBOARD_CONFIG,
  useFactory: (): LeaderboardConfig => {
    // Throws at boot on a malformed URL, naming the variable, never the value.
    const config = loadLeaderboardConfig();
    describeLeaderboardConfig(config, new Logger('LeaderboardConfig'));
    return config;
  },
};

/**
 * INDEXER_STATS: Envio when `ENVIO_GRAPHQL_URL` is set, and an implementation
 * that refuses (typed, `IndexerUnconfiguredError`) when it is not, so the API
 * still boots without an indexer — the same call `AgentsModule` makes for
 * Privy. A refusal is what `GET /leaderboard` turns into an honest
 * `source.kind: 'unconfigured'`, which is not the same answer as an empty
 * board.
 */
const indexerProvider: Provider = {
  provide: INDEXER_STATS,
  inject: [LEADERBOARD_CONFIG],
  useFactory: (config: LeaderboardConfig): IndexerStats => {
    describeIndexerConfig(config.envioGraphqlUrl, new Logger('LeaderboardIndexer'));
    return config.envioGraphqlUrl === undefined
      ? new UnconfiguredIndexerStats()
      : new EnvioIndexerStats({ url: config.envioGraphqlUrl });
  },
};

/**
 * The agent leaderboard (SEN-26): settled performance per agent, read from the
 * SEN-25 indexer and joined to the agent store and the SEN-22 verdicts.
 *
 * `AgentsModule` is imported for its EXPORTED singletons — `AGENT_STORE` and
 * `AGENT_EVENTS` must be the same instances the rest of the app writes to, and
 * re-providing either here would leave the board reading an empty store.
 *
 * `SessionAuthGuard` is provided rather than imported from `AuthModule`: every
 * module that binds it constructs its own, which is why the guard takes no
 * constructor dependency and reads its configuration from the memo in
 * `auth.config.ts`. It is stateless, so a second instance costs nothing.
 */
@Module({
  imports: [AgentsModule],
  controllers: [LeaderboardController],
  providers: [configProvider, indexerProvider, SessionAuthGuard, LeaderboardService],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
