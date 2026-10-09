import { Module, type Provider } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { AGENT_STORE, type AgentStore } from '../agents/store/agent-store';
import { AgentPerplOnboarder } from '../agents/venues/perpl-onboarding';
import { AlchemyModule } from './alchemy.module';
import { WebhooksController } from './webhooks.controller';
import {
  AGENT_ADDRESSES,
  AGENT_DEPOSITED,
  WebhooksService,
  type AgentAddresses,
  type AgentDeposited,
} from './webhooks.service';

/**
 * `AgentAddresses` over the agent store's own indexed lookup.
 *
 * A point lookup, not a scan: `AgentStore.findByAddress` keeps an
 * `address -> id` map beside the `mcpTokenHash` one, the way
 * `gas/ledger/drip-ledger.ts` does, so a delivery carrying N transfers costs N
 * map reads rather than N passes over every active agent. The narrow port stays
 * because `WebhooksService` has no business with the rest of `AgentStore`.
 *
 * `status === 'active'` is checked HERE rather than in the store, so the policy
 * is visible at the place that sets it: a deposit to a REVOKED agent's wallet
 * appends nothing. Its mandate is empty, it will not trade, and a `deposit` row
 * on a dead Ledger would suggest otherwise. The funds are still the user's to
 * withdraw — that is `agent:withdraw-live`'s business, not the Ledger's.
 */
const agentAddressesProvider: Provider = {
  provide: AGENT_ADDRESSES,
  inject: [AGENT_STORE],
  useFactory: (store: AgentStore): AgentAddresses => ({
    agentIdForAddress: async (address: string): Promise<string | undefined> => {
      const agent = await store.findByAddress(address);
      return agent?.status === 'active' ? agent.id : undefined;
    },
  }),
};

/**
 * A deposit to an agent may be the AUSD its Perpl account waits for (SEN-187):
 * kick the opening, which looks for the funds and does nothing for an agent
 * without Perpl in its mandate.
 */
const agentDepositedProvider: Provider = {
  provide: AGENT_DEPOSITED,
  inject: [AGENT_STORE, AgentPerplOnboarder],
  useFactory:
    (store: AgentStore, onboarding: AgentPerplOnboarder): AgentDeposited =>
    async (agentId: string) => {
      const agent = await store.get(agentId);
      if (agent) onboarding.kick(agent, 'deposit', { awaitFunds: true });
    },
};

/**
 * Inbound webhooks — today exactly one, Alchemy Notify's Address Activity, which
 * appends a `deposit` to the Agent Ledger when funds reach a hired agent's wallet
 * (SEN-30). Everything about the payload and the signature is cited in
 * `alchemy.ts`; the operator-facing half is `docs/alchemy.md`.
 *
 * Imports `AgentsModule` for `AGENT_STORE` and `AGENT_EVENTS`, one way: `agents/`
 * does not import this module — it imports `AlchemyModule`, which both use for the
 * shared configuration, so there is no cycle.
 *
 * `SessionAuthGuard` is NOT in `providers` and NOT on the controller. See
 * `webhooks.controller.ts`.
 */
@Module({
  imports: [AgentsModule, AlchemyModule],
  controllers: [WebhooksController],
  providers: [agentAddressesProvider, agentDepositedProvider, WebhooksService],
})
export class WebhooksModule {}
