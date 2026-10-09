/**
 * Small persistent key-value store: sign-in hints and UI flags, nothing else.
 *
 * On Android this IS `expo-secure-store` (the Keystore-backed native module).
 * On web, Metro picks `kv.web.ts` instead, which stores the same strings in
 * `window.localStorage`, because `expo-secure-store` has no web implementation.
 *
 * Nothing secret goes through here on either platform: key material is
 * re-derived from the passkey every session, and neither it nor the session
 * token is ever written here (on web, a tab-scoped sealed copy of both lives in
 * sessionStorage — `auth/sessionSeal.web.ts`). Keep it that way — localStorage
 * is readable by any script on the origin.
 *
 * This is the only module that may import `expo-secure-store`.
 */
export { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store';
