/**
 * Account (SEN-55): who you are to Sente, and the tools that are for us rather
 * than for you. The passkey's signing key lives here, not on Home — it
 * authorises the wallet but does not hold funds, and showing it next to the
 * balance is how money gets sent to the wrong address. The rpId and the
 * stateless "forget this passkey" test moved here from the old home screen.
 *
 * Signing out needs no navigation: the tabs layout redirects to `/welcome` the
 * moment the session is no longer `ready`.
 */
import { Text } from 'react-native';

import { RP_ID } from '@/auth';
import { MONAD_NETWORK, monadChain } from '@/chain';
import { useSession } from '@/session';
import { ActionRow, Notice, Row, Screen, Section } from '@/ui/kit';
import { text } from '@/ui/theme';

export default function Account() {
  const { auth, wallet } = useSession();
  const { address, error, signOut, forget } = auth;

  return (
    <Screen tabbed>
      <Text style={[text.display, { marginTop: 48 }]}>Account</Text>

      <Section label="Wallet">
        <Row label="Address to fund" value={wallet.wallet?.address ?? '—'} mono />
        <Row label="Network" value={`${monadChain.name} · ${MONAD_NETWORK}`} />
      </Section>

      <Section label="Passkey">
        <Row label="Signing key" value={address ?? '—'} mono />
        <Text style={[text.caption, { marginTop: 8 }]}>
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
        <ActionRow
          icon="stop"
          title="Forget this passkey"
          detail="Stateless test: sign out, drop the hint, sign in again — same wallet."
          danger
          onPress={() => void forget()}
        />
        <Text style={[text.caption, { marginTop: 12 }]}>
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
