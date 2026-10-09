import { JsonRecordFile } from '../state/json-file';

/** DI token for the users' profile overrides. */
export const PROFILE_STORE = Symbol('PROFILE_STORE');

/**
 * What a user changed about how they appear (SEN-172). Both fields are
 * overrides: `null` means "the default", which the app derives from the
 * user's address, so a user who never touched Account has no record at all.
 */
export interface ProfileRecord {
  userId: string;
  name: string | null;
  avatarSeed: string | null;
  updatedAt: Date;
}

export type ProfileView = { name: string | null; avatarSeed: string | null };

/**
 * One record per user who changed their name or avatar.
 *
 * With a path (`STATE_DIR` set) every mutation is written through to
 * `profiles.json`, like the other file-backed stores; in memory otherwise. A
 * record that goes back to both defaults is deleted rather than kept as two
 * nulls.
 */
export class ProfileStore {
  readonly #file: JsonRecordFile<ProfileRecord> | undefined;
  readonly #byUserId = new Map<string, ProfileRecord>();

  constructor(path?: string) {
    this.#file = path ? new JsonRecordFile<ProfileRecord>(path) : undefined;
    for (const record of this.#file?.load() ?? []) this.#byUserId.set(record.userId, record);
  }

  get path(): string | undefined {
    return this.#file?.path;
  }

  get size(): number {
    return this.#byUserId.size;
  }

  get(userId: string): ProfileView {
    const record = this.#byUserId.get(userId);
    return { name: record?.name ?? null, avatarSeed: record?.avatarSeed ?? null };
  }

  /** Applies the fields present in `patch` (absent = unchanged) and answers the result. */
  set(userId: string, patch: Partial<ProfileView>, now: Date): ProfileView {
    const previous = this.#byUserId.get(userId);
    const next: ProfileRecord = {
      userId,
      name: patch.name !== undefined ? patch.name : (previous?.name ?? null),
      avatarSeed:
        patch.avatarSeed !== undefined ? patch.avatarSeed : (previous?.avatarSeed ?? null),
      updatedAt: now,
    };
    if (next.name === null && next.avatarSeed === null) this.#byUserId.delete(userId);
    else this.#byUserId.set(userId, next);
    try {
      this.#save();
    } catch (error) {
      // Unpersisted must not look persisted: put the old record back.
      if (previous) this.#byUserId.set(userId, previous);
      else this.#byUserId.delete(userId);
      throw error;
    }
    return { name: next.name, avatarSeed: next.avatarSeed };
  }

  #save(): void {
    this.#file?.save([...this.#byUserId.values()]);
  }
}
