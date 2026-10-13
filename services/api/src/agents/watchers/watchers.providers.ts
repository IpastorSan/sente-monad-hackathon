import type { Provider } from '@nestjs/common';

import { SenteDbLease } from '../../state/state.module';
import { selectStore } from '../../state/store-backend';
import { MarketDataService } from '../../venues/market-data.service';
import { AgentVenues } from '../venues/agent-venues';
import { SqliteWatcherStore } from './sqlite-watcher-store';
import { WatchersController } from './watchers.controller';
import {
  FileWatcherStore,
  InMemoryWatcherStore,
  WATCHER_STORE,
  WATCHERS_FILE,
  type WatcherStore,
} from './watcher-store';
import { WatcherService } from './watcher.service';

/**
 * Nest wiring for the watchers (SEN-182), spread into `AgentsModule` before
 * the tool providers, whose `AgentTools` hands `WatcherService` to the tools.
 */
export const watcherProviders: Provider[] = [
  {
    // On disk under STATE_DIR, opened only once this process holds its lock
    // (SEN-161): a JSON file, or a table in sente.db under STORE_BACKEND=sqlite (SEN-205).
    provide: WATCHER_STORE,
    inject: [SenteDbLease],
    useFactory: (lease: SenteDbLease): WatcherStore =>
      selectStore<WatcherStore>(lease, `${WATCHERS_FILE}.json`, 'watcher set(s)', {
        memory: () => new InMemoryWatcherStore(),
        file: (path) => new FileWatcherStore(path),
        sqlite: (db) => new SqliteWatcherStore(db),
      }),
  },
  {
    provide: WatcherService,
    inject: [WATCHER_STORE, MarketDataService, AgentVenues],
    useFactory: (store: WatcherStore, marketData: MarketDataService, venues: AgentVenues) =>
      new WatcherService({
        store,
        // The phone's and the tools' cached reads: a check costs the venue no more than a screen.
        marketData,
        // Borrows the run's socket or opens a throwaway one (SEN-122), so a
        // check never keeps a socket alive, and never enrolls a Perpl key.
        positionsOf: (agent) =>
          venues.readPerpl(
            { agentId: agent.id, walletId: agent.walletId, address: agent.address },
            async (perpl) => (perpl ? perpl.getPositions() : undefined),
          ),
      }),
  },
];

export const watcherControllers = [WatchersController];
