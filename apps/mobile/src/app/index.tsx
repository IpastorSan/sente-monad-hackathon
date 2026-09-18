/**
 * Home: the passkey, and the wallet that passkey owns.
 *
 * This is the first screen anyone sees, so it answers the two questions that
 * matter in order — am I signed in, and what do I hold. The AUSD figure leads
 * because it is what an agent trades with on Perpl (and the Agora bounty asks
 * for it on screen); USDC and MON follow as rows, MON last because gas is
 * sponsored and a user should not have to think about it.
 *
 * The address shown is the user's PRIVY WALLET (SEN-40), not the passkey EOA
 * and not the old Kernel account: it is the address to fund, and showing any
 * other one here is how money ends up somewhere the app cannot spend it. The
 * signing key keeps a line of its own, labelled as what it is.
 *
 * Sending is SEN-42. The old 0.001 MON self-transfer driver is gone with it:
 * it proved the EOA could sign, which the sign-in ceremony now proves anyway.
 */
import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { RP_ID } from '@/auth';
import { MONAD_NETWORK, monadChain } from '@/chain';
import { useSession } from '@/session';
import { formatBalance } from '@/ui/format';
import { Button, ButtonRow, Loading, Notice, Screen, Section } from '@/ui/kit';
import { color, text } from '@/ui/theme';
import { balanceOf, type TokenBalance, type UseUserWallet } from '@/wallet';

/** Default WebAuthn account name. The passkey is what identifies the user. */
const USER_NAME = 'sente';

export default function Home() {
  const router = useRouter();
  // The session lives in <SessionProvider> so the agent screens share it.
  const { auth, wallet } = useSession();
  const { status, address, hasCredential, error, createPasskey, signIn, signOut, forget } = auth;

  // Balances move while the user is elsewhere in the app — an agent trades, a
  // faucet lands. Re-read whenever this screen comes back into view.
  useFocusEffect(
    useCallback(() => {
      void wallet.refresh();
    }, [wallet.refresh]),
  );

  const busy = status === 'busy' || status === 'restoring';
  const signedIn = status === 'ready';

  return (
    <Screen
      refreshing={wallet.refreshing}
      onRefresh={signedIn ? () => void wallet.refresh() : undefined}
    >
      <View style={styles.header}>
        <Text style={text.display}>Sente</Text>
        <Text style={text.caption}>
          {monadChain.name} · {MONAD_NETWORK} · chain {monadChain.id}
        </Text>
      </View>

      {signedIn ? <Wallet wallet={wallet} /> : <SignedOut hasCredential={hasCredential} />}

      <Section label="Passkey">
        <Text style={text.body}>{statusLabel(status, hasCredential)}</Text>
        {address !== null ? (
          <>
            <Text style={text.mono} selectable>
              {address}
            </Text>
            <Text style={text.caption}>
              Your signing key, derived from the passkey. It authorises your wallet; it does not
              hold your funds.
            </Text>
          </>
        ) : null}
        <Text style={text.caption}>rpId {RP_ID}</Text>
      </Section>

      {error !== null ? (
        <Notice
          tone="error"
          title={error.code !== null ? `${error.title} · ${error.code}` : error.title}
          detail={error.detail}
        />
      ) : null}

      <View style={styles.actions}>
        {signedIn ? (
          <>
            <ButtonRow>
              <Button
                label="Agents"
                kind="primary"
                onPress={() => router.push('/agents')}
                style={styles.grow}
              />
              <Button
                label="Leaderboard"
                onPress={() => router.push('/leaderboard')}
                style={styles.grow}
              />
            </ButtonRow>
            <Button label="Sign out" onPress={signOut} />
          </>
        ) : (
          <>
            <Button
              label="Sign in"
              kind="primary"
              onPress={() => void signIn()}
              disabled={busy}
              busy={status === 'busy'}
            />
            <Button
              label="Create a passkey"
              onPress={() => void createPasskey(USER_NAME)}
              disabled={busy}
            />
          </>
        )}
        {/* The stateless test: forget the hint, sign in again, same wallet. */}
        {hasCredential && !signedIn ? (
          <Button
            label="Forget this passkey (stateless test)"
            kind="danger"
            onPress={() => void forget()}
            disabled={busy}
          />
        ) : null}
      </View>

      <Text style={[text.caption, styles.footnote]}>
        A passkey saved to Chrome&apos;s local store has no PRF extension and cannot derive a
        wallet. When the system sheet asks where to save, choose Google Password Manager.
      </Text>
    </Screen>
  );
}

/** The wallet card: what the user holds, and where to send more of it. */
function Wallet({ wallet }: { wallet: UseUserWallet }) {
  if (wallet.status === 'registering') {
    return (
      <Section label="Your wallet">
        <Loading />
        <Text style={text.caption}>Claiming the wallet your device key owns…</Text>
      </Section>
    );
  }

  if (wallet.status === 'error' || wallet.wallet === null) {
    return (
      <Section label="Your wallet">
        <Notice
          tone="error"
          title="Could not reach your wallet"
          detail={wallet.error?.message ?? 'The API did not answer. Pull to try again.'}
        />
      </Section>
    );
  }

  const ausd = balanceOf(wallet.wallet, 'AUSD');
  const usdc = balanceOf(wallet.wallet, 'USDC');
  const mon = balanceOf(wallet.wallet, 'MON');

  return (
    <Section label="Your wallet">
      <Text style={text.mono} selectable>
        {wallet.wallet.address}
      </Text>

      <View style={styles.hero}>
        <Text style={[text.display, text.num, styles.heroFigure]}>{formatBalance(ausd)}</Text>
        <Text style={[text.strong, styles.heroSymbol]}>AUSD</Text>
      </View>

      <View style={styles.minorRows}>
        <MinorBalance balance={usdc} symbol="USDC" />
        <MinorBalance balance={mon} symbol="MON" />
      </View>

      <Text style={text.caption}>
        Gas is sponsored — you never need MON to trade. Send AUSD or USDC to the address above to
        fund an agent.
      </Text>
    </Section>
  );
}

/** A secondary balance. Dimmer than the hero, same tabular alignment. */
function MinorBalance({ balance, symbol }: { balance: TokenBalance | null; symbol: string }) {
  return (
    <View style={styles.minorRow}>
      <Text style={[text.dim, text.num, styles.minorFigure]}>{formatBalance(balance)}</Text>
      <Text style={text.dim}>{symbol}</Text>
    </View>
  );
}

function SignedOut({ hasCredential }: { hasCredential: boolean }) {
  return (
    <Section label="Your wallet">
      <Text style={text.body}>
        {hasCredential
          ? 'Sign in to see your wallet and its balances.'
          : 'Create a passkey and Sente derives your wallet from it — no seed phrase, nothing to write down.'}
      </Text>
      <Text style={text.caption}>
        The wallet is owned by a key that only exists on this phone, so signing in on a wiped app
        reaches the same address.
      </Text>
    </Section>
  );
}

function statusLabel(status: string, hasCredential: boolean): string {
  switch (status) {
    case 'restoring':
      return 'reading the stored credential…';
    case 'busy':
      return 'waiting for the passkey sheet…';
    case 'ready':
      return 'signed in';
    default:
      return hasCredential
        ? 'signed out (passkey known on this device)'
        : 'signed out (no passkey here yet)';
  }
}

const styles = StyleSheet.create({
  header: { paddingTop: 12, gap: 2 },
  hero: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 14 },
  heroFigure: { fontSize: 40, lineHeight: 46 },
  heroSymbol: { color: color.textDim },
  minorRows: { marginTop: 10, gap: 2 },
  minorRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  minorFigure: { minWidth: 96 },
  actions: { marginTop: 28, gap: 10 },
  grow: { flex: 1 },
  footnote: { marginTop: 28 },
});
