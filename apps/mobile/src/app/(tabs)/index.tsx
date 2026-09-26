/**
 * Home: the wallet the passkey owns. Signing in is `/welcome` and the signing
 * key is on Account (SEN-55), so this screen answers one question — what do I
 * hold, and what are my agents doing with it. The AUSD figure leads
 * because it is what an agent trades with on Perpl (and the Agora bounty asks
 * for it on screen); USDC and MON follow as rows, MON last because gas is
 * sponsored and a user should not have to think about it.
 *
 * The address shown is the user's PRIVY WALLET (SEN-40), not the passkey EOA
 * and not the old Kernel account: it is the address to fund, and showing any
 * other one here is how money ends up somewhere the app cannot spend it.
 *
 * Sending is SEN-42. The old 0.001 MON self-transfer driver is gone with it:
 * it proved the EOA could sign, which the sign-in ceremony now proves anyway.
 */
import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { useSession } from '@/session';
import { formatBalance } from '@/ui/format';
import { Mark } from '@/ui/goban';
import { Loading, Notice, Screen, Section } from '@/ui/kit';
import { color, text } from '@/ui/theme';
import { balanceOf, type TokenBalance, type UseUserWallet } from '@/wallet';

export default function Home() {
  // The session lives in <SessionProvider> so the agent screens share it. The
  // tabs layout only renders this once it is signed in.
  const { wallet } = useSession();

  // Balances move while the user is elsewhere in the app — an agent trades, a
  // faucet lands. Re-read whenever this screen comes back into view.
  useFocusEffect(
    useCallback(() => {
      void wallet.refresh();
    }, [wallet.refresh]),
  );

  return (
    <Screen tabbed refreshing={wallet.refreshing} onRefresh={() => void wallet.refresh()}>
      <View style={styles.header}>
        <Text style={text.label}>gmonad</Text>
        <Mark />
      </View>
      <Wallet wallet={wallet} />
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

const styles = StyleSheet.create({
  header: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  hero: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 14 },
  heroFigure: { fontSize: 40, lineHeight: 46 },
  heroSymbol: { color: color.textDim },
  minorRows: { marginTop: 10, gap: 2 },
  minorRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  minorFigure: { minWidth: 96 },
});
