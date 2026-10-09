/**
 * The signed-in user's name and avatar (SEN-172), held once in
 * `SessionProvider` so the Home header, the desktop rail and Account agree.
 *
 * Never waits on the network to render: the defaults are derived from the
 * address the moment there is one, the last answer this device saw is read
 * back from `platform/kv` (not secret: a display name and a counter), and
 * `GET /profile` replaces both when it lands. An edit shows at once and is
 * rolled back if the API refuses it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import * as SecureStore from '@/platform/kv';
import type { SessionAuth } from '@/wallet/api';

import { DEFAULT_PROFILE, parseProfile, ProfileApi, type Profile, type ProfilePatch } from './api';
import { identityOf, type Identity } from './identity';

export type UseProfile = {
  /** `null` until signed in. */
  readonly identity: Identity | null;
  /** Optimistic; rejects (after rolling back) when the API refuses. */
  update(patch: ProfilePatch): Promise<void>;
};

type Held = { address: string | null; profile: Profile };

const cacheKey = (address: string) => `sente.profile.v1.${address.toLowerCase()}`;

const same = (a: Profile, b: Profile) => a.name === b.name && a.avatarSeed === b.avatarSeed;

export function useProfile(address: string | null, auth: SessionAuth): UseProfile {
  const api = useMemo(() => (address ? new ProfileApi({ auth }) : null), [address, auth]);
  const [state, setState] = useState<Held>({ address, profile: DEFAULT_PROFILE });
  // Bumped by every edit: an answer that started before the latest edit is stale.
  const revision = useRef(0);

  // A different user (or none) starts from the defaults, in the render itself.
  const profile = state.address === address ? state.profile : DEFAULT_PROFILE;
  // What an edit rolls back to. Written in an effect, read only in `update`.
  const current = useRef(profile);
  useEffect(() => {
    current.current = profile;
  }, [profile]);

  // Keeps the same object when nothing changed, so the session does not re-render.
  const hold = useCallback(
    (held: Held) =>
      setState((prev) =>
        prev.address === held.address && same(prev.profile, held.profile) ? prev : held,
      ),
    [],
  );

  useEffect(() => {
    if (!address || !api) return;
    let live = true;
    const started = revision.current;
    let cached: Profile | null = null;
    const adopt = (next: Profile) => {
      if (live && revision.current === started) hold({ address, profile: next });
    };
    SecureStore.getItemAsync(cacheKey(address)).then(
      (text) => {
        if (text === null) return;
        cached = parseProfile(safeJson(text));
        adopt(cached);
      },
      () => undefined,
    );
    api.get().then(
      (fresh) => {
        adopt(fresh);
        if (cached === null || !same(cached, fresh)) void remember(address, fresh);
      },
      // The defaults (or the cached copy) stay up; the next sign-in asks again.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [address, api, hold]);

  const update = useCallback(
    async (patch: ProfilePatch) => {
      if (!address || !api) return;
      const before = current.current;
      const mine = ++revision.current;
      hold({ address, profile: { ...before, ...patch } });
      try {
        const saved = await api.update(patch);
        if (revision.current === mine) hold({ address, profile: saved });
        void remember(address, saved);
      } catch (error) {
        if (revision.current === mine) hold({ address, profile: before });
        throw error;
      }
    },
    [address, api, hold],
  );

  const identity = useMemo(
    () => (address ? identityOf(address, profile) : null),
    [address, profile],
  );
  return useMemo(() => ({ identity, update }), [identity, update]);
}

async function remember(address: string, profile: Profile): Promise<void> {
  try {
    await SecureStore.setItemAsync(cacheKey(address), JSON.stringify(profile));
  } catch {
    // A cache, nothing more.
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
