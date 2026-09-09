/**
 * Persistence for the passkey sign-in hint.
 *
 * WHAT IS STORED IS NOT A SECRET. `credentialId` and `transports` are hints
 * that let WebAuthn skip the credential picker and let the platform prefer the
 * right transport. Losing them costs a tap, not an account: `signIn()` with no
 * credential falls back to any discoverable credential for `sente.lol`, and
 * because the key is derived rather than stored, the same passkey rebuilds the
 * same address on a wiped install or a different phone.
 *
 * They live in `expo-secure-store` anyway — the Android Keystore is the right
 * default for anything account-shaped, and it costs nothing.
 */
import * as SecureStore from 'expo-secure-store';

import type { StoredCredential } from './mera';

const KEY = 'sente.passkey.credential.v1';

type Persisted = {
  credentialId: string;
  transports?: string[];
};

function isPersisted(value: unknown): value is Persisted {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.credentialId !== 'string' || candidate.credentialId.length === 0) {
    return false;
  }
  if (candidate.transports === undefined) return true;
  return (
    Array.isArray(candidate.transports) && candidate.transports.every((t) => typeof t === 'string')
  );
}

/**
 * Reads the stored hint, or `null` if there is none.
 *
 * Never throws: a corrupt or unreadable entry is treated as absent, because the
 * only consequence is one extra tap in the credential picker.
 */
export async function loadCredential(): Promise<StoredCredential | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPersisted(parsed)) return null;
    return {
      credentialId: parsed.credentialId,
      ...(parsed.transports !== undefined ? { transports: parsed.transports } : {}),
    };
  } catch {
    return null;
  }
}

/** Writes the hint. Failures are swallowed for the same reason as above. */
export async function saveCredential(credential: StoredCredential): Promise<void> {
  const persisted: Persisted = {
    credentialId: credential.credentialId,
    ...(credential.transports !== undefined ? { transports: [...credential.transports] } : {}),
  };
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(persisted));
  } catch {
    // Ignored: the hint is an optimisation, not state we depend on.
  }
}

/**
 * Clears the hint.
 *
 * This is the "stateless" test on device: after clearing, signing in again must
 * still reach the same address, which proves nothing account-defining is stored
 * locally.
 */
export async function clearCredential(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    // Ignored.
  }
}
