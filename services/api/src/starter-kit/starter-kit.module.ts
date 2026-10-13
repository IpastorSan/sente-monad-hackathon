import { Logger, Module, type Provider } from '@nestjs/common';
import { createPublicClient, createWalletClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import { NonceManagedSender } from '../gas/sender/nonce-managed-sender';
import { SenteDbLease, StateModule } from '../state/state.module';
import { selectStore } from '../state/store-backend';
import {
  STARTER_KIT_CONFIG,
  describeStarterKitConfig,
  loadStarterKitConfig,
  type StarterKitConfig,
} from './starter-kit.config';
import {
  STARTER_KIT,
  StarterKitService,
  type StarterKit,
  type StarterKitChain,
  type StarterKitSender,
} from './starter-kit.service';
import { FileStarterKitStore, STARTER_KIT_STORE, type StarterKitStore } from './starter-kit.store';
import { SqliteStarterKitStore } from './sqlite-starter-kit.store';

const configProvider: Provider = {
  provide: STARTER_KIT_CONFIG,
  useFactory: (): StarterKitConfig => {
    // Throws at boot on a bad env (or a key shared with the gas drip), never on a register.
    const config = loadStarterKitConfig();
    describeStarterKitConfig(config, new Logger('StarterKitConfig'));
    return config;
  },
};

/**
 * File-backed under `STATE_DIR` (a table in `sente.db` under
 * `STORE_BACKEND=sqlite`, SEN-205), so a redeploy does not send everybody a
 * second kit; in memory otherwise, like every other store here.
 */
const storeProvider: Provider = {
  provide: STARTER_KIT_STORE,
  // Injected so the STATE_DIR lock and the database are held before this store opens (SEN-161).
  inject: [SenteDbLease],
  useFactory: (lease: SenteDbLease): StarterKitStore =>
    selectStore<StarterKitStore>(lease, 'starter-kits.json', 'starter kit(s)', {
      memory: () => new FileStarterKitStore(),
      file: (path) => new FileStarterKitStore(path) as FileStarterKitStore & { path: string },
      sqlite: (db) => new SqliteStarterKitStore(db),
    }),
};

const starterKitProvider: Provider = {
  provide: STARTER_KIT,
  inject: [STARTER_KIT_CONFIG, STARTER_KIT_STORE],
  useFactory: (config: StarterKitConfig, store: StarterKitStore): StarterKit => {
    const logger = new Logger('StarterKit');
    if (!config.enabled) {
      return new StarterKitService({ config, store, sender: null, chain: null, log: logger });
    }

    const transport = http(config.rpcUrl, { retryCount: 2 });
    const client = createPublicClient({ chain: monadTestnet, transport });
    const account = privateKeyToAccount(config.senderKey);
    const wallet = createWalletClient({ account, chain: monadTestnet, transport });
    // Its own key, its own nonce sequence: the config refuses a key the gas
    // drip also sends from.
    const sender: StarterKitSender = new NonceManagedSender(
      account.address,
      { getTransactionCount: (args) => client.getTransactionCount(args) },
      {
        // Explicit `gas`, never estimated — Monad charges the limit (gotcha 4).
        sendTransaction: (args) =>
          wallet.sendTransaction({
            to: args.to,
            value: args.value,
            gas: args.gas,
            nonce: args.nonce,
            data: args.data,
          }),
      },
    );
    const chain: StarterKitChain = {
      balanceOf: (token, holder) =>
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [holder],
        }),
      waitForReceipt: async (hash, timeoutMs) =>
        (await client.waitForTransactionReceipt({ hash, timeout: timeoutMs })).status,
    };
    logger.log(`starter kit sender: ${account.address}`);
    return new StarterKitService({ config, store, sender, chain, log: logger });
  },
};

/** The SEN-170 starter kit, used by `WalletModule` after a register. */
@Module({
  imports: [StateModule],
  providers: [configProvider, storeProvider, starterKitProvider],
  exports: [STARTER_KIT],
})
export class StarterKitModule {}
