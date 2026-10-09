/**
 * The phone's copy of its Perpl api-key token, per wallet (SEN-104).
 *
 * The token names the enrolled trade key to Perpl; it is useless without the
 * key, which is re-derived from the passkey every session and never stored
 * (`auth/perplKey.ts`). So it is a hint like the credential hint, and lives in
 * `platform/kv` beside it. The server keeps the same token (SEN-174); this copy
 * is what lets the phone keep trading when the server has lost it, instead of
 * enrolling again and burning one of the account's 16 key slots.
 */
import type { Address } from 'viem';

import * as SecureStore from '@/platform/kv';

import type { PerplApiKeyStore } from './flow';

/** expo-secure-store keys allow `[A-Za-z0-9._-]`; an address fits. */
const keyOf = (wallet: Address) => `sente.perpl.apiKey.${wallet.toLowerCase()}`;

export const perplApiKeys: PerplApiKeyStore & {
  load(wallet: Address): Promise<string | null>;
} = {
  async load(wallet) {
    try {
      return await SecureStore.getItemAsync(keyOf(wallet));
    } catch {
      return null;
    }
  },
  save: (wallet, apiKey) => SecureStore.setItemAsync(keyOf(wallet), apiKey),
};
