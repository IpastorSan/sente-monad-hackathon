import { Logger, Module, type Provider } from '@nestjs/common';

import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { statePath } from '../state/json-file';
import { StateDirLease, StateModule } from '../state/state.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { PROFILE_STORE, ProfileStore } from './profile.store';

/** `profiles.json` under `STATE_DIR`, in memory otherwise, like every other store here. */
const storeProvider: Provider = {
  provide: PROFILE_STORE,
  // Injected only so the STATE_DIR lock is held before this file opens (SEN-161).
  inject: [StateDirLease],
  useFactory: (_lease: StateDirLease): ProfileStore => {
    const path = statePath('profiles');
    const store = new ProfileStore(path);
    if (path) Logger.log(`${store.size} profile(s) loaded from ${store.path}`, 'ProfileStore');
    return store;
  },
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
})
export class ProfileModule {}
