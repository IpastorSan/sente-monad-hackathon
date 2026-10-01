/**
 * The WebAuthn transport mera's ceremonies run over, split by platform.
 *
 * On Android this is mera's React Native client, which drives the Credential
 * Manager through `react-native-passkey`. On web, Metro picks
 * `webauthnClient.web.ts` instead, which exports `undefined`: mera's ceremonies
 * then fall back to their own default, the browser client over
 * `navigator.credentials` (`@category-labs/mera/dist/webauthn.js`). Keeping the
 * native import in this file keeps `react-native-passkey` out of the web bundle.
 *
 * The transport is the ONLY thing that differs. The rpId, the PRF salts and the
 * derivation are identical on both platforms, which is what lets one synced
 * passkey derive the same wallet on the phone and in a browser.
 */
import type { WebAuthnClient } from '@category-labs/mera';
import { reactNativeWebAuthnClient } from '@category-labs/mera/react-native-webauthn-client';

export const webAuthnClient: WebAuthnClient | undefined = reactNativeWebAuthnClient;
