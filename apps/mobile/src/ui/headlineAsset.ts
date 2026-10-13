/**
 * Which asset a total shows as its headline figure (SEN-213).
 *
 * A total held in several assets is never summed into dollars (SEN-210), and
 * stacking every asset as a giant number buried the one that matters. So the
 * big figure is ONE asset's exact amount, and a dropdown beside it lists the
 * rest. By default that is the largest stablecoin holding (USDC on a tie);
 * picking another one is remembered on this device, for every total that
 * holds it, and a total that does not hold the picked asset falls back to its
 * default.
 *
 * Plain node, no React Native, so `headlineAsset.test.ts` runs with no device;
 * the hook that binds the preference to `platform/kv` is `useHeadlineAsset.ts`.
 */
import { compareAmounts, isZero, STABLE_ORDER, type AssetAmount } from './assetAmounts.ts';

/** The amounts actually held: a zero line is nothing to choose. */
export function heldAmounts(amounts: readonly AssetAmount[]): AssetAmount[] {
  return amounts.filter(({ amount }) => !isZero(amount) && compareAmounts(amount, '0') !== null);
}

/**
 * The default headline among `held`: the largest stablecoin, USDC winning a
 * tie; with no stablecoin held, the first asset listed. `null` for an empty
 * list.
 */
export function defaultHeadline(held: readonly AssetAmount[]): string | null {
  let best: AssetAmount | null = null;
  for (const asset of STABLE_ORDER) {
    const line = held.find((a) => a.asset === asset);
    if (line === undefined) continue;
    // Strictly greater, so the earlier stablecoin in STABLE_ORDER keeps a tie.
    if (best === null || (compareAmounts(line.amount, best.amount) ?? 0) > 0) best = line;
  }
  return best?.asset ?? held[0]?.asset ?? null;
}

export type Headline = {
  /** The line printed as the big figure. */
  readonly line: AssetAmount;
  /** Every held line, in printed order, for the dropdown; one or none means no dropdown. */
  readonly choices: readonly AssetAmount[];
};

/**
 * The headline for `amounts` given the device's `preferred` asset: that one if
 * it is held, the default otherwise. With nothing held it is the first line
 * (a `0.00 USDC`), or `null` when there is no line at all.
 */
export function headlineFor(
  amounts: readonly AssetAmount[],
  preferred: string | null,
): Headline | null {
  const held = heldAmounts(amounts);
  const asset =
    preferred !== null && held.some((a) => a.asset === preferred)
      ? preferred
      : defaultHeadline(held);
  const line = held.find((a) => a.asset === asset) ?? amounts[0];
  return line === undefined ? null : { line, choices: held };
}

/** The slice of `platform/kv` the preference needs; injected so tests use a fake. */
export type PreferenceStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};

export const HEADLINE_KEY = 'sente.pref.headlineAsset.v1';

/** A stored value worth using: an asset symbol, not junk from another version. */
function parseStored(value: string | null): string | null {
  return value !== null && /^[A-Za-z0-9.]{1,16}$/u.test(value) ? value : null;
}

/**
 * The device's picked headline asset as an external store: `get` is `null`
 * until something is read or picked. A failing store is tolerated both ways —
 * an unreadable one leaves the default, an unwritable one keeps the pick for
 * this session — and a pick made before the read lands is never overwritten
 * by the older stored value.
 */
export function createHeadlinePreference(store: PreferenceStore) {
  let preferred: string | null = null;
  let loaded = false;
  let touched = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  function load(): Promise<void> {
    if (loaded) return Promise.resolve();
    loaded = true;
    return store.getItemAsync(HEADLINE_KEY).then(
      (value) => {
        const stored = parseStored(value);
        if (stored === null || touched) return;
        preferred = stored;
        emit();
      },
      () => {
        // Unreadable store: the default headline stands.
      },
    );
  }

  return {
    get: (): string | null => preferred,
    load,
    subscribe(listener: () => void): () => void {
      void load();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(asset: string): Promise<void> {
      touched = true;
      preferred = asset;
      emit();
      return store.setItemAsync(HEADLINE_KEY, asset).catch(() => {
        // Not saved: the pick still applies until the app restarts.
      });
    },
  };
}
