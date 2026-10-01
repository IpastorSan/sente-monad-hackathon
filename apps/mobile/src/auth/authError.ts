/**
 * Classifies a sign-in failure for display (`describeAuthError`).
 *
 * Kept free of React Native and of mera's native client so `authError.test.ts`
 * runs under plain node, without a device or a browser.
 */
import { isMeraError, type MeraErrorCode } from '@category-labs/mera';

/** A failure classified for display. `code` is `null` for non-mera errors. */
export type AuthErrorDescription = {
  readonly code: MeraErrorCode | null;
  readonly title: string;
  readonly detail: string;
};

/**
 * One link of the chain as text. A native module does not reject with an Error:
 * `react-native-passkey` rejects with a plain object, and `String(obj)` is
 * "[object Object]", which is how a real reason becomes a shrug. Prefer the
 * fields a native rejection actually carries, and fall back to JSON so nothing
 * is silently dropped.
 */
function describeOne(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const bag = value as Record<string, unknown>;
    const named = ['message', 'error', 'code', 'name', 'reason']
      .map((key) => (typeof bag[key] === 'string' ? (bag[key] as string) : undefined))
      .filter((part): part is string => part !== undefined && part.length > 0);
    if (named.length > 0) return [...new Set(named)].join(': ');
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

/**
 * The platform's own words, which are the only ones that identify the real
 * failure. mera wraps a native WebAuthn rejection as `PASSKEY_OPERATION_FAILED`
 * with the original on `cause`, and reading only `message` leaves the user (and
 * us) staring at "Passkey creation failed" while the reason sits one field away.
 * Walks the chain, because a cause can itself have one. Bounded, so a cycle or a
 * deep chain cannot hang the screen.
 */
function causeChain(error: unknown, depth = 4): string[] {
  const seen = new Set<unknown>();
  const out: string[] = [];
  let current: unknown = error;
  while (current !== null && current !== undefined && out.length < depth && !seen.has(current)) {
    seen.add(current);
    const message = describeOne(current);
    if (message.length > 0 && !out.includes(message)) out.push(message);
    current = current instanceof Error ? (current.cause as unknown) : undefined;
  }
  return out;
}

/**
 * Turns an error into something worth putting on screen.
 *
 * `PRF_UNAVAILABLE` is the one that matters in practice and the one that looks
 * like a bug in our code when it is not: Chrome's own local passkey store on
 * Android does not implement the PRF extension, so a passkey saved there
 * produces no key material. Google Password Manager does. The user has to pick
 * the right provider in the system sheet, and nothing but this message tells
 * them so.
 */
export function describeAuthError(error: unknown): AuthErrorDescription {
  const chain = causeChain(error);
  const detail = chain.join(' — ') || (error instanceof Error ? error.message : String(error));
  if (!isMeraError(error)) {
    return { code: null, title: 'Something went wrong', detail };
  }
  switch (error.code) {
    case 'PRF_UNAVAILABLE':
      return {
        code: error.code,
        title: 'This passkey cannot hold a wallet',
        detail:
          'The passkey provider did not return PRF key material. Save the passkey to ' +
          'Google Password Manager rather than Chrome, then try again — a Chrome-local ' +
          'passkey has no PRF extension and cannot derive a wallet.',
      };
    case 'PASSKEY_OPERATION_FAILED':
      return {
        code: error.code,
        title: 'Passkey ceremony failed',
        detail: `${detail} (cancelled, unavailable, or sente.lol is not associated with this build — check assetlinks.json)`,
      };
    case 'CRYPTO_UNAVAILABLE':
      return {
        code: error.code,
        title: 'Crypto unavailable',
        detail: `${detail} — the polyfill in src/polyfills.ts did not install; check the first import of index.ts.`,
      };
    case 'SESSION_ENDED':
      return { code: error.code, title: 'Session ended', detail: 'Sign in again to sign.' };
    default:
      return { code: error.code, title: error.code, detail };
  }
}
