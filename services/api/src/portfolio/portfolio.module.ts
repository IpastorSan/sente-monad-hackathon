import { Module, type Provider } from '@nestjs/common';

import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { TradingEnabledGuard } from '../trade/trade.controller';
import { TradeModule } from '../trade/trade.module';
import { WalletModule } from '../wallet/wallet.module';
import { PortfolioController } from './portfolio.controller';
import { UserPortfolioService, userPortfolioProviders } from './portfolio.service';

/** AUTH: the same seam `wallet/` and `trade/` use. */
const authProvider: Provider = { provide: Auth, useClass: RequestContextAuth };

/**
 * `GET /portfolio` and `/portfolio/fills` (SEN-101). Imports `TradeModule` for
 * the flag and the SAME trade store the executor writes results into, and
 * `WalletModule` for the user-wallet registry and its Monad client.
 */
@Module({
  imports: [WalletModule, TradeModule],
  controllers: [PortfolioController],
  providers: [authProvider, SessionAuthGuard, TradingEnabledGuard, ...userPortfolioProviders],
  // SEN-152: the value history values a user through the same service, and its caches.
  exports: [UserPortfolioService],
})
export class PortfolioModule {}
