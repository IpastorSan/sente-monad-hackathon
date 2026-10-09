/**
 * The browser and WebAuthn authenticator shared by `prf-equivalence.ts` and
 * `web-reload-e2e.ts`, so both prove things against the same one.
 *
 * Google Chrome by default (`CHROME_PATH` overrides), and a CDP virtual
 * authenticator shaped like a platform passkey provider with PRF: CTAP 2.1,
 * internal transport, resident keys, user verification that always passes.
 */
import type { CDPSession } from 'playwright-core';

export const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable';

/** Enables WebAuthn on `cdp`'s page and adds the authenticator. Returns its id. */
export async function addPrfAuthenticator(cdp: CDPSession): Promise<string> {
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}
