import { Module, type Provider } from '@nestjs/common';

import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { SenteDbLease, StateModule } from '../state/state.module';
import { selectStore } from '../state/store-backend';
import {
  CREATOR_FEES,
  CREATOR_FEES_FILE,
  FileCreatorFeeLedger,
  type CreatorFeeLedger,
} from './creator-fees';
import { CreatorsController } from './creators.controller';
import { SqliteCreatorFeeLedger } from './sqlite-creator-fees';

/**
 * `creator-fees.json` under `STATE_DIR`, or a table in `sente.db` under
 * `STORE_BACKEND=sqlite` (SEN-205); in memory otherwise.
 */
const ledgerProvider: Provider = {
  provide: CREATOR_FEES,
  // Injected so the STATE_DIR lock and the database are held before this ledger opens (SEN-161).
  inject: [SenteDbLease],
  useFactory: (lease: SenteDbLease): CreatorFeeLedger =>
    selectStore<CreatorFeeLedger>(lease, `${CREATOR_FEES_FILE}.json`, 'creator fee record(s)', {
      memory: () => new FileCreatorFeeLedger(),
      file: (path) => new FileCreatorFeeLedger(path) as FileCreatorFeeLedger & { path: string },
      sqlite: (db) => new SqliteCreatorFeeLedger(db),
    }),
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
