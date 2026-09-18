import { Logger, Module, type Provider } from '@nestjs/common';

import { AUTH_CONFIG, authConfig, describeAuthConfig, type AuthConfig } from './auth.config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CHALLENGE_STORE, InMemoryChallengeStore } from './challenge';
import { SessionAuthGuard } from './session-auth.guard';

/**
 * Session auth (SEN-37): the challenge/token routes, the store behind them, and
 * the guard every other module binds.
 *
 * The config provider is what makes a bad environment a failed BOOT rather than
 * a failed request — `authConfig()` throws on `AUTH_PLACEHOLDER=1` in
 * production and on a missing `AUTH_SESSION_SECRET` outside placeholder mode.
 * It is the same memoised value the guards read, so there is exactly one
 * answer to "how does this process authenticate".
 */
const configProvider: Provider = {
  provide: AUTH_CONFIG,
  useFactory: (): AuthConfig => {
    const config = authConfig();
    describeAuthConfig(config, new Logger('AuthConfig'));
    return config;
  },
};

/** PERSISTENCE: in memory, same reasoning as the prepared-operation store. */
const challengeStoreProvider: Provider = {
  provide: CHALLENGE_STORE,
  useClass: InMemoryChallengeStore,
};

@Module({
  controllers: [AuthController],
  providers: [configProvider, challengeStoreProvider, AuthService, SessionAuthGuard],
  exports: [AuthService, SessionAuthGuard],
})
export class AuthModule {}
