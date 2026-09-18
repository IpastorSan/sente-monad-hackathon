import { Logger, Module, type Provider } from '@nestjs/common';
import { createPublicClient, http } from 'viem';
import { monadTestnet } from 'viem/chains';

import { PrivyClient } from '../agents/privy/privy.client';
import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { statePath } from '../state/json-file';
import {
  TOKEN_BALANCES,
  ViemTokenBalanceReader,
  type TokenBalanceReader,
} from './balances/token-balances';
import { BUNDLER, type Bundler } from './bundler/bundler';
import { PimlicoBundler } from './bundler/pimlico-bundler';
import {
  KERNEL_ACCOUNTS,
  PermissionlessKernelAccountFactory,
  type KernelAccountFactory,
} from './chain/kernel-account.factory';
import {
  OPERATION_TRACKER,
  PollingOperationTracker,
  type OperationTracker,
} from './confirmation/operation-tracker';
import { Erc7677Sponsorship, UnconfiguredSponsorship } from './paymaster/erc7677-sponsorship';
import { SPONSORSHIP, type Sponsorship } from './paymaster/sponsorship';
import {
  InMemoryPreparedOperationStore,
  PREPARED_OPERATION_STORE,
} from './store/prepared-operation-store';
import {
  InMemorySmartAccountRegistry,
  SMART_ACCOUNT_REGISTRY,
} from './store/smart-account-registry';
import { FileUserWalletRegistry } from './store/file-user-wallet-registry';
import {
  InMemoryUserWalletRegistry,
  USER_WALLET_REGISTRY,
  type UserWalletRegistry,
} from './store/user-wallet-registry';
import {
  PrivyUserWalletProvider,
  UnconfiguredUserWalletProvider,
  USER_WALLETS,
  type UserWalletProvider,
} from './user-wallet.provider';
import { UserWalletService } from './user-wallet.service';
import {
  describeWalletConfig,
  loadWalletConfig,
  WALLET_CONFIG,
  type WalletConfig,
} from './wallet.config';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

const MONAD_PUBLIC_CLIENT = Symbol('WALLET_MONAD_PUBLIC_CLIENT');

type MonadPublicClient = ReturnType<typeof createMonadPublicClient>;

function createMonadPublicClient(config: WalletConfig) {
  return createPublicClient({
    chain: monadTestnet,
    transport: http(config.rpcUrl, { retryCount: 2 }),
  });
}

const configProvider: Provider = {
  provide: WALLET_CONFIG,
  useFactory: (): WalletConfig => {
    // Throws at boot on a bad env rather than on the first UserOperation.
    const config = loadWalletConfig();
    describeWalletConfig(config, new Logger('WalletConfig'));
    return config;
  },
};

const publicClientProvider: Provider = {
  provide: MONAD_PUBLIC_CLIENT,
  inject: [WALLET_CONFIG],
  useFactory: (config: WalletConfig): MonadPublicClient => createMonadPublicClient(config),
};

const kernelAccountsProvider: Provider = {
  provide: KERNEL_ACCOUNTS,
  inject: [MONAD_PUBLIC_CLIENT],
  useFactory: (client: MonadPublicClient): KernelAccountFactory =>
    new PermissionlessKernelAccountFactory(client),
};

const bundlerProvider: Provider = {
  provide: BUNDLER,
  inject: [WALLET_CONFIG],
  useFactory: (config: WalletConfig): Bundler => new PimlicoBundler(config.bundlerUrl),
};

/**
 * PAYMASTER: bound to the ERC-7677 client when a policy is configured, and to
 * an implementation that refuses (and says so) when one is not. Swapping
 * Pimlico for Alchemy's Gas Manager is `WALLET_PAYMASTER_PROVIDER=alchemy` plus
 * `ALCHEMY_RPC_URL`/`ALCHEMY_GAS_POLICY_ID` — no code change, because both
 * speak ERC-7677. See `paymaster/sponsorship.ts`.
 */
const sponsorshipProvider: Provider = {
  provide: SPONSORSHIP,
  inject: [WALLET_CONFIG],
  useFactory: ({ paymaster }: WalletConfig): Sponsorship => {
    if (paymaster.provider === 'none' || !paymaster.url || !paymaster.policyId) {
      return new UnconfiguredSponsorship();
    }
    return new Erc7677Sponsorship(paymaster.provider, paymaster.url, paymaster.policyId);
  },
};

const trackerProvider: Provider = {
  provide: OPERATION_TRACKER,
  inject: [BUNDLER, WALLET_CONFIG],
  useFactory: (bundler: Bundler, config: WalletConfig): OperationTracker =>
    new PollingOperationTracker(bundler, {
      pollMs: config.confirmationPollMs,
      timeoutMs: config.confirmationTimeoutMs,
    }),
};

/**
 * PERSISTENCE: both stores are in memory because this repo has no database yet
 * — the same call `gas/ledger` made. Point these two tokens at a real store and
 * nothing else in `wallet/` changes.
 */
const registryProvider: Provider = {
  provide: SMART_ACCOUNT_REGISTRY,
  useClass: InMemorySmartAccountRegistry,
};

const preparedStoreProvider: Provider = {
  provide: PREPARED_OPERATION_STORE,
  useClass: InMemoryPreparedOperationStore,
};

/**
 * USER_WALLET_REGISTRY is the exception to the note above (SEN-48): set
 * `STATE_DIR` and it is file-backed, because losing THIS map costs a wallet.
 * A Privy wallet's address is not derivable from the device key, so a
 * forgotten binding does not mean "register again" — the next register mints a
 * second wallet and the funded one is unreachable from the product.
 */
const userWalletRegistryProvider: Provider = {
  provide: USER_WALLET_REGISTRY,
  useFactory: (): UserWalletRegistry => {
    const path = statePath('user-wallets');
    if (!path) return new InMemoryUserWalletRegistry();
    const registry = new FileUserWalletRegistry(path);
    Logger.log(`${registry.size} binding(s) loaded from ${registry.path}`, 'UserWalletRegistry');
    return registry;
  },
};

/**
 * USER_WALLETS: Privy when configured, and an implementation that refuses
 * (`user_wallets_unconfigured`) when not, so the API still boots without
 * credentials — the same call the paymaster and AGENT_WALLETS make.
 *
 * Its own `PrivyClient` rather than one borrowed from `AgentsModule`: the two
 * share app credentials and nothing else, and a user wallet must never be
 * reachable from a code path that holds the agent signing key.
 */
const userWalletsProvider: Provider = {
  provide: USER_WALLETS,
  inject: [WALLET_CONFIG],
  useFactory: ({ privy }: WalletConfig): UserWalletProvider =>
    privy
      ? new PrivyUserWalletProvider(
          new PrivyClient({ appId: privy.appId, appSecret: privy.appSecret }),
        )
      : new UnconfiguredUserWalletProvider(),
};

/** Balances for `GET /wallet`, over the same Monad client the rest of the module uses. */
const tokenBalancesProvider: Provider = {
  provide: TOKEN_BALANCES,
  inject: [MONAD_PUBLIC_CLIENT],
  useFactory: (client: MonadPublicClient): TokenBalanceReader =>
    new ViemTokenBalanceReader({
      getBalance: (args) => client.getBalance(args),
      readContract: (args) => client.readContract(args),
    }),
};

/**
 * AUTH: the shared seam rather than a second one of its own — `SessionAuthGuard`
 * verifies the session token and `Auth` reads the principal back out.
 */
const authProvider: Provider = {
  provide: Auth,
  useClass: RequestContextAuth,
};

/**
 * The user's account — two of them, for one release.
 *
 * **The Privy wallet (SEN-40) is the account from now on**: a server wallet
 * owned by the phone's device P-256 key, created here and signable only there.
 * `GET /wallet` and `POST /wallet/register` serve it.
 *
 * **The Kernel smart account is what it replaces**: gas-sponsored ERC-7579,
 * owned by the user's Mera EOA, built with `permissionless` because Privy could
 * not sponsor gas for an external EOA. `prepare` / `execute` / `operations`
 * still drive it and SEN-45 retires them.
 */
@Module({
  controllers: [WalletController],
  providers: [
    configProvider,
    publicClientProvider,
    kernelAccountsProvider,
    bundlerProvider,
    sponsorshipProvider,
    trackerProvider,
    registryProvider,
    preparedStoreProvider,
    userWalletRegistryProvider,
    userWalletsProvider,
    tokenBalancesProvider,
    authProvider,
    SessionAuthGuard,
    WalletService,
    UserWalletService,
  ],
  exports: [WalletService, UserWalletService],
})
export class WalletModule {}
