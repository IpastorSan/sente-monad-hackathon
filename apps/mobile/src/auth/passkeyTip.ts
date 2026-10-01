/**
 * Whether the user has seen the "save it to Google Password Manager" tip
 * (SEN-57), shown once, right before the first passkey is created.
 *
 * The tip exists because a passkey saved to Chrome's local store has no PRF
 * extension, so it can sign in to nothing: the wallet is derived from PRF
 * output (`derive.ts`), and without it there is no key. The system sheet asks
 * where to save a moment later, which is the only moment the advice is useful.
 *
 * Stored next to the credential hint, in `platform/kv`, and just as
 * disposable: losing the flag costs the user one extra read of the tip.
 */
import * as SecureStore from '@/platform/kv';

const KEY = 'sente.tip.passkey-manager.v1';

/** Never throws: an unreadable flag counts as unseen, which only shows the tip again. */
export async function hasSeenPasskeyTip(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(KEY)) === 'seen';
  } catch {
    return false;
  }
}

export async function markPasskeyTipSeen(): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, 'seen');
  } catch {
    // Ignored, for the same reason.
  }
}
