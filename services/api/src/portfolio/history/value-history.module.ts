import { join } from 'node:path';

import { Logger, Module, type Provider } from '@nestjs/common';

import { AGENT_EVENTS, type AgentEventLog } from '../../agents/events/agent-event-log';
import { AgentsModule } from '../../agents/agents.module';
import { AgentPortfolioService } from '../../agents/portfolio/portfolio.service';
import { AGENT_STORE, type AgentStore } from '../../agents/store/agent-store';
import { Auth, RequestContextAuth } from '../../auth/principal';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { StateDirLease, StateModule } from '../../state/state.module';
import { TradingEnabledGuard } from '../../trade/trade.controller';
import { TRADE_CONFIG, type TradeConfig } from '../../trade/trade.config';
import { TradeModule } from '../../trade/trade.module';
import { TradeStore } from '../../trade/trade-store';
import { MarketDataService } from '../../venues/market-data.service';
import { VenuesModule } from '../../venues/venues.module';
import { PortfolioModule } from '../portfolio.module';
import { UserPortfolioService } from '../portfolio.service';
import { AgentHistoryController, PortfolioHistoryController } from './value-history.controller';
import {
  loadValueHistoryConfig,
  VALUE_HISTORY_CONFIG,
  VALUE_HISTORY_READERS,
  ValueHistoryService,
  type ValueHistoryReaders,
} from './value-history.service';
import {
  FileValueHistoryStore,
  InMemoryValueHistoryStore,
  VALUE_HISTORY_FILE,
  VALUE_HISTORY_STORE,
  type ValueHistoryStore,
} from './value-history.store';

/** In memory unless `STATE_DIR` is set; then `value-history.jsonl` there, so a restart keeps the chart. */
const storeProvider: Provider = {
  provide: VALUE_HISTORY_STORE,
  // StateDirLease: the file opens only once this process holds the STATE_DIR lock (SEN-161).
  inject: [StateDirLease],
  useFactory: (lease: StateDirLease): ValueHistoryStore => {
    if (!lease.dir) return new InMemoryValueHistoryStore();
    const store = new FileValueHistoryStore(join(lease.dir, VALUE_HISTORY_FILE));
    Logger.log(`${store.size} value snapshot(s) loaded from ${store.path}`, 'ValueHistory');
    return store;
  },
};

const readersProvider: Provider = {
  provide: VALUE_HISTORY_READERS,
  inject: [
    VALUE_HISTORY_STORE,
    UserPortfolioService,
    AgentPortfolioService,
    MarketDataService,
    AGENT_STORE,
    TradeStore,
    AGENT_EVENTS,
    TRADE_CONFIG,
  ],
  useFactory: (
    store: ValueHistoryStore,
    users: UserPortfolioService,
    agentPortfolios: AgentPortfolioService,
    marketData: MarketDataService,
    agents: AgentStore,
    trades: TradeStore,
    events: AgentEventLog,
    trade: TradeConfig,
  ): ValueHistoryReaders => ({
    store,
    userPortfolio: (principal) => users.portfolio(principal),
    agentPortfolio: (agent) => agentPortfolios.portfolio(agent),
    kuruTickers: async () => (await marketData.tickers('kuru')).tickers,
    agents,
    trades,
    events,
    tradingEnabled: trade.enabled,
  }),
};

/**
 * The value history (SEN-152): snapshots on a timer, and the two routes that
 * chart them. A module of its own, below the portfolio and agent modules it
 * reads through, so neither of those has to import the other.
 */
@Module({
  imports: [StateModule, PortfolioModule, AgentsModule, TradeModule, VenuesModule],
  controllers: [PortfolioHistoryController, AgentHistoryController],
  providers: [
    { provide: Auth, useClass: RequestContextAuth },
    SessionAuthGuard,
    TradingEnabledGuard,
    storeProvider,
    { provide: VALUE_HISTORY_CONFIG, useFactory: () => loadValueHistoryConfig() },
    readersProvider,
    ValueHistoryService,
  ],
})
export class ValueHistoryModule {}
