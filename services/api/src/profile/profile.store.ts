// Erasable syntax and `.ts` specifiers: the SQLite store beside this file is
// loaded by the import script under node's type stripping (CLAUDE.md gotcha 10).
import { JsonRecordFile } from '../state/json-file.ts';

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
 * One record per user who changed their name or avatar. A record that goes
 * back to both defaults is deleted rather than kept as two nulls.
 *
 * `FileProfileStore` (in memory without a path) and `SqliteProfileStore`
 * (`STORE_BACKEND=sqlite`, SEN-205).
 */
export interface ProfileStore {
  get(userId: string): ProfileView;
  /** Applies the fields present in `patch` (absent = unchanged) and answers the result. */
  set(userId: string, patch: Partial<ProfileView>, now: Date): ProfileView;
}

/**
 * What `set` does to `previous`, shared by both stores: the next record, the
 * view to answer, and whether anything changed (nothing changed means nothing
 * is written; both fields back at the default means the record goes).
 */
export function applyProfilePatch(
  userId: string,
  previous: ProfileRecord | undefined,
  patch: Partial<ProfileView>,
  now: Date,
): { next: ProfileRecord; view: ProfileView; changed: boolean; empty: boolean } {
  const next: ProfileRecord = {
    userId,
    name: patch.name !== undefined ? patch.name : (previous?.name ?? null),
    avatarSeed: patch.avatarSeed !== undefined ? patch.avatarSeed : (previous?.avatarSeed ?? null),
    updatedAt: now,
  };
  return {
    next,
    view: { name: next.name, avatarSeed: next.avatarSeed },
    // Nothing changed ("Original" on the original face): no write.
    changed:
      next.name !== (previous?.name ?? null) || next.avatarSeed !== (previous?.avatarSeed ?? null),
    empty: next.name === null && next.avatarSeed === null,
  };
}

/**
 * With a path (`STATE_DIR` set) every mutation is written through to
 * `profiles.json`, like the other file-backed stores; in memory otherwise.
 */
export class FileProfileStore implements ProfileStore {
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

  set(userId: string, patch: Partial<ProfileView>, now: Date): ProfileView {
    const previous = this.#byUserId.get(userId);
    const { next, view, changed, empty } = applyProfilePatch(userId, previous, patch, now);
    if (!changed) return view;
    if (empty) this.#byUserId.delete(userId);
    else this.#byUserId.set(userId, next);
    try {
      this.#save();
    } catch (error) {
      // Unpersisted must not look persisted: put the old record back.
      if (previous) this.#byUserId.set(userId, previous);
      else this.#byUserId.delete(userId);
      throw error;
    }
    return view;
  }

  #save(): void {
    this.#file?.save([...this.#byUserId.values()]);
  }
}
