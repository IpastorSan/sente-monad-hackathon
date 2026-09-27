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
 * would mean a dev-client rebuild. Home reads this same hook (SEN-144): it used
 * to keep its own copy under another key, so the eye on one tab did nothing
 * to the other.
 *
 * Until the stored value is read the figures show: a first frame of dots on
 * every launch would be worse than one frame of numbers for the few who hide.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

const KEY = 'sente.pref.hideBalances.v1';
/**
 * Home's own key before SEN-144. Read only while the shared key has never
 * been written, so someone who hid balances on Home still finds them hidden,
 * then deleted so it can never override a later choice.
 */
const LEGACY_HOME_KEY = 'sente.home.hideBalances';

let hidden = false;
let loaded = false;
/** Set by a toggle: a stored value that arrives after it is older than the choice. */
let touched = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** The saved choice, adopting Home's old one the first time (see `LEGACY_HOME_KEY`). */
async function readStored(): Promise<boolean> {
  const value = await SecureStore.getItemAsync(KEY);
  if (value !== null) return value === '1';
  const legacy = await SecureStore.getItemAsync(LEGACY_HOME_KEY);
  if (legacy === null) return false;
  // Written before the old key goes, so a failure in between re-reads it next
  // launch instead of forgetting it. A toggle this session already wrote KEY.
  if (!touched) await SecureStore.setItemAsync(KEY, legacy);
  await SecureStore.deleteItemAsync(LEGACY_HOME_KEY);
  return legacy === '1';
}

function load(): void {
  if (loaded) return;
  loaded = true;
  readStored().then(
    (value) => {
      if (value && !touched && !hidden) {
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
  touched = true;
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
