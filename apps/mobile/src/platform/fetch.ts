/**
 * The global `fetch`, callable from anywhere.
 *
 * The API clients keep their fetch on a field and call it as
 * `this.fetchImpl(...)`, which makes the client the receiver. React Native's
 * fetch does not care; a browser's does, and throws
 * `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation` on
 * every request (found in SEN-165: the web build signed in and then reached no
 * route at all). Calling through this wrapper always uses the global receiver.
 * The same shape `@sente/venues` uses in `perpl/rest.ts`.
 *
 * Looked up per call rather than captured, so a test that swaps
 * `globalThis.fetch` still reaches its fake.
 */
export const unboundFetch: typeof fetch = (input, init) => fetch(input, init);
