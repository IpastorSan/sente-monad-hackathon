/**
 * Native twin of `sessionSeal.web.ts`: nothing is sealed on Android.
 *
 * The app process does not "reload" the way a browser tab does, so there is
 * nothing to survive; a cold start signs in with the passkey as it always has.
 * Every function is a no-op with the web twin's signature, so callers need no
 * platform check. `sessionSeal.test.ts` pins that it stays a no-op.
 */
import type { SealedSession } from './sessionSealCore';

export type { SealedSession };

export async function sealSession(_session: SealedSession): Promise<void> {}

export async function unsealSession(): Promise<SealedSession | null> {
  return null;
}

export async function sealApiToken(
  _address: string,
  _token: string,
  _expiresAt: string | number,
): Promise<void> {}

export async function unsealApiToken(_address: string): Promise<string | null> {
  return null;
}

export async function clearSealedSession(): Promise<void> {}
