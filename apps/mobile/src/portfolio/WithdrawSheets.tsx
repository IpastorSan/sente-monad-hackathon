/**
 * The Portfolio cash card's two money-out sheets (SEN-153). The rules live in
 * `withdraw.ts`; this file is the screens and the two flows they start.
 *
 * - `WithdrawSheet`: your wallet → an address you type, as a sponsored send.
 *   Form → review → (a second confirmation when the recipient warrants one) →
 *   passkey → an honest result. `sendSponsored` rebuilds the Privy payload
 *   from exactly the token, recipient and amount reviewed here and refuses to
 *   sign anything else.
 * - `KuruWithdrawSheet`: your Kuru account → your wallet, a `kuru.withdraw`
 *   through `runTrade`. Only opened while manual trading is on, since it uses
 *   the `/trade` routes; AccountCore pays the caller, so there is no recipient.
 */
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Address } from 'viem';

import type { Agent, BalanceDto } from '@/agents/api';
import type { Token } from '@/agents/mandate';
import { publicClient } from '@/chain';
import { useSession } from '@/session';
import { describeTradeError, runTrade, type TradeFlowState } from '@/trade/flow';
import { Button, Chip, Chips, Field, Notice, Row, Sheet } from '@/ui/kit';
import { color, RADIUS, text } from '@/ui/theme';
import { balanceOf } from '@/wallet/api';
import { describeSendError, sendSponsored } from '@/wallet/send';

import {
  amountLabel,
  checkAmount,
  checkRecipient,
  classifyCode,
  KURU_WITHDRAW_TOKENS,
  kuruAvailable,
  kuruResult,
  kuruReview,
  maxInput,
  parseKnownRecipients,
  recipientWarnings,
  rememberRecipient,
  sendResult,
  sendReview,
  warningCopy,
  WITHDRAW_TOKENS,
  type CodeKind,
  type RecipientWarning,
  type WithdrawResult,
} from './withdraw';

type NoticeState = { tone: 'info' | 'ok' | 'error'; title: string; detail?: string };

// ─── Known recipients ───────────────────────────────────────────────────────

/**
 * "Sent here before", kept on this phone only. expo-secure-store because it
 * is the one persistence module the app already has (see `hideBalances.ts`);
 * the list is addresses, not secrets. A failed read is an empty list, which
 * errs toward MORE warnings, never fewer.
 */
const KNOWN_KEY = 'sente.withdraw.recipients.v1';

async function readKnown(): Promise<string[]> {
  try {
    return parseKnownRecipients(await SecureStore.getItemAsync(KNOWN_KEY));
  } catch {
    return [];
  }
}

async function addKnown(address: Address): Promise<void> {
  try {
    const next = rememberRecipient(await readKnown(), address);
    await SecureStore.setItemAsync(KNOWN_KEY, JSON.stringify(next));
  } catch {
    // Forgetting only means the next send here warns "new" again.
  }
}

async function readCode(address: Address): Promise<CodeKind | null> {
  try {
    return classifyCode(await publicClient.getCode({ address }));
  } catch {
    return null;
  }
}

// ─── Wallet → address ───────────────────────────────────────────────────────

type Review = {
  token: Token;
  atoms: bigint;
  to: Address;
  /** `null` while the contract and history checks are still running. */
  warnings: RecipientWarning[] | null;
};

export function WithdrawSheet({
  visible,
  agents,
  onClose,
  onSettled,
}: {
  visible: boolean;
  /** Your hired agents, for the "this funds the agent" warning; `null` while loading. */
  agents: readonly Agent[] | null;
  onClose: () => void;
  /** A send reached the server: re-read the balances. */
  onSettled: () => void;
}) {
  const { wallet, walletApi, auth } = useSession();
  const [token, setToken] = useState<Token>(WITHDRAW_TOKENS[0] as Token);
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [result, setResult] = useState<WithdrawResult | null>(null);

  // Every opening starts at the form; a result belongs to the send it reported.
  useEffect(() => {
    if (!visible) return;
    setReview(null);
    setAcknowledged(false);
    setNotice(null);
    setResult(null);
  }, [visible]);

  const self = wallet.address;
  const walletId = wallet.wallet?.walletId;
  const ready = wallet.status === 'ready' && walletId !== undefined && self !== null;
  // `raw` atoms from `/wallet`, never the display decimal: Max must be exact.
  // A token missing from the answer is unknown, not zero (`wallet/api.ts#balanceOf`).
  const available = balanceOf(wallet.wallet, token.symbol)?.raw ?? null;
  const amountCheck = checkAmount(amount, token, available);
  const recipientCheck = checkRecipient(recipient, self);
  const canReview = ready && amountCheck.kind === 'ok' && recipientCheck.kind === 'ok';

  const startReview = () => {
    if (amountCheck.kind !== 'ok' || recipientCheck.kind !== 'ok') return;
    const to = recipientCheck.address;
    const atoms = amountCheck.atoms;
    setNotice(null);
    setAcknowledged(false);
    setReview({ token, atoms, to, warnings: null });
    // Both checks run on the review, so the warnings are about the address
    // being confirmed, not one typed a moment ago.
    void Promise.all([readCode(to), readKnown()]).then(([code, known]) => {
      const warnings = recipientWarnings({
        address: to,
        agents: agents?.map((a) => ({ name: a.name, address: a.address })) ?? null,
        known,
        code,
      });
      setReview((current) => (current?.to === to ? { ...current, warnings } : current));
    });
  };

  const send = async () => {
    if (review === null || walletId === undefined) return;
    setNotice(null);
    setBusy(true);
    try {
      const sent = await sendSponsored(
        walletApi,
        { walletId, token: review.token, to: review.to, atoms: review.atoms },
        auth.signPrivyAuthorization,
      );
      onSettled();
      const outcome = sendResult(
        sent.confirmation?.status ?? sent.status,
        review.atoms,
        review.token,
        review.to,
      );
      if (outcome.final) {
        // Remembered once it was sent, landed or not: the user chose it twice.
        void addKnown(review.to);
        setAmount('');
        setRecipient('');
        setResult(outcome);
      } else {
        setNotice(outcome);
      }
    } catch (caught) {
      setNotice({ tone: 'error', ...describeSendError(caught) });
    } finally {
      setBusy(false);
    }
  };

  const warnings = review?.warnings ?? null;
  const needsAck = warnings !== null && warnings.length > 0;

  return (
    <Sheet visible={visible} title="Withdraw" onClose={onClose}>
      {result ? (
        <>
          <Notice tone={result.tone} title={result.title} detail={result.detail} />
          <Button label="Done" kind="primary" onPress={onClose} style={styles.action} />
        </>
      ) : review ? (
        <>
          <Text style={[text.title, styles.headline]}>
            {sendReview(review.atoms, review.token, review.to)}
          </Text>
          <View style={styles.addressWell}>
            <Text style={text.label}>To</Text>
            <Text style={[text.mono, styles.address]} selectable>
              {review.to}
            </Text>
          </View>
          <Row label="Amount" value={amountLabel(review.atoms, review.token)} />
          <Row label="Network" value="Monad testnet" />
          <Row label="Gas" value="Paid by Sente" />
          {warnings === null ? (
            <Text style={[text.caption, styles.gap]}>Checking the address…</Text>
          ) : (
            warnings.map((w) => (
              <View key={w.kind} style={styles.gap}>
                <Notice tone="error" {...warningCopy(w)} />
              </View>
            ))
          )}
          <Text style={[text.caption, styles.gap]}>
            Your passkey signs this exact transfer; this phone checks it before signing. Transfers
            on chain can’t be reversed.
          </Text>
          {notice ? (
            <View style={styles.gap}>
              <Notice tone={notice.tone} title={notice.title} detail={notice.detail} />
            </View>
          ) : null}
          {needsAck && !acknowledged ? (
            <Button
              label="I checked the address"
              kind="danger"
              onPress={() => setAcknowledged(true)}
              style={styles.action}
            />
          ) : (
            <Button
              label={`Send ${amountLabel(review.atoms, review.token)} with passkey`}
              kind="primary"
              busy={busy}
              disabled={warnings === null}
              onPress={() => void send()}
              style={styles.action}
            />
          )}
          <Button
            label="Edit"
            disabled={busy}
            onPress={() => setReview(null)}
            style={styles.secondary}
          />
        </>
      ) : (
        <>
          <Text style={[text.dim, styles.lead]}>
            Send cash from your wallet to another address on Monad testnet. Gas is sponsored.
          </Text>
          <Chips>
            {WITHDRAW_TOKENS.map((option) => (
              <Chip
                key={option.symbol}
                label={option.symbol}
                selected={option.symbol === token.symbol}
                onPress={() => setToken(option)}
              />
            ))}
          </Chips>
          <Field
            label="Amount"
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            suffix={token.symbol}
            placeholder="0"
            error={
              amountCheck.kind === 'invalid' ||
              amountCheck.kind === 'zero' ||
              amountCheck.kind === 'too_much'
                ? amountCheck.message
                : undefined
            }
            hint={
              available === null
                ? undefined
                : `Available: ${amountLabel(available, token)} in your wallet`
            }
          />
          <Button
            label="Max"
            kind="soft"
            size="sm"
            disabled={available === null || available === 0n}
            onPress={() => setAmount(maxInput(available, token))}
            style={styles.max}
          />
          <Field
            label="To address"
            value={recipient}
            onChangeText={setRecipient}
            placeholder="0x…"
            autoCapitalize="none"
            error={recipientCheck.kind === 'invalid' ? recipientCheck.message : undefined}
          />
          <Text style={text.caption}>
            MON can’t be withdrawn here: Monad keeps a 10 MON reserve in every wallet.
          </Text>
          {!ready ? (
            <View style={styles.gap}>
              <Notice
                tone="error"
                title="Your wallet isn’t ready"
                detail={
                  wallet.error?.message ?? 'Sign in on the home screen and wait for it to register.'
                }
              />
            </View>
          ) : null}
          <Button
            label="Review"
            kind="primary"
            disabled={!canReview}
            onPress={startReview}
            style={styles.action}
          />
        </>
      )}
    </Sheet>
  );
}

// ─── Kuru account → wallet ──────────────────────────────────────────────────

/** USDC, the only cash that sits in a Kuru account (`KURU_WITHDRAW_TOKENS`). */
const KURU_TOKEN = KURU_WITHDRAW_TOKENS[0] as Token;

export function KuruWithdrawSheet({
  visible,
  balances,
  onClose,
  onSettled,
}: {
  visible: boolean;
  /** `/portfolio`'s Kuru balances; `null` when the section did not answer. */
  balances: readonly BalanceDto[] | null;
  onClose: () => void;
  onSettled: () => void;
}) {
  const { trade, wallet, auth } = useSession();
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<TradeFlowState['phase'] | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [result, setResult] = useState<WithdrawResult | null>(null);

  useEffect(() => {
    if (!visible) return;
    setNotice(null);
    setResult(null);
  }, [visible]);

  const token = KURU_TOKEN;
  const available = kuruAvailable(balances, token);
  const check = checkAmount(amount, token, available);
  const walletId = wallet.wallet?.walletId;
  const address = wallet.address;
  const ready = trade !== null && walletId !== undefined && address !== null;
  const busy = phase !== null;

  const confirm = async () => {
    if (check.kind !== 'ok' || !ready) return;
    const atoms = check.atoms;
    setNotice(null);
    setPhase('preparing');
    try {
      const outcome = await runTrade(
        trade,
        { kind: 'kuru.withdraw', token: token.address, amountAtoms: atoms.toString() },
        { walletId, wallet: address },
        auth.signPrivyAuthorization,
        (state) => setPhase(state.phase),
      );
      onSettled();
      const shown = kuruResult(outcome.status, atoms, token);
      if (shown.final) {
        setAmount('');
        setResult(shown);
      } else {
        setNotice(shown);
      }
    } catch (caught) {
      setNotice({ tone: 'error', ...describeTradeError(caught) });
    } finally {
      setPhase(null);
    }
  };

  return (
    <Sheet visible={visible} title="Move to your wallet" onClose={onClose}>
      {result ? (
        <>
          <Notice tone={result.tone} title={result.title} detail={result.detail} />
          <Button label="Done" kind="primary" onPress={onClose} style={styles.action} />
        </>
      ) : (
        <>
          <Text style={[text.dim, styles.lead]}>
            Kuru pays a withdrawal only to the wallet that owns the account — yours. Only free cash
            can move; what your open orders reserve stays until they fill or you cancel them.
          </Text>
          <Field
            label="Amount"
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            suffix={token.symbol}
            placeholder="0"
            error={
              check.kind === 'invalid' || check.kind === 'zero' || check.kind === 'too_much'
                ? check.message
                : undefined
            }
            hint={
              available === null
                ? 'Kuru didn’t answer — pull to retry.'
                : `Free in your Kuru account: ${amountLabel(available, token)}`
            }
          />
          <Button
            label="Max"
            kind="soft"
            size="sm"
            disabled={available === null || available === 0n}
            onPress={() => setAmount(maxInput(available, token))}
            style={styles.max}
          />
          {check.kind === 'ok' ? (
            <Text style={[text.strong, styles.gap]}>{kuruReview(check.atoms, token)}</Text>
          ) : null}
          <Text style={[text.caption, styles.gap]}>
            Your passkey signs one Kuru withdrawal; this phone checks its token and amount first.
          </Text>
          {notice ? (
            <View style={styles.gap}>
              <Notice tone={notice.tone} title={notice.title} detail={notice.detail} />
            </View>
          ) : null}
          <Button
            label={busy ? phaseLabel(phase) : 'Withdraw with passkey'}
            kind="primary"
            busy={busy}
            disabled={!ready || check.kind !== 'ok'}
            onPress={() => void confirm()}
            style={styles.action}
          />
        </>
      )}
    </Sheet>
  );
}

function phaseLabel(phase: TradeFlowState['phase'] | null): string {
  switch (phase) {
    case 'verifying':
    case 'signing':
      return 'Checking and signing';
    case 'committing':
    case 'following':
    case 'settled':
      return 'Withdrawing';
    default:
      return 'Preparing';
  }
}

const styles = StyleSheet.create({
  lead: { marginBottom: 12 },
  headline: { marginBottom: 12 },
  addressWell: {
    marginBottom: 12,
    padding: 14,
    gap: 6,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
  address: { fontSize: 14, lineHeight: 22, color: color.text },
  gap: { marginTop: 10 },
  max: { alignSelf: 'flex-start', marginBottom: 12 },
  action: { marginTop: 16 },
  secondary: { marginTop: 8, borderWidth: 0 },
});
