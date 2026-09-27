/**
 * "Hide balances", the eye on the Portfolio tab (SEN-118, plan U-12).
 *
 * The study makes it a device setting that applies app-wide, so it is one
 * module-level value every screen subscribes to: flip it on the tab and your
 * position screen underneath hides too, with no provider to thread through.
 *
 * Saved with expo-secure-store under ONE key because it is already a native
 * module in the app (the passkey hints use it) and no other persistence is;
 * a plain preference does not need the keystore, but a second storage module
 * would mean a dev-client rebuild. Home (SEN-113) should read this same hook
 * rather than keep a second copy of the preference.
 *
 * Until the stored value is read the figures show: a first frame of dots on
 * every launch would be worse than one frame of numbers for the few who hide.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

const KEY = 'sente.pref.hideBalances.v1';

let hidden = false;
let loaded = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function load(): void {
  if (loaded) return;
  loaded = true;
  SecureStore.getItemAsync(KEY).then(
    (value) => {
      if (value === '1' && !hidden) {
        hidden = true;
        emit();
      }
    },
    () => {
      // Unreadable store: keep showing figures; the toggle still works this session.
    },
  );
}

function subscribe(listener: () => void): () => void {
  load();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setBalancesHidden(next: boolean): void {
  hidden = next;
  emit();
  SecureStore.setItemAsync(KEY, next ? '1' : '0').catch(() => {
    // Not saved: it still applies until the app restarts.
  });
}

/** `[hidden, toggle]`, shared by every screen that shows a balance. */
export function useHideBalances(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, () => hidden);
  return [value, () => setBalancesHidden(!hidden)];
}
