import { Logger, Module, type Provider } from '@nestjs/common';
import { KuruVenue } from '@sente/venues/kuru';
import type { PublicClient } from 'viem';

import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { WriteSpacer } from '../spacing/write-spacer';
import { BUNDLER, type Bundler } from '../wallet/bundler/bundler';
import { USER_WALLETS, type UserWalletProvider } from '../wallet/user-wallet.provider';
import { SEND_SPACER } from '../wallet/user-wallet.service';
import { WALLET_CONFIG, type WalletConfig } from '../wallet/wallet.config';
import { MONAD_PUBLIC_CLIENT, WalletModule } from '../wallet/wallet.module';
import { TradeOutcomes } from './outcome';
import { StepExecutor } from './step-executor';
import { loadTradeConfig, TRADE_CONFIG, type TradeConfig } from './trade.config';
import { TradeController, TradingEnabledGuard } from './trade.controller';
import { TradeService } from './trade.service';
import { TradeStore } from './trade-store';

const configProvider: Provider = {
  provide: TRADE_CONFIG,
  useFactory: (): TradeConfig => {
    const config = loadTradeConfig();
    // Said once at boot so "why is /trade 404?" is answered by the log.
    new Logger('TradeConfig').log(
      `manual trading ${config.enabled ? 'on' : 'off'}` +
        (config.enabled ? `, atomic batch ${config.atomicBatch ? 'on' : 'off'}` : ''),
    );
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
  imports: [WalletModule],
  controllers: [TradeController],
  providers: [
    configProvider,
    authProvider,
    SessionAuthGuard,
    TradingEnabledGuard,
    TradeService,
    { provide: TradeStore, useFactory: () => new TradeStore() },
    outcomesProvider,
    stepExecutorProvider,
  ],
  exports: [TRADE_CONFIG, TradeStore, StepExecutor, TradeService],
})
export class TradeModule {}
