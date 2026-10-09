/**
 * Welcome: the one screen a signed-out user sees (SEN-55, restyled in SEN-57).
 * One job — get a passkey, or use the one this phone already knows — and
 * nothing else. The debugging tools that used to sit here (the rpId, "forget
 * this passkey") are on Account → Developer.
 *
 * The board above the pitch is the idea in one picture: stones inside a line
 * the enclave draws (`GobanHero`).
 *
 * The first "Create passkey" tap opens a one-time tip before the system sheet:
 * save it to Google Password Manager, because a passkey in Chrome's local store
 * has no PRF and cannot derive a wallet. Said here, right before the platform
 * asks where to save, it is advice; said on a static footer it was noise.
 *
 * On web the tip and the caption say the browser-specific things instead
 * (`PASSKEY_TIP`, SEN-165): save to Google Password Manager from Chrome or use a
 * phone through the QR code, and that some browsers prompt twice.
 *
 * Signing in lands on the tabs: the moment the session is `ready` this
 * redirects to `/`, so there is no "continue" step after the system sheet.
 */
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  hasSeenPasskeyTip,
  markPasskeyTipSeen,
  PASSKEY_CAPTION,
  PASSKEY_TIP,
} from '@/auth/passkeyTip';
import { useSession } from '@/session';
import { GobanHero } from '@/ui/GobanHero';
import { Mark, Pill } from '@/ui/goban';
import { Button, Notice, Screen, SHEET_MAX, Sheet } from '@/ui/kit';
import { color, text } from '@/ui/theme';

/** Default WebAuthn account name. The passkey is what identifies the user. */
const USER_NAME = 'sente';

/**
 * How long the tip sheet takes to slide away. The system passkey sheet is
 * started after it, so the platform UI does not open over a modal still
 * animating out.
 */
const SHEET_EXIT_MS = 300;

export default function Welcome() {
  const { auth } = useSession();
  const { status, hasCredential, error, createPasskey, signIn } = auth;

  // `null` until read. Unread counts as unseen: at worst the tip shows twice.
  const [tipSeen, setTipSeen] = useState<boolean | null>(null);
  const [tipOpen, setTipOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void hasSeenPasskeyTip().then((seen) => {
      if (live) setTipSeen(seen);
    });
    return () => {
      live = false;
    };
  }, []);

  if (status === 'ready') return <Redirect href="/" />;

  const busy = status === 'busy' || status === 'restoring';

  const create = () => {
    if (tipSeen) {
      void createPasskey(USER_NAME);
      return;
    }
    setTipOpen(true);
  };

  const createAfterTip = () => {
    setTipOpen(false);
    setTipSeen(true);
    void markPasskeyTipSeen();
    setTimeout(() => void createPasskey(USER_NAME), SHEET_EXIT_MS);
  };

  return (
    <Screen
      maxWidth={SHEET_MAX}
      footer={
        <>
          {hasCredential ? (
            <>
              <Button
                label="Sign in with passkey"
                kind="primary"
                icon="key"
                onPress={() => void signIn()}
                disabled={busy}
                busy={status === 'busy'}
              />
              <Button label="Create a new passkey" onPress={create} disabled={busy} />
            </>
          ) : (
            <>
              <Button
                label="Create passkey"
                kind="primary"
                icon="key"
                onPress={create}
                disabled={busy}
                busy={status === 'busy'}
              />
              <Button label="I already have one" onPress={() => void signIn()} disabled={busy} />
            </>
          )}
          <Text style={[text.caption, styles.center]}>{PASSKEY_CAPTION}</Text>
        </>
      }
    >
      <View style={styles.head}>
        <Mark />
        {/* `Pill` aligns itself to the start of its parent's cross axis. */}
        <View>
          <Pill label="Monad testnet" />
        </View>
      </View>

      <View style={styles.hero}>
        <GobanHero />
      </View>

      <View style={styles.pitch}>
        <Text style={[text.display, styles.headline]}>Take sente.</Text>
        <Text style={[text.body, styles.dim]}>
          Hire AI agents that trade for you on Monad — inside limits a secure enclave enforces,
          however the agent is prompted.
        </Text>
      </View>

      {error !== null ? (
        <Notice
          tone="error"
          title={error.code !== null ? `${error.title} · ${error.code}` : error.title}
          detail={error.detail}
        />
      ) : null}

      <Sheet visible={tipOpen} title={PASSKEY_TIP.title} onClose={() => setTipOpen(false)}>
        <Text style={[text.body, styles.dim]}>{PASSKEY_TIP.body}</Text>
        <Text style={[text.dim, styles.tipNote]}>{PASSKEY_TIP.note}</Text>
        <Button
          label="Create passkey"
          kind="primary"
          icon="key"
          onPress={createAfterTip}
          style={styles.tipButton}
        />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  hero: { marginTop: 20 },
  pitch: { marginTop: 28, gap: 14 },
  headline: { fontSize: 44, lineHeight: 48 },
  dim: { color: color.textDim },
  center: { textAlign: 'center' },
  tipNote: { marginTop: 10 },
  tipButton: { marginTop: 20 },
});
