import { Inject, Logger, Module, type OnModuleDestroy, type Provider } from '@nestjs/common';
import { KuruVenue } from '@sente/venues/kuru';
import {
  fetchBookSnapshot,
  PERPL_NETWORKS,
  PerplMarketData,
  type PerplNetwork,
} from '@sente/venues/perpl';
import { createPublicClient, http, type PublicClient } from 'viem';
import { monadTestnet } from 'viem/chains';

import { SessionAuthGuard } from '../auth/session-auth.guard';
import { KURU_READER, MarketDataService, PERPL_READER } from './market-data.service';
import { MarketsController } from './markets.controller';
import { PerplBookFeed } from './perpl/perpl-book-feed';
import { PerplMarketReader } from './perpl/perpl-market-reader';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';

/** DI token for the Monad public client market data reads through (not the agents' one). */
export const MARKET_PUBLIC_CLIENT = Symbol('MARKET_PUBLIC_CLIENT');
/** DI token for the Perpl network (REST + socket URLs) the readers use. */
export const PERPL_NETWORK = Symbol('PERPL_NETWORK');

/**
 * Credential-free venue readers (SEN-75, plan B-T5b). Nothing here holds a key
 * or connects at boot: `KuruVenue` without an account is read-only, and the
 * Perpl socket opens on the first book read.
 */
const marketDataProviders: Provider[] = [
  {
    provide: MARKET_PUBLIC_CLIENT,
    // Built like AGENT_PUBLIC_CLIENT, plus multicall batching: multicall3 is
    // deployed on Monad testnet (0xcA11…CA11, checked with eth_getCode), so a
    // burst of reads in one tick becomes one eth_call instead of one each.
    useFactory: (): PublicClient =>
      createPublicClient({
        chain: monadTestnet,
        batch: { multicall: true },
        transport: http(process.env['MONAD_TESTNET_RPC_URL']?.trim() || undefined, {
          retryCount: 2,
        }),
      }) as PublicClient,
  },
  {
    provide: KuruVenue,
    inject: [MARKET_PUBLIC_CLIENT],
    useFactory: (publicClient: PublicClient) => new KuruVenue({ publicClient }),
  },
  { provide: KURU_READER, useExisting: KuruVenue },
  { provide: PERPL_NETWORK, useValue: PERPL_NETWORKS.testnet },
  {
    provide: PerplMarketData,
    inject: [PERPL_NETWORK],
    useFactory: (network: PerplNetwork) => new PerplMarketData({ network }),
  },
  {
    provide: PerplBookFeed,
    inject: [PERPL_NETWORK, PerplMarketData],
    useFactory: (network: PerplNetwork, data: PerplMarketData) =>
      new PerplBookFeed({
        wsUrl: network.wsUrl,
        // Read on every (re)connect, so a market opened since boot is subscribed too.
        marketIds: async () =>
          (await data.context()).markets.filter((m) => m.config.is_open).map((m) => m.id),
        logger: new Logger('PerplBookFeed'),
      }),
  },
  {
    provide: PERPL_READER,
    inject: [PERPL_NETWORK, PerplMarketData, PerplBookFeed],
    useFactory: (network: PerplNetwork, data: PerplMarketData, feed: PerplBookFeed) =>
      new PerplMarketReader({
        data,
        feed,
        snapshot: (marketId) => fetchBookSnapshot(network.wsUrl, marketId),
        logger: new Logger('PerplMarketReader'),
      }),
  },
  MarketDataService,
];

/**
 * Venue reads for the phone and the agents: `MarketDataService` is the one
 * cached path to Kuru and Perpl market data (SEN-70, SEN-75).
 *
 * `SessionAuthGuard` is provided (not imported from `AuthModule`) for the
 * `/markets` routes, as `LeaderboardModule` does: the guard is stateless.
 * This module imports nothing from agents, so `AgentsModule` can import it.
 */
@Module({
  controllers: [VenuesController, MarketsController],
  providers: [...marketDataProviders, SessionAuthGuard, VenuesService],
  exports: [MarketDataService, VenuesService],
})
export class VenuesModule implements OnModuleDestroy {
  constructor(@Inject(PerplBookFeed) private readonly feed: PerplBookFeed) {}

  /** The feed holds a socket and timers; without this, shutdown and specs hang on them. */
  onModuleDestroy(): void {
    this.feed.close();
  }
}
