import { join } from 'node:path';

import { Logger, type Provider } from '@nestjs/common';

import { stateDir } from '../../state/json-file';
import { MarketDataService } from '../../venues/market-data.service';
import { VenuesModule } from '../../venues/venues.module';

import { AgentsService } from '../agents.service';
import { AGENT_EVENTS, InMemoryAgentEventLog, type AgentEventLog } from '../events/agent-event-log';
import { AGENT_EVENTS_FILE, FileAgentEventLog } from '../events/file-agent-event-log';
import {
  createErc8004Client,
  describeErc8004Config,
  ERC8004_WRITER,
  Erc8004Reputation,
  isSelfFeedback,
  loadErc8004Config,
  ReputationEventLog,
} from '../reputation/erc8004';
import { AGENT_STORE, type AgentStore } from '../store/agent-store';
import { AgentVenues } from '../venues/agent-venues';
import { AgentTools } from './context';
import { McpController } from './mcp.controller';
import { McpHttp } from './mcp-http';
import {
  AGENT_TOOLS_CONFIG,
  describeAgentToolsConfig,
  loadAgentToolsConfig,
  type AgentToolsConfig,
} from './tools.config';

/**
 * ERC-8004 (SEN-27): the identity a hire gets and the reputation every verdict
 * writes. Unconfigured is a valid state — no registrar key, no registry writes,
 * agents hired exactly as before — so this never throws at boot for a missing
 * env var, only for a malformed one.
 */
const erc8004Provider: Provider = {
  provide: ERC8004_WRITER,
  inject: [AGENT_STORE],
  useFactory: (store: AgentStore): Erc8004Reputation => {
    const config = loadErc8004Config();
    const logger = new Logger('Erc8004');
    describeErc8004Config(config, logger);
    return new Erc8004Reputation({
      client: createErc8004Client(config),
      agents: store,
      agentBaseUrl: config.agentBaseUrl,
      selfFeedback: isSelfFeedback(config),
      ...(config.mcpEndpoint ? { mcpEndpoint: config.mcpEndpoint } : {}),
      ...(config.imageUrl ? { imageUrl: config.imageUrl } : {}),
      logger,
    });
  },
};

/**
 * AGENT_EVENTS with the SEN-27 hook on it: the log a verdict is appended to is
 * also what publishes it to the Reputation Registry, so the Tool Runner and the
 * MCP server both get it without a second call site (see `ReputationEventLog`).
 *
 * With `STATE_DIR` set the log is an append-only JSONL file there (SEN-65), so
 * the Ledger and the cost basis it feeds survive a restart; unset, it stays in
 * memory as before.
 */
const agentEventsProvider: Provider = {
  provide: AGENT_EVENTS,
  inject: [ERC8004_WRITER],
  useFactory: (reputation: Erc8004Reputation): AgentEventLog => {
    const dir = stateDir();
    if (!dir) return new ReputationEventLog(new InMemoryAgentEventLog(), reputation);
    const log = new FileAgentEventLog(join(dir, AGENT_EVENTS_FILE));
    Logger.log(`${log.size} agent event(s) loaded from ${log.path}`, 'AgentEventLog');
    return new ReputationEventLog(log, reputation);
  },
};

/**
 * Nest wiring for the agent tools and `/mcp` (SEN-7), kept out of
 * `agents.module.ts` so that file only spreads these in.
 */
export const agentToolsProviders: Provider[] = [
  {
    provide: AGENT_TOOLS_CONFIG,
    useFactory: (): AgentToolsConfig => {
      // Throws at boot for AGENT_PRECHECK=off under NODE_ENV=production.
      const config = loadAgentToolsConfig();
      describeAgentToolsConfig(config, new Logger('AgentTools'));
      return config;
    },
  },
  erc8004Provider,
  agentEventsProvider,
  {
    provide: AgentTools,
    inject: [AGENT_STORE, AgentVenues, AGENT_EVENTS, AGENT_TOOLS_CONFIG, MarketDataService],
    useFactory: (
      store: AgentStore,
      venues: AgentVenues,
      events: AgentEventLog,
      config: AgentToolsConfig,
      marketData: MarketDataService,
    ) =>
      new AgentTools({
        store,
        events,
        precheck: config.precheck,
        // SEN-79: klines, quotes and Perpl depth through the phone's cached
        // path, so N agents cost the venue what one screen does.
        marketData,
        venuesFor: (agent) =>
          venues.forAgent(
            { agentId: agent.id, walletId: agent.walletId, address: agent.address },
            // SEN-148: a run whose mandate allows Perpl enrolls its key on first use.
            { enrollPerpl: agent.mandate.venues.includes('perpl') },
          ),
      }),
  },
  {
    provide: McpHttp,
    inject: [AgentsService, AgentTools],
    useFactory: (agents: AgentsService, tools: AgentTools) =>
      new McpHttp({
        authenticate: (token) => agents.findByMcpToken(token),
        contextFor: (agent, runId) => tools.context(agent, { runId }),
      }),
  },
];

export const agentToolsControllers = [McpController];

/** VenuesModule: the shared `MarketDataService` the read tools go through (SEN-79). */
export const agentToolsImports = [VenuesModule];

/** What AgentsModule exports for SEN-8 (the runner) and the future Agent Ledger. */
export const agentToolsExports = [AgentTools, AGENT_EVENTS];
