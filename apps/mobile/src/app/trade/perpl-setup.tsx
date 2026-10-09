/**
 * Set up perps (SEN-120, plan U-14; the study's `trade.html` → "First perp
 * ever"): open the wallet's Perpl account and add this device's trading key,
 * once. Reached from the perp ticket's "Set up perps", a perp position, and
 * Portfolio when Perpl says the wallet has no account.
 *
 * The steps are what the account still needs (`perplSetupNeeds`): a new
 * wallet approves and opens the account with at least 100 AUSD, turns order
 * forwarding on, then enrolls the trading key; an account the server already
 * sees open skips straight to what is left — never a second account. Each
 * on-chain step is a sponsored transaction verified on the phone before the
 * passkey session signs it (`runPerplOnboard`), and the key enrollment is
 * checked field by field (`runPerplEnrollment`). The step list is a line of
 * stones: empty while waiting, breathing while it lands, solid once it has.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useSession } from '@/session';
import { describeTradeError, runPerplEnrollment, runPerplOnboard } from '@/trade/flow';
import { perplApiKeys } from '@/trade/perplApiKeys';
import { setupCta, setupSteps, type SetupStep } from '@/trade/perpTicket';
import { pressKey, stepState, toUnits, type Key, type StepState } from '@/trade/ticket';
import { Keypad, StepStone, TxLink, useLitKey, useWebKeys } from '@/trade/ticketKit';
import type { TradeView } from '@/trade/types';
import { usePerplSetup } from '@/trade/usePerplSetup';
import { useTradingCapabilities } from '@/trade/useTradingEnabled';
import { ComingNext } from '@/ui/ComingNext';
import {
  Button,
  Chip,
  Chips,
  IconButton,
  Loading,
  Notice,
  Screen,
  TopBar,
  useWide,
} from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';
import { balanceOf } from '@/wallet';

const MIN_AUSD = 100;
const AMOUNT_CHOICES = ['100', '250', '500'] as const;
const AUSD = 1_000_000n;

type Run =
  | { kind: 'idle' }
  | {
      kind: 'running';
      /** Each on-chain step's status as the trade view last reported it. */
      view: TradeView | null;
      /** Which step the phone is on before the first view arrives. */
      current: SetupStep['key'];
      enroll: StepState;
    }
  | { kind: 'done' }
  | {
      kind: 'failed';
      title: string;
      detail: string;
      view: TradeView | null;
      enroll: StepState;
    };

export default function PerplSetupScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ symbol?: string }>();
  const symbol = typeof params.symbol === 'string' && params.symbol !== '' ? params.symbol : null;
  const { perps } = useTradingCapabilities();
  const setup = usePerplSetup(perps);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/portfolio'));

  return (
    <Screen>
      <TopBar right={<IconButton icon="close" label="Close" onPress={close} />} />
      <Text style={text.label}>Perpl · once per wallet</Text>
      <Text style={[text.display, styles.title]}>Set up perps</Text>
      {!perps ? (
        <ComingNext
          icon="trade"
          title="Perps from your wallet are coming"
          detail="This server doesn’t trade perps for your wallet yet. Until then, an agent can trade Perpl for you, inside limits you set."
          points={['Open a Perpl account from your wallet', 'Long or short with leverage']}
        />
      ) : setup.kind === 'loading' || setup.kind === 'off' ? (
        <Loading />
      ) : setup.kind === 'error' ? (
        <Notice
          tone="error"
          title="Couldn’t read your Perpl account"
          detail={`${setup.message}. Try again in a moment.`}
        />
      ) : setup.kind === 'ready' ? (
        <Ready symbol={symbol} accountId={setup.account.accountId} onClose={close} />
      ) : (
        <Setup
          needs={setup.needs}
          accountId={setup.account.accountId}
          symbol={symbol}
          onSettled={setup.refresh}
          onClose={close}
        />
      )}
    </Screen>
  );
}

function Ready({
  symbol,
  accountId,
  onClose,
}: {
  symbol: string | null;
  accountId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  return (
    <View style={styles.block}>
      <Notice
        tone="ok"
        title="Perps are ready"
        detail={`Perpl account ${accountId ?? ''} is open and this device can trade it.`}
      />
      <Button
        kind="primary"
        label={symbol ? `Trade ${symbol}` : 'Done'}
        onPress={() =>
          symbol
            ? router.replace({
                pathname: '/trade/[venue]/[symbol]',
                params: { venue: 'perpl', symbol },
              })
            : onClose()
        }
        style={styles.cta}
      />
    </View>
  );
}

function Setup({
  needs,
  accountId,
  symbol,
  onSettled,
  onClose,
}: {
  needs: { open: boolean; forwarding: boolean; enroll: boolean };
  accountId: string | null;
  symbol: string | null;
  onSettled: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const wide = useWide();
  const { trade, wallet, auth } = useSession();
  const [amount, setAmount] = useState(String(MIN_AUSD));
  const [run, setRun] = useState<Run>({ kind: 'idle' });
  // The plan is fixed when the run starts: a refresh mid-run must not reshape the list.
  const [frozen, setFrozen] = useState<typeof needs | null>(null);
  const plan = frozen ?? needs;
  const steps = useMemo(() => setupSteps(plan, amount), [plan, amount]);

  const held = balanceOf(wallet.wallet, 'AUSD');
  const amountAtoms = toUnits(amount, AUSD);
  const tooSmall = amountAtoms === null || amountAtoms < BigInt(MIN_AUSD) * AUSD;
  const tooBig = plan.open && held !== null && amountAtoms !== null && amountAtoms > held.raw;
  const blocked = plan.open && (tooSmall || tooBig);
  const busy = run.kind === 'running';

  const { lit, typeKey } = useLitKey((key) => setAmount((v) => pressKey(v, key, 2)));

  const start = async () => {
    const walletId = wallet.wallet?.walletId;
    const address = wallet.wallet?.address;
    if (trade === null || walletId === undefined || address === undefined || amountAtoms === null) {
      setRun({
        kind: 'failed',
        title: 'Your wallet isn’t ready',
        detail: 'Try again in a moment.',
        view: null,
        enroll: 'wait',
      });
      return;
    }
    const first = steps[0]?.key ?? 'enroll';
    setFrozen(plan);
    setRun({ kind: 'running', view: null, current: first, enroll: 'wait' });
    let view: TradeView | null = null;
    let enrolling = false;
    try {
      if (plan.open || plan.forwarding) {
        const outcome = await runPerplOnboard(
          trade,
          { amountAtoms: amountAtoms.toString() },
          { walletId, wallet: address, accountOpen: !plan.open },
          auth.signPrivyAuthorization,
          (state) => {
            if (state.phase === 'following') view = state.view;
            setRun((r) => (r.kind === 'running' ? { ...r, view } : r));
          },
        );
        if (outcome.status === 'pending') {
          setRun({
            kind: 'failed',
            title: 'Still landing',
            detail:
              'The account steps were signed and sent and may still land. Come back in a minute: setup picks up where it stopped.',
            view,
            enroll: 'wait',
          });
          return;
        }
        if (outcome.status === 'failed' || outcome.status === 'expired') {
          const failed = outcome.view.steps.find((s) => stepState(s.status) === 'failed');
          setRun({
            kind: 'failed',
            title: 'A step didn’t go through',
            detail: failed
              ? `“${failed.title}” ${failed.status}${failed.error ? `: ${failed.error}` : ''}. Try again: setup picks up where it stopped.`
              : 'Try again: setup picks up where it stopped.',
            view: outcome.view,
            enroll: 'wait',
          });
          return;
        }
      }
      if (plan.enroll) {
        enrolling = true;
        setRun((r) => (r.kind === 'running' ? { ...r, current: 'enroll', enroll: 'now' } : r));
        await runPerplEnrollment(
          trade,
          { walletId, wallet: address },
          { sign: auth.signPrivyAuthorization, tradeKey: auth.perplTradeKey },
          perplApiKeys,
        );
      }
      setRun({ kind: 'done' });
    } catch (error) {
      setRun({
        kind: 'failed',
        ...describeTradeError(error),
        view,
        enroll: enrolling ? 'failed' : 'wait',
      });
    } finally {
      setFrozen(null);
      onSettled();
    }
  };

  useWebKeys(run.kind === 'idle', (event) => {
    if (event.type !== 'keydown') return false;
    if (plan.open && /^[0-9]$/.test(event.key)) typeKey(event.key as Key);
    else if (plan.open && (event.key === '.' || event.key === ',')) typeKey('.');
    else if (plan.open && event.key === 'Backspace') typeKey('back');
    else if (event.key === 'Enter') {
      if (!blocked && !event.repeat) void start();
    } else return false;
    return true;
  });

  if (run.kind === 'done') {
    return (
      <View style={styles.block}>
        <StepList steps={steps} states={() => 'done'} hashes={{}} />
        <Notice
          tone="ok"
          title="Perps are ready"
          detail="Your Perpl account is open and this device holds its trading key."
        />
        <Button
          kind="primary"
          label={symbol ? `Trade ${symbol}` : 'Done'}
          onPress={() =>
            symbol
              ? router.replace({
                  pathname: '/trade/[venue]/[symbol]',
                  params: { venue: 'perpl', symbol },
                })
              : onClose()
          }
          style={styles.cta}
        />
      </View>
    );
  }

  const viewOf = run.kind === 'running' || run.kind === 'failed' ? run.view : null;
  const stateOf = (step: SetupStep): StepState => {
    if (run.kind === 'idle') return 'wait';
    if (step.key === 'enroll') return run.enroll;
    const seen = viewOf?.steps.find((s) => s.kind === step.key);
    if (seen) return stepState(seen.status);
    if (run.kind === 'running' && run.current === step.key) return 'now';
    return 'wait';
  };
  const hashes = Object.fromEntries(
    (viewOf?.steps ?? []).flatMap((s) => (s.transactionHash ? [[s.kind, s.transactionHash]] : [])),
  ) as Record<string, string>;

  return (
    <View style={styles.block}>
      <Text style={[text.body, styles.lead]}>
        {plan.open
          ? 'Perpl keeps your margin in an account your wallet owns. You open it with AUSD, then this device gets a key that can trade it — never withdraw from it.'
          : `Perpl account ${accountId ?? ''} is open. ${plan.forwarding ? 'Two things are left.' : 'One thing is left.'}`}
      </Text>

      {plan.open ? (
        <View style={styles.amountBlock}>
          <Text style={text.label}>Opening deposit</Text>
          <Text
            style={[styles.amountText, blocked && amount !== '' && text.danger]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {amount === '' ? <Text style={styles.placeholder}>0</Text> : amount}
            <Text style={styles.amountUnit}> AUSD</Text>
          </Text>
          <Text style={[text.dim, text.num]}>
            {held === null ? 'Reading your wallet…' : `${held.amount} AUSD in your wallet`}
            {tooSmall ? ' · Perpl opens accounts from 100 AUSD' : ''}
            {tooBig ? ' · more than you have' : ''}
          </Text>
          <Chips>
            {AMOUNT_CHOICES.map((choice) => (
              <Chip
                key={choice}
                label={`${choice} AUSD`}
                selected={amount === choice}
                onPress={() => !busy && setAmount(choice)}
              />
            ))}
          </Chips>
          {busy ? null : <Keypad onKey={typeKey} lit={lit} compact={wide} />}
        </View>
      ) : null}

      <StepList steps={steps} states={stateOf} hashes={hashes} />

      {run.kind === 'failed' ? (
        <View style={styles.notice}>
          <Notice tone="error" title={run.title} detail={run.detail} />
        </View>
      ) : null}

      <Text style={[text.caption, styles.timing]}>
        {plan.open || plan.forwarding
          ? 'About 20–40 s, a few confirmations. Each step is checked on this device, then signed by your passkey session — no extra prompts. Gas is sponsored.'
          : 'A few seconds. One signature from your passkey session, checked on this device first.'}
      </Text>
      <Button
        kind="primary"
        label={busy ? 'Setting up…' : run.kind === 'failed' ? 'Try again' : setupCta(plan, amount)}
        busy={busy}
        disabled={blocked}
        onPress={() => void start()}
        style={styles.cta}
      />
      {wide && run.kind === 'idle' ? (
        <Text style={[text.caption, styles.center]}>
          {plan.open ? 'Type an amount · Enter to start' : 'Enter to start'}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The steps as a line of stones joined by one board line — a connected group,
 * which is what the setup builds. Each stone says how its step stands.
 */
function StepList({
  steps,
  states,
  hashes,
}: {
  steps: readonly SetupStep[];
  states: (step: SetupStep) => StepState;
  hashes: Record<string, string>;
}) {
  return (
    <View style={styles.steps}>
      <View style={styles.boardLine} />
      {steps.map((step) => {
        const state = states(step);
        const hash = hashes[step.key];
        return (
          <View key={step.key} style={styles.step}>
            <View style={styles.stoneSlot}>
              <StepStone state={state} />
            </View>
            <View style={styles.grow}>
              <Text style={[text.strong, state === 'failed' && text.danger]}>{step.title}</Text>
              <Text style={text.caption}>{step.detail}</Text>
              {hash ? <TxLink hash={hash} /> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 4 },
  grow: { flex: 1 },
  center: { textAlign: 'center', marginTop: 8 },
  block: { marginTop: 14, gap: 4 },
  lead: { color: color.textDim, marginBottom: 6 },
  amountBlock: {
    marginTop: 10,
    padding: 16,
    gap: 8,
    borderRadius: RADIUS.board,
    backgroundColor: color.board,
  },
  amountText: {
    fontFamily: font.displaySemibold,
    fontSize: 44,
    lineHeight: 50,
    letterSpacing: -1.4,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  amountUnit: { fontSize: 20, color: color.textDim, letterSpacing: 0 },
  placeholder: { color: color.textFaint },
  steps: { marginTop: 22, gap: 20, position: 'relative' },
  boardLine: {
    position: 'absolute',
    left: 8,
    top: 10,
    bottom: 10,
    width: 1,
    backgroundColor: color.lineStrong,
  },
  step: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  stoneSlot: { width: 18, alignItems: 'center', backgroundColor: color.ink },
  notice: { marginTop: 18 },
  timing: { marginTop: 22 },
  cta: { marginTop: 12 },
});
