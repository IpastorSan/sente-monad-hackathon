/**
 * Account (SEN-55, restyled in SEN-57): who you are to Sente, and the tools
 * that are for us rather than for you. The passkey's signing key lives here,
 * not on Home — it authorises the wallet but does not hold funds, and showing
 * it next to the balance is how money gets sent to the wrong address. The
 * rpId and the stateless "forget this passkey" test moved here from the old
 * home screen, and so did the Chrome/PRF note, which Welcome now also gives as
 * a one-time tip right before the first passkey is made.
 *
 * Signing out needs no navigation: the tabs layout redirects to `/welcome` the
 * moment the session is no longer `ready`.
 */
import Constants from 'expo-constants';
import { StyleSheet, Text, View } from 'react-native';

import { RP_ID } from '@/auth';
import { MONAD_NETWORK, monadChain } from '@/chain';
import { useSession } from '@/session';
import { ActionRow, Notice, Row, Screen, Section } from '@/ui/kit';
import { text } from '@/ui/theme';

/** From `app.json`. Absent only in a bare test environment. */
const APP_VERSION = Constants.expoConfig?.version ?? '—';

export default function Account() {
  const { auth, wallet } = useSession();
  const { address, error, signOut, forget } = auth;

  return (
    <Screen tabbed>
      <View style={styles.head}>
        <Text style={text.display}>Account</Text>
      </View>

      <Section label="Wallet">
        <Row label="Address to fund" value={wallet.wallet?.address ?? '—'} mono />
        <Row label="Network" value={`${monadChain.name} · ${MONAD_NETWORK}`} />
        <Text style={[text.caption, styles.note]}>
          Send AUSD or USDC here to fund your agents. Gas is sponsored.
        </Text>
      </Section>

      <Section label="Passkey">
        <Row label="Signing key" value={address ?? '—'} mono />
        <Text style={[text.caption, styles.note]}>
          Derived from your passkey. It authorises your wallet; it does not hold your funds.
        </Text>
      </Section>

      <Section label="Session">
        <ActionRow
          icon="return"
          title="Sign out"
          detail="Your passkey stays on this phone."
          onPress={signOut}
        />
      </Section>

      <Section label="Developer">
        <Row label="rpId" value={RP_ID} mono />
        <Row label="Chain" value={String(monadChain.id)} mono />
        <Row label="App version" value={APP_VERSION} mono />
        <ActionRow
          icon="stop"
          title="Forget this passkey"
          detail="Stateless test: sign out, drop the hint, sign in again — same wallet."
          danger
          onPress={() => void forget()}
        />
        <Text style={[text.caption, styles.note]}>
          A passkey saved to Chrome&apos;s local store has no PRF extension and cannot derive a
          wallet. When the system sheet asks where to save, choose Google Password Manager.
        </Text>
      </Section>

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
  head: { height: 48, justifyContent: 'flex-end', marginTop: 24 },
  note: { marginTop: 10 },
});
