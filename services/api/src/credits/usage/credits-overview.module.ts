import { Module, type Provider } from '@nestjs/common';

import { AgentsModule } from '../../agents/agents.module';
import { Auth, RequestContextAuth } from '../../auth/principal';
import { SessionAuthGuard } from '../../auth/session-auth.guard';
import { CreditsModule } from '../credits.module';
import { CreditsOverviewController } from './credits-overview.controller';

const authProvider: Provider = {
  provide: Auth,
  useClass: RequestContextAuth,
};

/**
 * `GET /credits` (SEN-183). Its own module, above both `CreditsModule` and
 * `AgentsModule`: it needs the agent store and the run transcripts, and
 * `AgentsModule` imports `CreditsModule`, so neither of those can host it.
 * `CreditsModule` re-exports `CREDITS_CONFIG` for it.
 */
@Module({
  imports: [CreditsModule, AgentsModule],
  controllers: [CreditsOverviewController],
  providers: [authProvider, SessionAuthGuard],
})
export class CreditsOverviewModule {}
