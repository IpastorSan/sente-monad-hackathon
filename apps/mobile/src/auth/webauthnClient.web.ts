/**
 * Web twin of `webauthnClient.ts`: no client, so mera uses its default browser
 * client over `navigator.credentials`. That default only runs on a secure origin
 * whose host is `sente.lol` or a subdomain of it (the rpId, which is permanent),
 * so passkeys cannot be exercised from `http://localhost`. See `docs/web.md`.
 */
import type { WebAuthnClient } from '@category-labs/mera';

export const webAuthnClient: WebAuthnClient | undefined = undefined;
