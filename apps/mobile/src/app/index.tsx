/**
 * MOV-251 driver screen.
 *
 * This exists to be operated by a human on a physical Android phone (MOV-259):
 * create a passkey, sign in, see the derived address and its MON balance, and
 * send a self-transfer to prove the account can actually sign. Every state is
 * spelled out on screen — especially failures, because the interesting failure
 * (PRF_UNAVAILABLE) looks identical to "nothing happened" otherwise.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { createWalletClient, formatEther, http, parseEther } from 'viem';

import { describeAuthError, RP_ID } from '@/auth';
import { MONAD_GAS_LIMITS, MONAD_NETWORK, monadChain, publicClient } from '@/chain';
import { useSession } from '@/session';

/** Deliberately small: this is a liveness proof, not a transfer anyone wants. */
const SELF_TRANSFER = parseEther('0.001');

/** Default WebAuthn account name. The passkey is what identifies the user. */
const USER_NAME = 'sente';

type TxState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; hash: `0x${string}` }
  | { kind: 'failed'; title: string; detail: string };

export default function Home() {
  const router = useRouter();
  // The session lives in <SessionProvider> so the agent screens share it.
  const { status, account, address, hasCredential, error, createPasskey, signIn, signOut, forget } =
    useSession().auth;

  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [tx, setTx] = useState<TxState>({ kind: 'idle' });

  const refreshBalance = useCallback(async () => {
    if (address === null) {
      setBalance(null);
      return;
    }
    try {
      setBalanceError(null);
      setBalance(await publicClient.getBalance({ address }));
    } catch (caught) {
      setBalanceError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [address]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const sendToSelf = useCallback(async () => {
    if (account === null) return;
    setTx({ kind: 'sending' });
    try {
      const wallet = createWalletClient({
        account,
        chain: monadChain,
        transport: http(process.env.EXPO_PUBLIC_MONAD_RPC_URL || undefined),
      });
      const hash = await wallet.sendTransaction({
        to: account.address,
        value: SELF_TRANSFER,
        // Monad charges on the gas LIMIT, so this is an explicit constant and
        // never an estimate. See MONAD_TX_DEFAULTS in src/chain/client.ts.
        gas: MONAD_GAS_LIMITS.nativeTransfer,
      });
      setTx({ kind: 'sent', hash });
      await publicClient.waitForTransactionReceipt({ hash });
      await refreshBalance();
    } catch (caught) {
      const described = describeAuthError(caught);
      setTx({ kind: 'failed', title: described.title, detail: described.detail });
    }
  }, [account, refreshBalance]);

  const busy = status === 'busy' || status === 'restoring';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Sente</Text>
      <Text style={styles.subtitle}>
        {monadChain.name} · {MONAD_NETWORK} · chain {monadChain.id}
      </Text>
      <Text style={styles.subtitle}>rpId {RP_ID}</Text>

      <Section label="Status">
        <Text style={styles.value}>{statusLabel(status, hasCredential)}</Text>
      </Section>

      {status === 'ready' && address !== null ? (
        <>
          <Section label="Address">
            <Text style={styles.mono} selectable>
              {address}
            </Text>
          </Section>

          <Section label="Balance">
            <Text style={styles.value}>
              {balanceError !== null
                ? `RPC error: ${balanceError}`
                : balance === null
                  ? 'loading…'
                  : `${formatEther(balance)} MON`}
            </Text>
          </Section>
        </>
      ) : null}

      {error !== null ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>
            {error.title}
            {error.code !== null ? ` · ${error.code}` : ''}
          </Text>
          <Text style={styles.errorDetail}>{error.detail}</Text>
        </View>
      ) : null}

      {tx.kind === 'sent' ? (
        <View style={styles.okBox}>
          <Text style={styles.okTitle}>Transaction sent</Text>
          <Text style={styles.mono} selectable>
            {tx.hash}
          </Text>
        </View>
      ) : null}

      {tx.kind === 'failed' ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>{tx.title}</Text>
          <Text style={styles.errorDetail}>{tx.detail}</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button
          label="Create passkey"
          onPress={() => void createPasskey(USER_NAME)}
          disabled={busy}
          busy={status === 'busy'}
        />
        <Button label="Sign in" onPress={() => void signIn()} disabled={busy} />
        <Button
          label="Agents"
          onPress={() => router.push('/agents')}
          disabled={status !== 'ready'}
          style={styles.primary}
        />
        <Button
          label={`Send ${formatEther(SELF_TRANSFER)} MON to self`}
          onPress={() => void sendToSelf()}
          disabled={status !== 'ready' || tx.kind === 'sending'}
          busy={tx.kind === 'sending'}
          style={styles.primary}
        />
        <Button label="Refresh balance" onPress={() => void refreshBalance()} disabled={busy} />
        <Button label="Sign out" onPress={signOut} disabled={status !== 'ready'} />
        <Button
          label="Forget credential (stateless test)"
          onPress={() => void forget()}
          disabled={busy}
        />
      </View>

      <Text style={styles.footnote}>
        A passkey saved to Chrome&apos;s local store has no PRF extension and cannot derive a
        wallet. When the system sheet asks where to save, choose Google Password Manager.
      </Text>
    </ScrollView>
  );
}

function statusLabel(status: string, hasCredential: boolean): string {
  switch (status) {
    case 'restoring':
      return 'reading stored credential…';
    case 'busy':
      return 'waiting for the passkey sheet…';
    case 'ready':
      return 'signed in';
    default:
      return hasCredential
        ? 'signed out (passkey known on this device)'
        : 'signed out (no passkey)';
  }
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled = false,
  busy = false,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        style,
        (disabled || busy) && styles.buttonDisabled,
        pressed && styles.buttonPressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <Text style={styles.buttonText}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0B0B0F' },
  content: { padding: 24, paddingTop: 72, gap: 4 },
  title: { color: '#FFFFFF', fontSize: 40, fontWeight: '700', letterSpacing: -1 },
  subtitle: { color: '#8A8AA3', fontSize: 13 },
  section: { marginTop: 20, gap: 4 },
  label: { color: '#5B5B77', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  value: { color: '#E6E6F0', fontSize: 15 },
  mono: { color: '#E6E6F0', fontSize: 13, fontFamily: 'monospace' },
  actions: { marginTop: 28, gap: 10 },
  button: {
    backgroundColor: '#1C1C26',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  // Neutral: purple is reserved for the consensus ramp (plan, "Instrument Grey").
  primary: { backgroundColor: '#2E2E33' },
  buttonDisabled: { opacity: 0.35 },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  errorBox: {
    marginTop: 20,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#2A1218',
    borderWidth: 1,
    borderColor: '#7A2338',
    gap: 6,
  },
  errorTitle: { color: '#FF8FA3', fontSize: 14, fontWeight: '700' },
  errorDetail: { color: '#D9A8B4', fontSize: 13, lineHeight: 19 },
  okBox: {
    marginTop: 20,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#0F2419',
    borderWidth: 1,
    borderColor: '#1F6B45',
    gap: 6,
  },
  okTitle: { color: '#6EE7A8', fontSize: 14, fontWeight: '700' },
  footnote: { color: '#5B5B77', fontSize: 12, lineHeight: 18, marginTop: 28 },
});
