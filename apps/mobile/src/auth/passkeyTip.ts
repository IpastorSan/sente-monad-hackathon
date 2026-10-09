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
 *
 * The words differ by platform (SEN-165). On a phone the system sheet offers
 * Google Password Manager directly. In a desktop browser the advice is to save
 * to Google Password Manager from Chrome, or to hand the ceremony to an Android
 * phone through the browser's QR code ("Use a phone or tablet"), whose passkey
 * lives in Google Password Manager on the phone. Nothing else is recommended:
 * other desktop providers (Windows Hello, iCloud Keychain, a browser-local
 * profile) are unmeasured — see `docs/web.md` before adding one here.
 */
import { Platform } from 'react-native';

import * as SecureStore from '@/platform/kv';

export type PasskeyTipCopy = {
  readonly title: string;
  readonly body: string;
  readonly note: string;
};

const NATIVE_TIP: PasskeyTipCopy = {
  title: 'Save it to Google',
  body: 'When your phone asks where to save the passkey, choose Google Password Manager.',
  note: "A passkey saved to Chrome's own store can't create a wallet, and you would have to start again.",
};

const WEB_TIP: PasskeyTipCopy = {
  title: 'Save it to Google',
  body:
    'When Chrome asks where to save the passkey, choose Google Password Manager — ' +
    'signed in to Chrome, with sync on. Or choose "Use a phone or tablet" and scan ' +
    'the QR code with your Android phone.',
  note:
    'Some browsers ask twice: once for your wallet, once for the key that approves ' +
    "your agents. A passkey that can't derive keys can't create a wallet.",
};

/** The tip for this platform. */
export const PASSKEY_TIP: PasskeyTipCopy = Platform.OS === 'web' ? WEB_TIP : NATIVE_TIP;

/**
 * One line under the welcome buttons. Both keys come from one prompt where the
 * provider evaluates two PRF salts at once (SEN-176); the web tip above still
 * warns that some ask twice, because a second dialog unannounced reads as a bug.
 */
export const PASSKEY_CAPTION = 'No seed phrase. Your wallet is derived from the passkey.';

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
