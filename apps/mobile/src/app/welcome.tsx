/**
 * Welcome: the one screen a signed-out user sees (SEN-55). One job — get a
 * passkey, or use the one this phone already knows — and nothing else. The
 * debugging tools that used to sit here (the rpId, "forget this passkey") are
 * on Account → Developer.
 *
 * Signing in lands on the tabs: the moment the session is `ready` this
 * redirects to `/`, so there is no "continue" step after the system sheet.
 */
import { Redirect } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useSession } from '@/session';
import { Mark } from '@/ui/goban';
import { Button, Notice, Screen } from '@/ui/kit';
import { text } from '@/ui/theme';

/** Default WebAuthn account name. The passkey is what identifies the user. */
const USER_NAME = 'sente';

export default function Welcome() {
  const { auth } = useSession();
  const { status, hasCredential, error, createPasskey, signIn } = auth;

  if (status === 'ready') return <Redirect href="/" />;

  const busy = status === 'busy' || status === 'restoring';

  return (
    <Screen
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
              <Button
                label="Create a new passkey"
                onPress={() => void createPasskey(USER_NAME)}
                disabled={busy}
              />
            </>
          ) : (
            <>
              <Button
                label="Create passkey"
                kind="primary"
                icon="key"
                onPress={() => void createPasskey(USER_NAME)}
                disabled={busy}
                busy={status === 'busy'}
              />
              <Button label="I already have one" onPress={() => void signIn()} disabled={busy} />
            </>
          )}
          <Text style={[text.caption, styles.center]}>
            No seed phrase. Your wallet is derived from the passkey.
          </Text>
        </>
      }
    >
      <View style={styles.head}>
        <Mark />
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { height: 48, justifyContent: 'center' },
  pitch: { marginTop: 160, gap: 14 },
  headline: { fontSize: 44, lineHeight: 48 },
  dim: { color: '#AAA3CB' },
  center: { textAlign: 'center' },
});
