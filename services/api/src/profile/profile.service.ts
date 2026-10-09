import { HttpException, HttpStatus } from '@nestjs/common';

import type { Principal } from '../auth/principal';
import { IpRateLimiter } from '../gas/rate-limit/ip-rate-limiter';
import type { ProfileResponseDto, UpdateProfileDto } from './dto/profile.dto';
import { nameProblem, normalizeName } from './profile-rules';
import type { ProfileStore, ProfileView } from './profile.store';

/** Writes per user per window: enough to re-roll through a few dozen faces, not to hammer the disk. */
export const PROFILE_WRITES_PER_WINDOW = 30;
export const PROFILE_WRITE_WINDOW_MS = 60_000;

/**
 * The user's name and avatar overrides (SEN-172). The defaults are not here:
 * they are derived on the device from the address, so this only ever stores
 * what someone chose.
 */
export class ProfileService {
  readonly #store: ProfileStore;
  readonly #writes: IpRateLimiter;

  constructor(
    store: ProfileStore,
    writes = new IpRateLimiter(PROFILE_WRITES_PER_WINDOW, PROFILE_WRITE_WINDOW_MS),
  ) {
    this.#store = store;
    this.#writes = writes;
  }

  get(principal: Principal): ProfileResponseDto {
    return this.#store.get(principal.userId);
  }

  /**
   * Applies the fields present in `body`. 400 `invalid_name` for a name
   * outside the rules (after trimming), 400 `empty_patch` for a body with
   * neither field, 429 `rate_limited` past the write budget.
   */
  update(principal: Principal, body: UpdateProfileDto, now = new Date()): ProfileResponseDto {
    const patch: Partial<ProfileView> = {};
    if (typeof body.name === 'string') {
      const name = normalizeName(body.name);
      const problem = nameProblem(name);
      if (problem !== null) refuse(HttpStatus.BAD_REQUEST, 'invalid_name', problem);
      patch.name = name;
    } else if (body.name === null) {
      patch.name = null;
    }
    if (body.avatarSeed !== undefined) patch.avatarSeed = body.avatarSeed;
    if (Object.keys(patch).length === 0) {
      refuse(
        HttpStatus.BAD_REQUEST,
        'empty_patch',
        'Send name and/or avatarSeed (null resets either to the default)',
      );
    }
    if (!this.#writes.hit(principal.userId, now)) {
      refuse(
        HttpStatus.TOO_MANY_REQUESTS,
        'rate_limited',
        'Too many profile changes; try again in a minute',
      );
    }
    return this.#store.set(principal.userId, patch, now);
  }
}

/** The API's usual `{statusCode, reason, message}` refusal. */
function refuse(status: HttpStatus, reason: string, message: string): never {
  throw new HttpException({ statusCode: status, reason, message }, status);
}
