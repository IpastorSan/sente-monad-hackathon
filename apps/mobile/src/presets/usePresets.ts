/**
 * The Presets segment's data (SEN-114): the catalog and each preset's cohort
 * stats.
 *
 * The bundled catalog renders on the first frame, so the gallery never waits
 * on the network and never fails. `GET /presets` then replaces it when the API
 * serves the route; any failure keeps the bundled one. Stats are fetched per
 * preset and only decorate: a preset whose stats did not arrive simply has no
 * entry, and its card shows no stats line.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useSession } from '@/session';

import { isUnavailable, PresetsApi, type PresetDto, type PresetStatsDto } from './api';
import { bundledCatalog, type CatalogSource } from './catalog';
import { loadHirePreset, type HirePreset } from './served';

export type PresetsState = {
  presets: PresetDto[];
  source: CatalogSource;
  stats: ReadonlyMap<string, PresetStatsDto>;
};

const NO_STATS: ReadonlyMap<string, PresetStatsDto> = new Map();

export function usePresets(): {
  state: PresetsState;
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const session = useSession();
  // Gated on sign-in like `agents`: the routes are session-guarded, so before
  // that there is nothing to ask and the bundled catalog stands alone.
  const signedIn = session.agents !== null;
  const auth = session.api;
  const api = useMemo(() => (signedIn ? new PresetsApi({ auth }) : null), [signedIn, auth]);

  const [state, setState] = useState<PresetsState>(() => ({
    presets: bundledCatalog(),
    source: 'bundled',
    stats: NO_STATS,
  }));
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!api) return;
    let presets: PresetDto[] | null = null;
    try {
      const served = (await api.list()).presets;
      if (Array.isArray(served) && served.length > 0) presets = served;
    } catch (error) {
      // No route yet (404) or a blip: the bundled catalog is already showing.
      // Both routes ship together in B-T16b, so an API without the catalog
      // has no stats either — skip six requests that can only 404.
      if (isUnavailable(error)) {
        setState((prev) => ({ ...prev, stats: NO_STATS }));
        return;
      }
    }
    const ids = (presets ?? bundledCatalog()).map((preset) => preset.id);
    const results = await Promise.allSettled(ids.map((id) => api.stats(id)));
    const stats = new Map<string, PresetStatsDto>();
    results.forEach((result, i) => {
      const id = ids[i];
      if (result.status === 'fulfilled' && id !== undefined) stats.set(id, result.value);
    });
    setState((prev) => (presets !== null ? { presets, source: 'api', stats } : { ...prev, stats }));
  }, [api]);

  // Refetched on focus: a hire from a preset changes its "running" count.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return { state, refreshing, refresh };
}

export type HirePresetState =
  | HirePreset
  | { kind: 'loading' }
  /** `GET /presets` failed some other way than a missing route: retry rather than guess. */
  | { kind: 'error'; message: string };

/**
 * The preset to configure and hire (SEN-160): the server's version and specs
 * when it serves them, the bundle only when the route is missing. See
 * `served.ts`. `reload` asks again — after the API refused a hire because
 * the catalog moved, for one.
 */
export function useHirePreset(id: string | undefined): {
  state: HirePresetState;
  reload: () => void;
} {
  const session = useSession();
  const signedIn = session.agents !== null;
  const auth = session.api;
  const [state, setState] = useState<HirePresetState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) {
      setState({ kind: 'missing' });
      return;
    }
    let cancelled = false;
    // A reload keeps what is showing until the answer lands: dropping to
    // "loading" would unmount the configure form and lose the person's draft.
    if (attempt === 0) setState({ kind: 'loading' });
    loadHirePreset(signedIn ? new PresetsApi({ auth }) : null, id).then(
      (loaded) => {
        if (!cancelled) setState(loaded);
      },
      (error: unknown) => {
        if (cancelled) return;
        // A failed reload leaves a loaded form alone; the hire's own error says enough.
        setState((prev) =>
          prev.kind === 'ready'
            ? prev
            : {
                kind: 'error',
                message: error instanceof Error ? error.message : 'The preset catalog didn’t load.',
              },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, signedIn, auth, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
