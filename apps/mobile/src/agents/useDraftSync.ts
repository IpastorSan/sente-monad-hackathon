/**
 * Debounced persistence for a hire/fork/preset draft (SEN-190): read any
 * existing draft back once per key, save the screen's own snapshot to
 * `platform/kv` as it changes, and let the screen discard it.
 *
 * The serialize/parse/empty rules are each draft's own
 * (`hireDraft.ts`/`presetDraft.ts`), pure and unit-tested without a device;
 * this hook (and `useDraftRestoreBanner` below) are only the glue, so they
 * stay untested here and get exercised by the screens that use them.
 */
import { useEffect, useRef, useState } from 'react';

import { deleteItemAsync, getItemAsync, setItemAsync } from '@/platform/kv';

/** Long enough to not write on every keystroke; short enough that Close rarely beats it. */
const SAVE_DEBOUNCE_MS = 600;

export type DraftCodec<T> = {
  serialize: (value: T) => string;
  /** `null` for anything that doesn't parse — corrupt JSON, wrong version, wrong shape. */
  parse: (raw: string | null) => T | null;
  /** A value with nothing in it worth restoring: delete the key instead of writing it. */
  isEmpty: (value: T) => boolean;
};

export type DraftSync<T> = {
  /**
   * The draft read back for this key: `undefined` until that read settles,
   * `null` once it's known there's none (or it's just been discarded).
   */
  restored: T | null | undefined;
  /**
   * Drops the banner and deletes the stored draft. The caller resets its own
   * state to blank in the same action — once it does, the debounce effect
   * below sees that blank `value` next and deletes again rather than
   * writing, so nothing already in flight can resurrect what was discarded.
   */
  discard: () => void;
  /**
   * Deletes the stored draft and stops saving under this key for good. Call
   * this once, when the thing being drafted succeeds (a hire, a fork) —
   * unlike `discard`, the screen keeps whatever is on it (it's about to show
   * the hired/fork result), so a pending debounced save from the moment
   * before submit must not be allowed to write the draft back afterwards.
   */
  clear: () => void;
};

/**
 * `key === null` turns this into a no-op (not signed in, or amending — SEN-190
 * only drafts hire/fork/preset flows, never an amend's live mandate): nothing
 * is read, nothing is written, `restored` stays `null`.
 */
export function useDraftSync<T>(key: string | null, value: T, codec: DraftCodec<T>): DraftSync<T> {
  const [restored, setRestored] = useState<T | null | undefined>(key ? undefined : null);
  const settled = restored !== undefined;
  const latest = useRef(value);
  latest.current = value;
  /** Set once `clear()` runs, so nothing already in flight can write the draft back. */
  const done = useRef(false);
  /**
   * What's currently known to be under `key` in `platform/kv` — the exact
   * string just read, or `null` for "nothing (or deleted)". `save` skips the
   * I/O when it would write back exactly this, so restoring a draft and then
   * sitting on the screen doesn't immediately re-save the same bytes, and a
   * draft that's already empty doesn't re-issue `deleteItemAsync` on every
   * settled tick.
   */
  const lastPersisted = useRef<string | null>(null);

  const save = (k: string, v: T) => {
    if (done.current) return;
    const next = codec.isEmpty(v) ? null : codec.serialize(v);
    if (next === lastPersisted.current) return;
    lastPersisted.current = next;
    const op = next === null ? deleteItemAsync(k) : setItemAsync(k, next);
    void op.catch(() => undefined);
  };

  // One read per key, before any write under it can happen.
  useEffect(() => {
    done.current = false;
    lastPersisted.current = null;
    if (!key) {
      setRestored(null);
      return;
    }
    setRestored(undefined);
    let cancelled = false;
    getItemAsync(key).then(
      (raw) => {
        if (cancelled) return;
        lastPersisted.current = raw;
        setRestored(codec.parse(raw));
      },
      () => {
        if (!cancelled) setRestored(null);
      },
    );
    return () => {
      cancelled = true;
    };
    // `codec` is a module-level object literal built fresh each render by the
    // caller; only `key` (and parse, which is stable per draft module) should
    // restart the read.
  }, [key]);

  // The debounced write. `value` changing resets the timer (that's the
  // debounce); it only starts once the read above has settled, so a blank
  // first render can't race ahead of a draft that's still being restored.
  useEffect(() => {
    if (!key || !settled) return;
    const id = setTimeout(() => save(key, value), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [key, value, settled]);

  // Flush a pending save immediately on unmount (Close, Back to the router,
  // a successful submit) — the whole point is that leaving must not cost the
  // last debounce window's keystrokes. `latest` is a ref so this always sees
  // the newest value regardless of when `settled` last changed.
  useEffect(() => {
    if (!key || !settled) return;
    return () => save(key, latest.current);
  }, [key, settled]);

  const discard = () => {
    setRestored(null);
    lastPersisted.current = null;
    if (key) void deleteItemAsync(key).catch(() => undefined);
  };

  const clear = () => {
    done.current = true;
    discard();
  };

  return { restored, discard, clear };
}

/**
 * The ref-guarded "apply a restored draft once, then show a dismissable
 * banner" mechanics shared by every draft screen (`new.tsx`, `configure.tsx`)
 * — the one part of the wiring that has nothing screen-specific in it. Each
 * screen still owns its own merge, its own fresh-defaults builder, and its
 * own extra reset-on-discard steps; this only decides WHEN to call them.
 */
export function useDraftRestoreBanner<T>(
  key: string | null,
  restored: T | null | undefined,
  onRestore: (restored: T) => void,
): { banner: boolean; dismissBanner: () => void } {
  const [banner, setBanner] = useState(false);
  /** Applies a restored draft exactly once per key, the moment the read settles. */
  const appliedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!key || restored === undefined) return;
    if (appliedFor.current === key) return;
    appliedFor.current = key;
    if (restored === null) return;
    onRestore(restored);
    setBanner(true);
    // `onRestore` is a fresh closure every render; only `key`/`restored`
    // transitioning should ever re-run this, exactly once per key.
  }, [key, restored]);

  return { banner, dismissBanner: () => setBanner(false) };
}
