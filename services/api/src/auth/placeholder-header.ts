/**
 * The header the placeholder auth mode trusts, and the one rule about it.
 *
 * It lives in its own file because two guards read it — `SessionAuthGuard` in
 * placeholder mode, and the deprecated `PlaceholderGasDripAuthGuard` that
 * `agents/leaderboard/` still binds — and neither should import the other.
 *
 * Anything that sets this header is authenticated as whoever it names, so it is
 * allowed only when `AUTH_PLACEHOLDER=1` outside production. It exists so the
 * curl recipes in `docs/` and the API scripts keep working without a passkey.
 */
export const PLACEHOLDER_USER_ID_HEADER = 'x-sente-user-id';

/** Conservative shape so a userId cannot smuggle separators into log lines or keys. */
const USER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** The header's value when it is present and well-formed; undefined otherwise. */
export function readPlaceholderUserId(request: {
  headers?: Record<string, unknown>;
}): string | undefined {
  const raw = request.headers?.[PLACEHOLDER_USER_ID_HEADER];
  const userId = typeof raw === 'string' ? raw.trim() : '';
  return USER_ID_PATTERN.test(userId) ? userId : undefined;
}
