import { Logger, type Provider } from '@nestjs/common';
import { KuruVenue } from '@sente/venues/kuru';
import type { PublicClient } from 'viem';

import { AGENT_EVENTS, type AgentEventLog } from '../events/agent-event-log';
import { AGENT_STORE, type AgentStore } from '../store/agent-store';
import { AgentTools } from '../tools/context';
import { AGENT_PUBLIC_CLIENT } from '../venues/agent-venues.providers';
import {
  loadRestingFillConfig,
  RESTING_FILL_CONFIG,
  RestingFillWatcher,
  type KuruFillSource,
  type RestingFillConfig,
} from './resting-fill.watcher';

/** The chain side of the watcher: one read-only Kuru venue for the logs, one per address for ids. */
export function kuruFillSource(publicClient: PublicClient): KuruFillSource {
  const reader = new KuruVenue({ publicClient });
  return {
    head: () => publicClient.getBlockNumber({ cacheTime: 0 }),
    makerFills: (symbol, fromBlock, toBlock) => reader.makerFills(symbol, fromBlock, toBlock),
    accountId: (address) => new KuruVenue({ publicClient, account: address }).accountId(),
  };
}

/**
 * Nest wiring for the resting-fill watcher (SEN-149). After the venue and tool
 * providers: it reads the chain through AGENT_PUBLIC_CLIENT and appends under
 * AgentTools' write lock.
 */
export const restingFillProviders: Provider[] = [
  {
    provide: RESTING_FILL_CONFIG,
    useFactory: (): RestingFillConfig => {
      const config = loadRestingFillConfig();
      new Logger(RestingFillWatcher.name).log(
        config.pollSeconds === undefined
          ? 'resting-fill watcher off (AGENT_FILL_POLL_SECONDS=off)'
          : `resting-fill watcher every ${config.pollSeconds} s, ` +
              `${config.maxBlockRange}-block log ranges`,
      );
      return config;
    },
  },
  {
    provide: RestingFillWatcher,
    inject: [RESTING_FILL_CONFIG, AGENT_STORE, AGENT_EVENTS, AGENT_PUBLIC_CLIENT, AgentTools],
    useFactory: (
      config: RestingFillConfig,
      store: AgentStore,
      events: AgentEventLog,
      publicClient: PublicClient,
      tools: AgentTools,
    ) =>
      new RestingFillWatcher({
        config,
        store,
        events,
        source: kuruFillSource(publicClient),
        writeLock: tools.writeLock,
      }),
  },
];
