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
 * The two ways a browser's `navigator.credentials` refuses that deserve their own
 * words (SEN-165), found by the DOMException `name` anywhere on the cause chain
 * (mera wraps the rejection as `PASSKEY_OPERATION_FAILED`).
 *
 * - `NotAllowedError` is deliberately vague in the spec, for privacy. On the
 *   SEN-165 harness (headless Chrome, CDP virtual authenticator) a timeout, a
 *   failed user verification and a sign-in with no passkey for `sente.lol` all
 *   produced it with the same message; the spec gives a dismissed dialog the
 *   same answer. So the copy covers all of them, and none of them is a bug.
 * - `SecurityError` is a page not on the rpId: anything but `sente.lol` or a
 *   subdomain (`localhost` included) can never use a Sente passkey.
 *
 * Android's native rejections are plain objects without these names, so this
 * never fires there.
 */
function browserRejection(error: unknown): Omit<AuthErrorDescription, 'code'> | undefined {
  const names = new Set<string>();
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current) && seen.size < 4) {
    seen.add(current);
    const name = (current as { name?: unknown }).name;
    if (typeof name === 'string') names.add(name);
    current = (current as { cause?: unknown }).cause;
  }
  if (names.has('NotAllowedError')) {
    return {
      title: 'Passkey cancelled',
      detail:
        'The passkey dialog was closed, timed out, or found no Sente passkey here. ' +
        'Try again — if your passkey is on your phone, pick "Use a phone or tablet" ' +
        'and scan the QR code.',
    };
  }
  if (names.has('SecurityError')) {
    return {
      title: 'Passkeys only work on sente.lol',
      detail:
        'Sente passkeys belong to sente.lol, and the browser will not use them on any ' +
        'other address. Open https://sente.lol and sign in there.',
    };
  }
  return undefined;
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
          "Google Password Manager, then try again — a passkey in Chrome's local store " +
          'on Android has no PRF extension and cannot derive a wallet.',
      };
    case 'PASSKEY_OPERATION_FAILED': {
      const browser = browserRejection(error);
      if (browser !== undefined) return { code: error.code, ...browser };
      return {
        code: error.code,
        title: 'Passkey ceremony failed',
        detail: `${detail} (cancelled, unavailable, or sente.lol is not associated with this build — check assetlinks.json)`,
      };
    }
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
