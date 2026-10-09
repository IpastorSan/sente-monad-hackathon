import { Logger, Module, type Provider } from '@nestjs/common';

import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { statePath } from '../state/json-file';
import { StateDirLease, StateModule } from '../state/state.module';
import { CREATOR_FEES, CREATOR_FEES_FILE, CreatorFeeLedger } from './creator-fees';
import { CreatorsController } from './creators.controller';

/** `creator-fees.json` under `STATE_DIR`, in memory otherwise, like every other store here. */
const ledgerProvider: Provider = {
  provide: CREATOR_FEES,
  // Injected only so the STATE_DIR lock is held before this file opens (SEN-161).
  inject: [StateDirLease],
  useFactory: (_lease: StateDirLease): CreatorFeeLedger => {
    const path = statePath(CREATOR_FEES_FILE);
    const ledger = new CreatorFeeLedger(path);
    if (path) Logger.log(`${ledger.size} creator fee record(s) loaded from ${path}`, 'CreatorFees');
    return ledger;
  },
};

/**
 * Sente's fees (SEN-184): the creator ledger and `GET /creators/me/fees`.
 * Exports the ledger for the agents module, which records a share off every
 * fee-paying fill of a forked agent. Imports nothing from `agents/`.
 */
@Module({
  imports: [StateModule],
  controllers: [CreatorsController],
  providers: [ledgerProvider, SessionAuthGuard, { provide: Auth, useClass: RequestContextAuth }],
  exports: [CREATOR_FEES],
})
export class FeesModule {}
