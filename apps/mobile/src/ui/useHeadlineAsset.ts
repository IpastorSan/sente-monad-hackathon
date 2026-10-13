/**
 * The device's headline asset (SEN-213), shared by every total that shows one
 * — Home, Portfolio and the agent cockpit — so a pick on one shows on all.
 * Saved through `platform/kv`; the logic is in `headlineAsset.ts`.
 */
import { useSyncExternalStore } from 'react';

import * as kv from '@/platform/kv';

import { createHeadlinePreference } from './headlineAsset';

const preference = createHeadlinePreference(kv);

/** `[preferred asset or null, pick]`. */
export function useHeadlineAsset(): [string | null, (asset: string) => void] {
  const value = useSyncExternalStore(preference.subscribe, preference.get);
  return [value, (asset) => void preference.set(asset)];
}
