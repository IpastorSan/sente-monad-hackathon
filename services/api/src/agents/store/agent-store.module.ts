import { Logger, Module, type Provider } from '@nestjs/common';

import { statePath } from '../../state/json-file';
import { AGENT_STORE, InMemoryAgentStore, type AgentStore } from './agent-store';
import { FileAgentStore } from './file-agent-store';

/**
 * PERSISTENCE: in memory until the repo has a database (see `agent-store.ts`),
 * EXCEPT when `STATE_DIR` is set — then a JSON file, so a restart between hiring
 * an agent and showing it off does not orphan the agent's funded wallet, its
 * policy id and its ERC-8004 identity (SEN-48).
 */
const agentStoreProvider: Provider = {
  provide: AGENT_STORE,
  useFactory: (): AgentStore => {
    const path = statePath('agents');
    if (!path) return new InMemoryAgentStore();
    const store = new FileAgentStore(path);
    Logger.log(`${store.size} agent(s) loaded from ${store.path}`, 'AgentStore');
    return store;
  },
};

/**
 * The agent store, on its own, so two modules can share ONE of it.
 *
 * `AgentsModule` owns the lifecycle; `WalletModule` needs a single fact out of
 * the same records (SEN-42): is the address this user is sending to one of their
 * own agents' wallets? That cannot be a `WalletModule` -> `AgentsModule` import,
 * because `AgentsModule` already imports `WalletModule` for the device-key
 * quorum (SEN-43) and Nest would have a cycle. It equally must not be a second
 * provider: two stores are two sets of agents, and the one the send allowlist
 * reads would not be the one hiring writes — every fund would be refused.
 *
 * So the store moves down here, under both of them, and neither owns it.
 */
@Module({
  providers: [agentStoreProvider],
  exports: [AGENT_STORE],
})
export class AgentStoreModule {}
