import { Logger, Module, type Provider } from '@nestjs/common';

import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { monadChainProviders } from './chain/monad-chain.providers';
import { GasController } from './gas.controller';
import {
  GAS_DRIP_CONFIG,
  describeGasDripConfig,
  loadGasDripConfig,
  type GasDripConfig,
} from './gas.config';
import { GasDripService } from './gas.service';
import { DRIP_LEDGER } from './ledger/drip-ledger';
import { InMemoryDripLedger } from './ledger/in-memory-drip-ledger';
import { IP_RATE_LIMITER, IpRateLimiter } from './rate-limit/ip-rate-limiter';

const configProvider: Provider = {
  provide: GAS_DRIP_CONFIG,
  useFactory: (): GasDripConfig => {
    // Throws at boot on a bad env rather than on the first request.
    const config = loadGasDripConfig();
    describeGasDripConfig(config, new Logger('GasDripConfig'));
    return config;
  },
};

/**
 * PERSISTENCE: `DRIP_LEDGER` is bound to the in-memory implementation because
 * this repo has no database yet. Point this token at a real store and the rest
 * of the module is unchanged — see `ledger/drip-ledger.ts`.
 */
const ledgerProvider: Provider = {
  provide: DRIP_LEDGER,
  useClass: InMemoryDripLedger,
};

const rateLimiterProvider: Provider = {
  provide: IP_RATE_LIMITER,
  inject: [GAS_DRIP_CONFIG],
  useFactory: (config: GasDripConfig): IpRateLimiter =>
    new IpRateLimiter(config.rateLimit.max, config.rateLimit.windowMs),
};

/**
 * AUTH: `Auth` is bound to the request-context reader fed by
 * `SessionAuthGuard` (SEN-37), which verifies the caller's session token.
 */
const authProvider: Provider = {
  provide: Auth,
  useClass: RequestContextAuth,
};

@Module({
  controllers: [GasController],
  providers: [
    configProvider,
    ledgerProvider,
    rateLimiterProvider,
    authProvider,
    ...monadChainProviders,
    SessionAuthGuard,
    GasDripService,
  ],
  exports: [GasDripService],
})
export class GasModule {}
