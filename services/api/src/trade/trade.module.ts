import { Logger, Module, type Provider } from '@nestjs/common';
import { KuruVenue } from '@sente/venues/kuru';
import { PERPL_NETWORKS } from '@sente/venues/perpl';
import type { PublicClient } from 'viem';

import { PrivyClient } from '../agents/privy/privy.client';
import { agentSecretsKey } from '../agents/venues/file-agent-secret-store';
import { perplAccountReader } from '../agents/venues/perpl-agent';
import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { WriteSpacer } from '../spacing/write-spacer';
import { statePath } from '../state/json-file';
import { StateDirLease, StateModule } from '../state/state.module';
import { BUNDLER, type Bundler } from '../wallet/bundler/bundler';
import { USER_WALLETS, type UserWalletProvider } from '../wallet/user-wallet.provider';
import { SEND_SPACER } from '../wallet/user-wallet.service';
import { WALLET_CONFIG, type WalletConfig } from '../wallet/wallet.config';
import { MONAD_PUBLIC_CLIENT, WalletModule } from '../wallet/wallet.module';
import { TradeOutcomes } from './outcome';
import { cachedPerplContext, PERPL_CONTEXT } from './perpl-context';
import { PerplEnrollController } from './perpl-enroll.controller';
import {
  ENROLL_PERPL,
  ENROLL_PRIVY,
  PerplEnrollService,
  type EnrollPerpl,
  type EnrollPrivy,
} from './perpl-enroll.service';
import { StepExecutor } from './step-executor';
import { describeKuruBuilder } from '../fees/kuru-builder.config';
import { loadTradeConfig, TRADE_CONFIG, type TradeConfig } from './trade.config';
import { TradeController, TradingEnabledGuard } from './trade.controller';
import { TradeService } from './trade.service';
import { TradeStore } from './trade-store';
import { FileUserVenueSecretStore, USER_VENUE_SECRETS_FILE } from './file-user-venue-secrets';
import {
  InMemoryUserVenueSecretStore,
  USER_VENUE_SECRETS,
  type UserVenueSecretStore,
} from './user-venue-secrets';

const configProvider: Provider = {
  provide: TRADE_CONFIG,
  useFactory: (): TradeConfig => {
    const config = loadTradeConfig();
    // Said once at boot so "why is /trade 404?" is answered by the log.
    new Logger('TradeConfig').log(
      `manual trading ${config.enabled ? 'on' : 'off'}` +
        (config.enabled
          ? `, atomic batch ${config.atomicBatch ? 'on' : 'off'}, perps ${config.perpl ? 'on' : 'off'}`
          : ''),
    );
    new Logger('TradeConfig').log(describeKuruBuilder(config.kuruBuilder ?? null));
    return config;
  },
};

/**
 * One executor for the process: its per-wallet mutex only keeps two trades
 * from interleaving if every trade goes through the same instance. Its sends go
 * through the wallet module's own SEND_SPACER, never a second one (SEN-83).
 */
const stepExecutorProvider: Provider = {
  provide: StepExecutor,
  inject: [TradeStore, USER_WALLETS, BUNDLER, SEND_SPACER, WALLET_CONFIG, TradeOutcomes],
  useFactory: (
    store: TradeStore,
    wallets: UserWalletProvider,
    bundler: Bundler,
    spacer: WriteSpacer,
    config: WalletConfig,
    outcomes: TradeOutcomes,
  ): StepExecutor =>
    new StepExecutor({
      store,
      wallets,
      bundler,
      spacer,
      outcomes,
      options: { pollMs: config.confirmationPollMs, timeoutMs: config.confirmationTimeoutMs },
    }),
};

/**
 * One fill decoder shared by the executor and the service's reconcile-on-read
 * (SEN-97). The account id is read per call rather than cached here: a user's
 * first trade registers it, and `KuruVenue` caches only a real one.
 */
const outcomesProvider: Provider = {
  provide: TradeOutcomes,
  inject: [MONAD_PUBLIC_CLIENT],
  useFactory: (client: PublicClient): TradeOutcomes =>
    new TradeOutcomes({
      accountId: (wallet) => new KuruVenue({ publicClient: client, account: wallet }).accountId(),
    }),
};

/**
 * Perpl enrollment (SEN-100) signs through the USER's Privy wallet, so it gets
 * a client with the app credentials and nothing else — never one that holds
 * the agent signing key, the same line `WalletModule` draws for USER_WALLETS.
 * Null without credentials; the service then refuses `user_wallets_unconfigured`.
 */
const enrollPrivyProvider: Provider = {
  provide: ENROLL_PRIVY,
  inject: [WALLET_CONFIG],
  useFactory: ({ privy }: WalletConfig): EnrollPrivy | null =>
    privy ? new PrivyClient({ appId: privy.appId, appSecret: privy.appSecret }) : null,
};

/** Testnet only, like every other trading table (threat model, "Mainnet"). */
const enrollPerplProvider: Provider = {
  provide: ENROLL_PERPL,
  inject: [MONAD_PUBLIC_CLIENT],
  useFactory: (client: PublicClient): EnrollPerpl => ({
    network: PERPL_NETWORKS.testnet,
    accountOf: perplAccountReader(client),
  }),
};

/**
 * In memory unless `STATE_DIR` is set; then sealed on disk under
 * `AGENT_SECRETS_KEY` (SEN-174), so a restart keeps every user's Perpl read key
 * and trade token instead of unlinking them. `agentSecretsKey()` throws without
 * the key, and a wrong key fails the load: both stop the boot.
 */
export function userVenueSecretStore(
  env: Record<string, string | undefined> = process.env,
): UserVenueSecretStore {
  const path = statePath(USER_VENUE_SECRETS_FILE, env);
  if (!path) return new InMemoryUserVenueSecretStore();
  const store = new FileUserVenueSecretStore(path, agentSecretsKey(env));
  new Logger('UserVenueSecrets').log(`${store.size} user(s)' Perpl keys loaded from ${store.path}`);
  return store;
}

/**
 * AUTH: the same seam `wallet/` and `agents/` use — `Auth` reads back the
 * principal `SessionAuthGuard` verified for this request.
 */
const authProvider: Provider = { provide: Auth, useClass: RequestContextAuth };

/**
 * The user's own manual trades (SEN-83, plan M-T1): the feature flag, the
 * in-memory trade store and the step executor, and since SEN-96 (M-T14) the
 * `/trade` routes, which answer 404 `trading_disabled` with the flag off.
 *
 * TradeStore is a plain class provided as a singleton for the same reason the
 * executor is: prepare and commit must see the same trades.
 */
@Module({
  // StateModule: the STATE_DIR lock the user venue secrets file opens under (SEN-161).
  imports: [WalletModule, StateModule],
  controllers: [TradeController, PerplEnrollController],
  providers: [
    configProvider,
    authProvider,
    SessionAuthGuard,
    TradingEnabledGuard,
    TradeService,
    { provide: TradeStore, useFactory: () => new TradeStore() },
    outcomesProvider,
    stepExecutorProvider,
    // Perpl's live context for onboarding (SEN-99); one cache for the process.
    { provide: PERPL_CONTEXT, useFactory: () => cachedPerplContext() },
    enrollPrivyProvider,
    enrollPerplProvider,
    // One store per process: enrollment writes the read key Portfolio reads (M-T19).
    {
      provide: USER_VENUE_SECRETS,
      // Injected only so the STATE_DIR lock is held before this file opens (SEN-161).
      inject: [StateDirLease],
      useFactory: (_lease: StateDirLease) => userVenueSecretStore(),
    },
    PerplEnrollService,
  ],
  exports: [TRADE_CONFIG, TradeStore, StepExecutor, TradeService, USER_VENUE_SECRETS],
})
export class TradeModule {}
