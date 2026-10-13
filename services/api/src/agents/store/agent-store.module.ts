import { Logger, Module, type Provider } from '@nestjs/common';

import { SenteDbLease, StateModule } from '../../state/state.module';
import { selectStore } from '../../state/store-backend';
import { AGENT_STORE, InMemoryAgentStore, type AgentStore } from './agent-store';
import { FileAgentStore } from './file-agent-store';
import { SqliteAgentStore } from './sqlite-agent-store';

/**
 * PERSISTENCE: in memory until `STATE_DIR` is set (see `agent-store.ts`), then
 * a JSON file, so a restart between hiring an agent and showing it off does not
 * orphan the agent's funded wallet, its policy id and its ERC-8004 identity
 * (SEN-48) — or, under `STORE_BACKEND=sqlite`, a table in `<STATE_DIR>/sente.db`
 * (SEN-205, `state/store-backend.ts`).
 */
const agentStoreProvider: Provider = {
  provide: AGENT_STORE,
  // `SenteDbLease` holds the STATE_DIR lock (through `StateDirLease`) and the
  // database, so injecting it is what orders this store after both (SEN-161).
  inject: [SenteDbLease],
  useFactory: (lease: SenteDbLease): AgentStore =>
    selectStore<AgentStore>(lease, 'agents.json', {
      memory: () => new InMemoryAgentStore(),
      file: (path) => {
        const store = new FileAgentStore(path);
        Logger.log(`${store.size} agent(s) loaded from ${store.path}`, 'AgentStore');
        return store;
      },
      sqlite: (db) => {
        const store = new SqliteAgentStore(db);
        Logger.log(`${store.size} agent(s) in ${store.path}`, 'AgentStore');
        return store;
      },
    }),
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
  imports: [StateModule],
  providers: [agentStoreProvider],
  exports: [AGENT_STORE],
})
export class AgentStoreModule {}
