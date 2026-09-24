/**
 * One agent: its wallet and balances, its mandate, and the four things you can
 * do to it — fund, run, amend, revoke. Fund, run and revoke confirm in an
 * in-app sheet (never `Alert`); amend reuses the hire form's mandate and
 * review steps.
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatAtoms, parseAmount } from '@/agents/amounts';
import {
  AgentsApiError,
  describeAgentsError,
  modelLabel,
  type Agent,
  type PreparedMandateChange,
} from '@/agents/api';
import { describeApprovalError, needsApproval, revokeWithApproval } from '@/agents/approval';
import { readBalance, readBalances } from '@/agents/balances';
import { FUNDING_TOKENS } from '@/agents/fund';
import { MandateSummary } from '@/agents/MandateSummary';
import type { Token } from '@/agents/mandate';
import { useSession } from '@/session';
import { describeSendError, sendSponsored } from '@/wallet/send';
import { isoDate, shortAddress } from '@/ui/format';
import {
  Button,
  ButtonRow,
  Chip,
  Chips,
  Field,
  Loading,
  Notice,
  Row,
  Screen,
  Section,
  Sheet,
  TopBar,
  type NoticeTone,
} from '@/ui/kit';
import { color, text } from '@/ui/theme';

type NoticeState = { tone: NoticeTone; title: string; detail?: string };
type SheetId = 'fund' | 'run' | 'revoke';

export default function AgentScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { agents: api } = useSession();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [loadError, setLoadError] = useState<NoticeState | null>(null);
  const [balances, setBalances] = useState<Record<string, bigint> | null>(null);
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);

  const refreshBalances = useCallback((address: Agent['address']) => {
    readBalances(address).then(setBalances, () => setBalances(null));
  }, []);

  const load = useCallback(async () => {
    if (!api || !id) return;
    try {
      const fresh = await api.get(id);
      setAgent(fresh);
      setLoadError(null);
      refreshBalances(fresh.address);
    } catch (error) {
      setLoadError({ tone: 'error', ...describeAgentsError(error) });
    }
  }, [api, id, refreshBalances]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const close = () => setSheet(null);
  const finish = (next: NoticeState) => {
    setSheet(null);
    setNotice(next);
    void load();
  };

  const backToList = () => (router.canGoBack() ? router.back() : router.replace('/agents'));

  if (!agent) {
    return (
      <Screen>
        <TopBar back={{ label: 'Agents', onPress: backToList }} />
        {!api ? (
          <Notice title="Sign in first" detail="Agents belong to your passkey account." />
        ) : loadError ? (
          <Notice tone="error" title={loadError.title} detail={loadError.detail} />
        ) : (
          <Loading />
        )}
      </Screen>
    );
  }

  const active = agent.status === 'active';

  return (
    <Screen>
      <TopBar back={{ label: 'Agents', onPress: backToList }} />
      <Text style={text.display}>{agent.name}</Text>
      <Text style={[text.dim, styles.meta]}>
        {active ? '● Active' : '○ Revoked'} · {modelLabel(agent.model)} · hired{' '}
        {isoDate(agent.createdAt)}
      </Text>

      {notice ? <Notice tone={notice.tone} title={notice.title} detail={notice.detail} /> : null}

      {/* The Ledger is where an agent stops being a name and becomes a record. */}
      <Button
        label="Agent Ledger — theses, trades, refusals"
        onPress={() => router.push({ pathname: '/agents/[id]/ledger', params: { id: agent.id } })}
        style={styles.ledgerLink}
      />

      {active ? (
        <View style={styles.actions}>
          <ButtonRow>
            <Button
              label="Fund"
              kind="primary"
              onPress={() => setSheet('fund')}
              style={styles.grow}
            />
            <Button label="Run now" onPress={() => setSheet('run')} style={styles.grow} />
          </ButtonRow>
          <ButtonRow>
            <Button
              label="Amend mandate"
              onPress={() => router.push({ pathname: '/agents/new', params: { amend: agent.id } })}
              style={styles.grow}
            />
            <Button
              label="Revoke"
              kind="danger"
              onPress={() => setSheet('revoke')}
              style={styles.grow}
            />
          </ButtonRow>
        </View>
      ) : (
        <>
          <Notice
            title={`Revoked${agent.revokedAt ? ` on ${isoDate(agent.revokedAt)}` : ''}`}
            detail={
              agent.policyCleared === false
                ? 'The agent won’t run again, but its wallet policy still holds the old rules. Revoke again to clear it.'
                : 'Its wallet policy is empty, so it can’t sign anything. Revoking is permanent.'
            }
          />
          {agent.policyCleared === false ? (
            <Button
              label="Revoke again"
              kind="danger"
              onPress={() => setSheet('revoke')}
              style={styles.actionsTop}
            />
          ) : null}
        </>
      )}

      <Section label="Wallet">
        <Text style={text.mono} selectable>
          {agent.address}
        </Text>
      </Section>

      <Section
        label="Balances"
        aside={
          <Text style={text.caption} onPress={() => refreshBalances(agent.address)}>
            Refresh
          </Text>
        }
      >
        {balances === null ? (
          <Text style={text.dim}>Reading the chain…</Text>
        ) : (
          FUNDING_TOKENS.map((token) => (
            <Row
              key={token.symbol}
              label={token.symbol}
              value={formatAtoms(balances[token.symbol] ?? 0n, token.decimals)}
            />
          ))
        )}
      </Section>

      <Section label="Mandate">
        <MandateSummary mandate={agent.mandate} />
      </Section>

      <Section
        label="Instructions"
        aside={
          <Text style={text.caption} onPress={() => setShowInstructions((shown) => !shown)}>
            {showInstructions ? 'Hide' : 'Show'}
          </Text>
        }
      >
        {showInstructions ? (
          <>
            <Text style={text.label}>System prompt</Text>
            <Text style={[text.body, styles.prose]} selectable>
              {agent.systemPrompt || '—'}
            </Text>
            <Text style={[text.label, styles.after]}>Strategy</Text>
            <Text style={[text.body, styles.prose]} selectable>
              {agent.strategy || '—'}
            </Text>
          </>
        ) : (
          <Text style={[text.dim, text.num]}>
            {agent.systemPrompt.length.toLocaleString('en-US')} +{' '}
            {agent.strategy.length.toLocaleString('en-US')} characters
          </Text>
        )}
      </Section>

      <Section label="Identifiers">
        <Row label="Agent" value={agent.id} mono />
        <Row label="Wallet" value={agent.walletId} mono />
        <Row label="Policy" value={agent.policyId} mono />
      </Section>

      <FundSheet agent={agent} visible={sheet === 'fund'} onClose={close} onSent={finish} />
      <RunSheet agent={agent} visible={sheet === 'run'} onClose={close} />
      <RevokeSheet agent={agent} visible={sheet === 'revoke'} onClose={close} onDone={finish} />
    </Screen>
  );
}

/**
 * Funding an agent from the user's own Privy wallet (SEN-42).
 *
 * Nothing about this is a server transfer: the API composes the Privy request,
 * this phone rebuilds it from what is on screen and refuses to sign anything
 * else (`wallet/send.ts`), and Privy pays the gas — so the user needs no MON.
 * It replaces the Kernel UserOperation batch this sheet used to send.
 */
function FundSheet({
  agent,
  visible,
  onClose,
  onSent,
}: {
  agent: Agent;
  visible: boolean;
  onClose: () => void;
  onSent: (notice: NoticeState) => void;
}) {
  const { wallet, walletApi, auth } = useSession();
  const [token, setToken] = useState<Token>(FUNDING_TOKENS[0] as Token);
  const [amount, setAmount] = useState('');
  const [available, setAvailable] = useState<bigint | null>(null);
  const [error, setError] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  const from = wallet.address;
  useEffect(() => {
    if (!visible || !from) return;
    let cancelled = false;
    setAvailable(null);
    // Read from the chain rather than from `wallet.wallet.balances`: the API
    // reports MON, USDC and AUSD, and this sheet offers every Kuru asset.
    readBalance(token, from).then(
      (balance) => {
        if (!cancelled) setAvailable(balance);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [visible, token, from]);

  const atoms = parseAmount(amount, token.decimals);
  const tooMuch = atoms !== null && available !== null && atoms > available;
  const invalid = amount.trim() !== '' && atoms === null;
  const walletId = wallet.wallet?.walletId;
  const ready = wallet.status === 'ready' && walletId !== undefined;

  const send = async () => {
    if (atoms === null || atoms === 0n || walletId === undefined) return;
    setError(null);
    setBusy(true);
    const label = `${formatAtoms(atoms, token.decimals)} ${token.symbol}`;
    try {
      const sent = await sendSponsored(
        walletApi,
        { walletId, token, to: agent.address, atoms },
        auth.signPrivyAuthorization,
      );
      const status = sent.confirmation?.status ?? sent.status;
      if (status === 'included') {
        setAmount('');
        onSent({ tone: 'ok', title: `Sent ${label} to ${agent.name}` });
      } else if (status === 'reverted') {
        // Gotcha 8: the operation reverted inside a transaction that may well
        // have succeeded. Nothing moved, and saying otherwise would be a lie.
        setError({
          tone: 'error',
          title: 'The transfer reverted',
          detail: 'It was included on chain but didn’t execute, so nothing moved.',
        });
      } else {
        setAmount('');
        onSent({
          tone: 'info',
          title: `Sending ${label}`,
          detail: `Submitted, not confirmed yet (${status}). The balance updates once it lands.`,
        });
      }
    } catch (caught) {
      setError({ tone: 'error', ...describeSendError(caught) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} title={`Fund ${agent.name}`} onClose={onClose}>
      <Chips>
        {FUNDING_TOKENS.map((option) => (
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
          invalid
            ? `Enter an amount with at most ${token.decimals} decimals.`
            : tooMuch
              ? 'More than your account holds.'
              : undefined
        }
        hint={
          from
            ? `Your account holds ${available === null ? '…' : formatAtoms(available, token.decimals)} ${token.symbol}`
            : undefined
        }
      />
      <Row label="From" value={from ? shortAddress(from) : '—'} mono />
      <Row label="To" value={shortAddress(agent.address)} mono />
      <Text style={[text.caption, styles.after]}>
        Your passkey signs this transfer and Sente pays the gas, so you need no MON. Sente holds no
        key that can move your funds — and it can’t move funds back out of an agent’s wallet yet, so
        send what you’re prepared to leave with it.
      </Text>
      {!ready ? (
        <Notice
          tone="error"
          title="Your wallet isn’t ready"
          detail={
            wallet.error?.message ?? 'Sign in on the home screen and wait for it to register.'
          }
        />
      ) : null}
      {error ? <Notice tone={error.tone} title={error.title} detail={error.detail} /> : null}
      <Button
        label={
          atoms && atoms > 0n
            ? `Approve & send ${formatAtoms(atoms, token.decimals)} ${token.symbol}`
            : 'Approve & send'
        }
        kind="primary"
        busy={busy}
        disabled={!ready || atoms === null || atoms === 0n || tooMuch}
        onPress={() => void send()}
        style={styles.sheetAction}
      />
    </Sheet>
  );
}

function RunSheet({
  agent,
  visible,
  onClose,
}: {
  agent: Agent;
  visible: boolean;
  onClose: () => void;
}) {
  const { agents: api } = useSession();
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<NoticeState | null>(null);

  const dismiss = () => {
    setOutcome(null);
    onClose();
  };

  const run = async () => {
    if (!api) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await api.run(agent.id, instruction.trim() || undefined);
      if (result.kind === 'unavailable') {
        setOutcome({
          tone: 'info',
          title: 'Not available yet',
          detail:
            'This server can’t run agents on demand yet. The button starts working once the agent runner ships.',
        });
      } else {
        const { iterations, stopReason, costUsd } = result.result;
        setOutcome({
          tone: 'ok',
          title: 'Run finished',
          detail: `${iterations} steps · stopped on ${stopReason}${costUsd !== undefined ? ` · $${costUsd.toFixed(4)}` : ''}`,
        });
      }
    } catch (error) {
      setOutcome({ tone: 'error', ...describeAgentsError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} title={`Run ${agent.name} now`} onClose={dismiss}>
      <Text style={text.dim}>
        One run: the agent reads the markets its mandate allows and decides whether to trade.
        Everything it tries is still checked against the mandate.
      </Text>
      <Field
        label="Instruction (optional)"
        value={instruction}
        onChangeText={setInstruction}
        multiline
        placeholder="e.g. Only rebalance, no new positions."
      />
      {outcome ? (
        <Notice tone={outcome.tone} title={outcome.title} detail={outcome.detail} />
      ) : null}
      <Button
        label="Run now"
        kind="primary"
        busy={busy}
        onPress={() => void run()}
        style={styles.sheetAction}
      />
    </Sheet>
  );
}

function RevokeSheet({
  agent,
  visible,
  onClose,
  onDone,
}: {
  agent: Agent;
  visible: boolean;
  onClose: () => void;
  onDone: (notice: NoticeState) => void;
}) {
  const { agents: api, auth } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NoticeState | null>(null);
  /**
   * A device-owned agent's policy can only be emptied by a PATCH this phone
   * signed (SEN-44): the API asks, the passkey approves. `revokeWithApproval`
   * checks that the PATCH really leaves no rules before signing anything.
   */
  const signs = needsApproval(agent);
  const [prepared, setPrepared] = useState<PreparedMandateChange | null>(null);

  // Asked for as the sheet opens, not when the button is pressed: the change is
  // then on screen to read (it leaves `rules: 0`), and the passkey prompt is
  // not sitting behind a round trip. Preparing again supersedes this one
  // server-side, so an abandoned sheet leaves nothing committable behind.
  useEffect(() => {
    if (!visible || !signs || !api) return;
    let cancelled = false;
    setPrepared(null);
    api.prepareRevoke(agent.id).then(
      (change) => {
        if (!cancelled) setPrepared(change);
      },
      (caught: unknown) => {
        if (!cancelled) setError({ tone: 'error', ...describeApprovalError(caught) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visible, signs, api, agent.id]);

  const revoke = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const revoked = signs
        ? await revokeWithApproval(api, agent, auth.signPrivyAuthorization, prepared ?? undefined)
        : await api.revoke(agent.id);
      onDone(
        revoked.policyCleared === false
          ? {
              tone: 'error',
              title: 'Revoked, but the policy isn’t cleared yet',
              detail: 'The agent won’t run again. Revoke again to clear its wallet policy.',
            }
          : {
              tone: 'ok',
              title: `${agent.name} is revoked`,
              detail: 'Its wallet can’t sign anything now.',
            },
      );
    } catch (caught) {
      if (caught instanceof AgentsApiError && caught.reason === 'wallet_policy_update_failed') {
        // The agent IS revoked; only the enclave policy clear failed.
        onDone({ tone: 'error', ...describeAgentsError(caught) });
      } else {
        setError({ tone: 'error', ...describeApprovalError(caught) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} title={`Revoke ${agent.name}?`} onClose={onClose}>
      <Text style={text.body}>
        The agent stops for good, and its wallet’s signing policy is emptied so it can’t sign
        anything again. This can’t be undone.
      </Text>
      <Text style={[text.dim, styles.after]}>
        Funds already in its wallet stay there; revoking doesn’t send them back.
      </Text>
      {signs ? (
        <>
          <Text style={[text.dim, styles.after]}>
            Your passkey signs this. Sente holds no key that can empty this agent’s policy, so the
            phone checks that the change really leaves no rules and then approves it.
          </Text>
          <Row
            label="Enclave rules after"
            value={prepared ? String(prepared.summary.ruleCount) : '…'}
          />
        </>
      ) : null}
      {error ? <Notice tone={error.tone} title={error.title} detail={error.detail} /> : null}
      <View style={styles.sheetAction}>
        <ButtonRow>
          <Button label="Keep agent" onPress={onClose} style={styles.grow} />
          <Button
            label={signs ? 'Approve & revoke' : 'Revoke permanently'}
            kind="danger"
            busy={busy}
            onPress={() => void revoke()}
            style={styles.grow}
          />
        </ButtonRow>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  meta: { marginTop: 4 },
  ledgerLink: { marginTop: 18 },
  actions: { marginTop: 20, gap: 10 },
  actionsTop: { marginTop: 16 },
  after: { marginTop: 10 },
  prose: { color: color.textDim, marginTop: 4 },
  sheetAction: { marginTop: 20 },
});
