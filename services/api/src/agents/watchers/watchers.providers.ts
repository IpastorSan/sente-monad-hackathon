import { join } from 'node:path';

import { Logger, type Provider } from '@nestjs/common';

import { StateDirLease } from '../../state/state.module';
import { MarketDataService } from '../../venues/market-data.service';
import { AgentVenues } from '../venues/agent-venues';
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
    // On disk under STATE_DIR, opened only once this process holds its lock (SEN-161).
    provide: WATCHER_STORE,
    inject: [StateDirLease],
    useFactory: (lease: StateDirLease): WatcherStore => {
      if (!lease.dir) return new InMemoryWatcherStore();
      const store = new FileWatcherStore(join(lease.dir, `${WATCHERS_FILE}.json`));
      Logger.log(`${store.size} watcher set(s) loaded from ${store.path}`, 'Watchers');
      return store;
    },
  },
  {
    provide: WatcherService,
    inject: [WATCHER_STORE, MarketDataService, AgentVenues],
    useFactory: (store: WatcherStore, marketData: MarketDataService, venues: AgentVenues) =>
      new WatcherService({
        store,
        // The phone's and the tools' cached reads: a check costs the venue no more than a screen.
        marketData,
        // Never enrolls a Perpl key: a check only reads what the agent already has.
        positionsOf: async (agent) => {
          const set = await venues.forAgent(
            { agentId: agent.id, walletId: agent.walletId, address: agent.address },
            { enrollPerpl: false },
          );
          return set.perpl ? set.perpl.getPositions() : undefined;
        },
      }),
  },
];

export const watcherControllers = [WatchersController];
