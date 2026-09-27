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
import { useCallback, useMemo, useState } from 'react';

import { useSession } from '@/session';

import { isUnavailable, PresetsApi, type PresetDto, type PresetStatsDto } from './api';
import { bundledCatalog, type CatalogSource } from './catalog';

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
