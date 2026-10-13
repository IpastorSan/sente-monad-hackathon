import { Module, type Provider } from '@nestjs/common';

import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { SenteDbLease, StateModule } from '../state/state.module';
import { selectStore } from '../state/store-backend';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { FileProfileStore, PROFILE_STORE, type ProfileStore } from './profile.store';
import { SqliteProfileStore } from './sqlite-profile.store';

/**
 * `profiles.json` under `STATE_DIR`, or a table in `sente.db` under
 * `STORE_BACKEND=sqlite` (SEN-205); in memory otherwise.
 */
const storeProvider: Provider = {
  provide: PROFILE_STORE,
  // Injected so the STATE_DIR lock and the database are held before this store opens (SEN-161).
  inject: [SenteDbLease],
  useFactory: (lease: SenteDbLease): ProfileStore =>
    selectStore<ProfileStore>(lease, 'profiles.json', 'profile(s)', {
      memory: () => new FileProfileStore(),
      file: (path) => new FileProfileStore(path) as FileProfileStore & { path: string },
      sqlite: (db) => new SqliteProfileStore(db),
    }),
};

const serviceProvider: Provider = {
  provide: ProfileService,
  inject: [PROFILE_STORE],
  useFactory: (store: ProfileStore) => new ProfileService(store),
};

/** The user's chosen name and avatar (SEN-172). */
@Module({
  imports: [StateModule],
  controllers: [ProfileController],
  providers: [
    storeProvider,
    serviceProvider,
    SessionAuthGuard,
    { provide: Auth, useClass: RequestContextAuth },
  ],
  // SEN-193: the public agent page shows an owner's chosen name.
  exports: [PROFILE_STORE],
})
export class ProfileModule {}
