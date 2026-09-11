import { Logger, type Provider } from '@nestjs/common';

import { AgentsService } from '../agents.service';
import { AGENT_EVENTS, InMemoryAgentEventLog, type AgentEventLog } from '../events/agent-event-log';
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
  { provide: AGENT_EVENTS, useFactory: (): AgentEventLog => new InMemoryAgentEventLog() },
  {
    provide: AgentTools,
    inject: [AGENT_STORE, AgentVenues, AGENT_EVENTS, AGENT_TOOLS_CONFIG],
    useFactory: (
      store: AgentStore,
      venues: AgentVenues,
      events: AgentEventLog,
      config: AgentToolsConfig,
    ) =>
      new AgentTools({
        store,
        events,
        precheck: config.precheck,
        venuesFor: (agent) =>
          venues.forAgent({ agentId: agent.id, walletId: agent.walletId, address: agent.address }),
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

/** What AgentsModule exports for SEN-8 (the runner) and the future Agent Ledger. */
export const agentToolsExports = [AgentTools, AGENT_EVENTS];
