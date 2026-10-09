/**
 * Web twin of `kv.ts`: the same three calls over `window.localStorage`.
 *
 * Async on purpose, so callers are identical on both platforms. Storage access
 * can throw (`SecurityError` with storage disabled, `QuotaExceededError` when
 * full); the throw becomes a rejected promise, which every caller already
 * handles because the native store rejects on Keystore failures too.
 *
 * Hints and UI flags only — see `kv.ts`. Never key material, never the token
 * (the sealed reload copy is in sessionStorage, not here).
 */

function storage(): Storage {
  return window.localStorage;
}

export async function getItemAsync(key: string): Promise<string | null> {
  return storage().getItem(key);
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  storage().setItem(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  storage().removeItem(key);
}
