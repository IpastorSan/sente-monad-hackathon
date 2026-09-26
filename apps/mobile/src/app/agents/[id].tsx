/**
 * One agent: what its wallet holds, its mandate drawn as gauges, its latest
 * moves, and the things you can do to it — in the order you reach for them
 * (SEN-58). Fund and Run now sit on the wallet card, Amend on the mandate,
 * Return and Revoke in Controls with a line saying what each does; ids and the
 * instructions are behind ⋯ → Details. Fund, run, return and revoke confirm in
 * an in-app sheet (never `Alert`); amend reuses the hire form's mandate and
 * review steps.
 *
 * Return is available on a REVOKED agent too, and deliberately so (SEN-17): a
 * revoke leaves the way out open, so "how do I get my money back" has the same
 * one-tap answer after the agent has stopped as before. The agents list links
 * straight to it with `?sheet=return`.
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatAtoms, parseAmount } from '@/agents/amounts';
import {
  AgentsApiError,
  describeAgentsError,
  modelLabel,
  type Agent,
  type AgentSummary,
  type PreparedMandateChange,
} from '@/agents/api';
import { describeApprovalError, needsApproval, revokeWithApproval } from '@/agents/approval';
import { readBalance, readBalances } from '@/agents/balances';
import { FUNDING_TOKENS } from '@/agents/fund';
import { signedPnl } from '@/agents/ledger';
import { describeMandate, type Enforcer, type Token } from '@/agents/mandate';
import { MoveLine } from '@/agents/MoveLine';
import {
  describeMove,
  expiryUsage,
  formatHolding,
  isTrading,
  mainHolding,
  orderUsage,
  pnlTone,
  type Move,
} from '@/agents/usage';
import { toHoldings } from '@/agents/useWalletHoldings';
import { useSession } from '@/session';
import { describeSendError, sendSponsored } from '@/wallet/send';
import { isoDate, shortAddress } from '@/ui/format';
import { EnforcerTag, Gauge, Pill, Sigil } from '@/ui/goban';
import {
  ActionRow,
  Button,
  ButtonRow,
  Card,
  Chip,
  Chips,
  Field,
  IconButton,
  Loading,
  Notice,
  Row,
  Screen,
  Section,
  SectionLink,
  Sheet,
  TopBar,
  type NoticeTone,
} from '@/ui/kit';
import { color, text } from '@/ui/theme';

type NoticeState = { tone: NoticeTone; title: string; detail?: string };
type SheetId = 'fund' | 'run' | 'return' | 'revoke' | 'details';

/** How many moves the screen shows; the Ledger has the rest. */
const LATEST_MOVES = 3;

/**
 * Limits drawn as a gauge or as the caption, so the rows below the gauges
 * leave them out. `returnTo` is in Details: it is an address, not a limit.
 */
const NOT_A_ROW = new Set([
  'maxOrderNotional',
  'expiresAt',
  'kuru.markets',
  'perpl.markets',
  'returnTo',
]);

export default function AgentScreen() {
  const router = useRouter();
  const { id, sheet: askedSheet } = useLocalSearchParams<{ id: string; sheet?: string }>();
  const { agents: api } = useSession();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [summary, setSummary] = useState<AgentSummary | undefined>(undefined);
  /** `null` while reading; `'failed'` when the event log could not be read. */
  const [moves, setMoves] = useState<Move[] | 'failed' | null>(null);
  const [loadError, setLoadError] = useState<NoticeState | null>(null);
  const [balances, setBalances] = useState<Record<string, bigint> | null>(null);
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refreshBalances = useCallback((address: Agent['address']) => {
    readBalances(address).then(setBalances, () => setBalances(null));
  }, []);

  const load = useCallback(async () => {
    if (!api || !id) return;
    // The summary and the moves only decorate the agent: an API that predates
    // SEN-56, or a blip, leaves the screen standing with the caps and no usage.
    const [fresh, summaries, events] = await Promise.allSettled([
      api.get(id),
      api.summaries(),
      api.events(id, undefined, 5),
    ]);
    if (fresh.status === 'rejected') {
      setLoadError({ tone: 'error', ...describeAgentsError(fresh.reason) });
      return;
    }
    setAgent(fresh.value);
    setLoadError(null);
    refreshBalances(fresh.value.address);
    setSummary(
      summaries.status === 'fulfilled'
        ? summaries.value.find((line) => line.agentId === id)
        : undefined,
    );
    setMoves(
      events.status === 'fulfilled'
        ? events.value.events
            .map(describeMove)
            .filter((move): move is Move => move !== null)
            .reverse()
            .slice(0, LATEST_MOVES)
        : 'failed',
    );
  }, [api, id, refreshBalances]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // Arriving from the list's inline "Return" opens the return sheet once, not
  // on every refetch.
  const opened = useRef(false);
  useEffect(() => {
    if (agent && askedSheet === 'return' && !opened.current) {
      opened.current = true;
      setSheet('return');
    }
  }, [agent, askedSheet]);

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
  const now = Date.now();
  const trading = active && isTrading(summary, now);
  const holdings = balances ? toHoldings(balances) : null;
  const main = holdings
    ? mainHolding(holdings, agent.mandate.venues.includes('kuru') ? 'USDC' : 'AUSD')
    : null;
  const others = holdings?.filter((holding) => holding !== main && holding.atoms > 0n) ?? [];
  const allTime = summary?.pnl.allTime;
  const allTimeTone = pnlTone(allTime);

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <TopBar
        back={{ label: 'Agents', onPress: backToList }}
        right={<IconButton icon="more" label="Details" onPress={() => setSheet('details')} />}
      />
      <View style={styles.header}>
        <Sigil seed={agent.id} size={56} dimmed={!active} />
        <View style={styles.headerText}>
          <Text style={[text.display, styles.name]} numberOfLines={2}>
            {agent.name}
          </Text>
          <Text style={text.caption}>
            {modelLabel(agent.model)} · hired {isoDate(agent.createdAt)}
          </Text>
        </View>
      </View>

      {notice ? <Notice tone={notice.tone} title={notice.title} detail={notice.detail} /> : null}

      {active ? null : (
        <Notice
          title={`Revoked${agent.revokedAt ? ` on ${isoDate(agent.revokedAt)}` : ''}`}
          detail={
            agent.policyCleared === false
              ? 'The agent won’t run again, but its wallet policy still holds the old rules. Revoke again to clear it.'
              : 'It can’t trade, deposit or approve anything again — revoking is permanent. Its ' +
                'policy keeps only the way out, so you can still send its funds back to your wallet.'
          }
        />
      )}

      <Card quiet={!active} style={styles.wallet}>
        <View style={styles.between}>
          <Text style={text.label}>In this agent’s wallet</Text>
          {active ? (
            <Pill label={trading ? 'Trading' : 'Watching'} tone={trading ? 'live' : 'idle'} />
          ) : (
            <Pill label="Revoked" tone="revoked" />
          )}
        </View>
        {main ? (
          <View style={styles.figure}>
            <Text style={[text.hero, styles.hero]}>{formatHolding(main)}</Text>
            <Text style={text.dim}>{main.symbol}</Text>
            {allTime !== undefined ? (
              <Text
                style={[
                  text.dim,
                  text.num,
                  styles.pnl,
                  allTimeTone === 'up' && text.up,
                  allTimeTone === 'down' && text.down,
                ]}
              >
                {allTimeTone === null ? '0' : signedPnl(allTime)} all time
              </Text>
            ) : null}
          </View>
        ) : (
          <Text style={[text.dim, styles.reading]}>
            {balances === null ? 'Reading the chain…' : '—'}
          </Text>
        )}
        {others.length > 0 ? (
          <Text style={[text.caption, text.num]}>
            {others.map((holding) => `${formatHolding(holding)} ${holding.symbol}`).join(' · ')}
          </Text>
        ) : null}
        <View style={styles.walletActions}>
          {active ? (
            <ButtonRow>
              <Button
                label="Fund"
                kind="primary"
                size="sm"
                onPress={() => setSheet('fund')}
                style={styles.grow}
              />
              <Button
                label="Run now"
                kind="soft"
                size="sm"
                icon="bolt"
                onPress={() => setSheet('run')}
                style={styles.grow}
              />
            </ButtonRow>
          ) : (
            // The whole point of a revoke that keeps the exit (SEN-17).
            <Button
              label="Return funds"
              kind="primary"
              size="sm"
              icon="return"
              onPress={() => setSheet('return')}
            />
          )}
        </View>
      </Card>

      {/*
       * A revoked agent's policy keeps only the way out, so its mandate no
       * longer bounds anything and drawing its gauges would read as live limits.
       */}
      {active ? (
        <Section
          label="Mandate"
          aside={
            <SectionLink
              label="Amend"
              onPress={() => router.push({ pathname: '/agents/new', params: { amend: agent.id } })}
            />
          }
        >
          <MandateGauges agent={agent} summary={summary} now={now} />
        </Section>
      ) : null}

      <Section
        label="Latest moves"
        aside={
          <SectionLink
            label="Ledger"
            onPress={() =>
              router.push({ pathname: '/agents/[id]/ledger', params: { id: agent.id } })
            }
          />
        }
      >
        {moves === null ? (
          <Text style={text.caption}>Reading its moves…</Text>
        ) : moves === 'failed' ? (
          <Text style={text.caption}>Couldn’t read its moves. Pull down to try again.</Text>
        ) : moves.length === 0 ? (
          <Text style={text.dim}>
            {active
              ? 'No moves yet. It trades on its next run, or when you run it now.'
              : 'No moves.'}
          </Text>
        ) : (
          <View style={styles.moves}>
            {moves.map((move) => (
              <MoveLine key={`${move.at}-${move.line}`} move={move} now={now} />
            ))}
          </View>
        )}
      </Section>

      {active ? (
        <Section label="Controls">
          <ActionRow
            icon="return"
            title="Return funds"
            detail="Everything back to your wallet"
            onPress={() => setSheet('return')}
          />
          <ActionRow
            icon="stop"
            title="Revoke"
            detail="Stops it for good. Funds stay returnable."
            danger
            onPress={() => setSheet('revoke')}
          />
        </Section>
      ) : agent.policyCleared === false ? (
        <Section label="Controls">
          <ActionRow
            icon="stop"
            title="Revoke again"
            detail="Clears the old rules from its wallet policy."
            danger
            onPress={() => setSheet('revoke')}
          />
        </Section>
      ) : null}

      <DetailsSheet agent={agent} visible={sheet === 'details'} onClose={close} />
      <FundSheet agent={agent} visible={sheet === 'fund'} onClose={close} onSent={finish} />
      <RunSheet agent={agent} visible={sheet === 'run'} onClose={close} />
      <ReturnSheet agent={agent} visible={sheet === 'return'} onClose={close} onDone={finish} />
      <RevokeSheet agent={agent} visible={sheet === 'revoke'} onClose={close} onDone={finish} />
    </Screen>
  );
}

/**
 * The mandate as territory. Only two limits have anything to measure against
 * them — the largest order the agent has sent, and time — so only those two are
 * gauges; every other limit is its cap, as a row. Each says who enforces it,
 * from `describeMandate`, so this screen and the hire review agree.
 */
function MandateGauges({
  agent,
  summary,
  now,
}: {
  agent: Agent;
  summary: AgentSummary | undefined;
  now: number;
}) {
  const { mandate } = agent;
  const limits = describeMandate(mandate);
  const enforcerOf = (limitId: string): Enforcer | undefined =>
    limits.find((limit) => limit.id === limitId)?.enforcer;

  const order = orderUsage(summary, mandate);
  const since = summary?.mandateSince ?? Date.parse(agent.createdAt);
  const expiry = expiryUsage(since, mandate.expiresAt, now);

  const markets = [
    ['kuru.markets', 'Kuru spot'],
    ['perpl.markets', 'Perpl perps'],
  ]
    .map(([limitId, venue]) => {
      const limit = limits.find((candidate) => candidate.id === limitId);
      return limit ? `${limit.value} on ${venue}` : null;
    })
    .filter((line): line is string => line !== null);

  return (
    <View style={styles.gauges}>
      <View style={styles.gaugeBlock}>
        <Gauge
          label="Largest order"
          value={order.value}
          used={order.used}
          enforcer={enforcerOf('maxOrderNotional')}
        />
        <Text style={text.caption}>
          {!order.measured
            ? 'Usage shows once Sente reports this agent’s orders.'
            : order.over
              ? 'Its largest order is above the current cap.'
              : summary?.largestOrderNotional === null
                ? 'No orders yet. The cap is in quote units.'
                : 'Its largest order so far, in quote units.'}
        </Text>
      </View>
      <Gauge
        label="Mandate ends"
        value={expiry.value}
        used={expiry.used}
        enforcer={enforcerOf('expiresAt')}
      />
      {limits.some((limit) => !NOT_A_ROW.has(limit.id)) ? (
        <View>
          {limits
            .filter((limit) => !NOT_A_ROW.has(limit.id))
            .map((limit) => (
              <LimitRow
                key={limit.id}
                label={limit.label}
                value={limit.value}
                enforcer={limit.enforcer}
              />
            ))}
        </View>
      ) : null}
      {markets.length > 0 ? <Text style={text.caption}>{markets.join(' · ')}</Text> : null}
    </View>
  );
}

/** A limit with no usage to draw: its cap, and who enforces it — a gauge's head alone. */
function LimitRow({
  label,
  value,
  enforcer,
}: {
  label: string;
  value: string;
  enforcer: Enforcer;
}) {
  return (
    <View style={styles.limit}>
      <View style={styles.limitLabel}>
        <Text style={text.dim}>{label}</Text>
        <EnforcerTag enforcer={enforcer} />
      </View>
      <Text style={[text.strong, text.num, styles.limitValue]}>{value}</Text>
    </View>
  );
}

/** ⋯ → Details: the ids a support question needs, and the instructions the agent runs on. */
function DetailsSheet({
  agent,
  visible,
  onClose,
}: {
  agent: Agent;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} title="Details" onClose={onClose}>
      <Row label="Agent" value={agent.id} mono />
      <Row label="Wallet" value={agent.address} mono />
      <Row label="Wallet id" value={agent.walletId} mono />
      <Row label="Policy" value={agent.policyId} mono />
      {agent.erc8004AgentId ? <Row label="ERC-8004" value={agent.erc8004AgentId} mono /> : null}
      {/* The whole address, never shortened: it is the one place its funds can go. */}
      <Row label="Funds return to" value={agent.mandate.returnTo ?? 'Nowhere'} mono />
      <Text style={[text.label, styles.instructions]}>System prompt</Text>
      <Text style={[text.body, styles.prose]} selectable>
        {agent.systemPrompt || '—'}
      </Text>
      <Text style={[text.label, styles.instructions]}>Strategy</Text>
      <Text style={[text.body, styles.prose]} selectable>
        {agent.strategy || '—'}
      </Text>
    </Sheet>
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
        key that can move your funds — and the agent’s key can only ever send them back to you, with
        the “Return funds” button, whether or not it is still running.
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
        icon="bolt"
        busy={busy}
        onPress={() => void run()}
        style={styles.sheetAction}
      />
    </Sheet>
  );
}

/**
 * RETURNING AN AGENT'S FUNDS TO ITS OWNER (SEN-17).
 *
 * One tap, no signature, no address to type: the destination is the `returnTo`
 * compiled into the agent's enclave policy — this account's own wallet — and the
 * agent's key can sign a transfer to it and to nowhere else. So there is nothing
 * here for the passkey to approve that the policy does not already pin, which is
 * why this sheet is a confirmation and not an approval.
 *
 * It works on a revoked agent, because a revoke leaves those rules in place.
 */
function ReturnSheet({
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
  const { agents: api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NoticeState | null>(null);
  const exit = agent.mandate.returnTo;

  const send = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.returnFunds(agent.id);
      const moved = result.assets.filter((asset) => asset.returned?.success);
      const failed = result.assets.filter((asset) => asset.returned && !asset.returned.success);
      const summary = moved.map((asset) => `${asset.returned!.amount} ${asset.asset}`).join(', ');
      if (failed.length > 0) {
        // Gotcha 8's corollary: each leg is its own transaction, so some can land
        // while others revert. Saying "sent" here would be a lie about money.
        setError({
          tone: 'error',
          title: 'Part of it didn’t go through',
          detail:
            `${failed.map((asset) => asset.asset).join(', ')} reverted on chain, so that part ` +
            `didn’t move${summary ? `. ${summary} did` : ''}. Try again.`,
        });
        return;
      }
      onDone(
        moved.length > 0
          ? {
              tone: 'ok',
              title: `Sent ${summary} back to your wallet`,
              detail: `Gas cost the agent ${result.monSpent} MON. Balances update once the chain catches up.`,
            }
          : {
              tone: 'info',
              title: 'There was nothing to send back',
              detail:
                'This agent holds no tokens. Its leftover MON stays with it: no rule lets an ' +
                'agent move native MON, so gas cannot be swept.',
            },
      );
    } catch (caught) {
      setError({ tone: 'error', ...describeAgentsError(caught) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} title={`Return ${agent.name}’s funds`} onClose={onClose}>
      <Text style={text.body}>
        Everything this agent holds — in its wallet and as free Kuru collateral — goes back to your
        own wallet. Collateral reserved by a resting order stays until that order is cancelled.
      </Text>
      <Row label="To your wallet" value={exit ? shortAddress(exit) : '—'} mono />
      <Text style={[text.caption, styles.after]}>
        {exit
          ? 'This address is written into the agent’s signing policy, so its key can send funds ' +
            'here and nowhere else — even after the mandate expires or you revoke it.'
          : 'This agent was hired before return-to-owner existed, so its policy has no transfer ' +
            'rule. Amend its mandate and it will carry your wallet.'}
      </Text>
      <Text style={[text.caption, styles.after]}>
        Its leftover MON stays with it: no rule lets an agent move native MON.
      </Text>
      {error ? <Notice tone={error.tone} title={error.title} detail={error.detail} /> : null}
      <Button
        label="Return everything"
        kind="primary"
        icon="return"
        busy={busy}
        disabled={!exit}
        onPress={() => void send()}
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
   * A device-owned agent's policy can only be changed by a PATCH this phone
   * signed (SEN-44): the API asks, the passkey approves. `revokeWithApproval`
   * checks that the PATCH leaves exactly this mandate's way out and nothing the
   * agent could take risk with, before signing anything (SEN-17).
   */
  const signs = needsApproval(agent);
  const [prepared, setPrepared] = useState<PreparedMandateChange | null>(null);

  // Asked for as the sheet opens, not when the button is pressed: the change is
  // then on screen to read (how many rules it leaves), and the passkey prompt is
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
              detail:
                'It can’t trade or deposit again. You can still send its funds back to your wallet.',
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
        The agent stops for good, and its signing policy loses every rule it could trade, deposit or
        approve with. This can’t be undone.
      </Text>
      <Text style={[text.dim, styles.after]}>
        What it keeps is the way out: funds stay in its wallet until you send them back with “Return
        funds”, which still works afterwards. Its leftover MON stays with it.
      </Text>
      {signs ? (
        <>
          <Text style={[text.dim, styles.after]}>
            Your passkey signs this. Sente holds no key that can change this agent’s policy, so the
            phone checks that the change leaves nothing but the way home and then approves it.
          </Text>
          <Row
            label="Enclave rules after"
            value={prepared ? `${String(prepared.summary.ruleCount)} — the way out only` : '…'}
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
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 },
  headerText: { flex: 1, gap: 4 },
  name: { fontSize: 28, lineHeight: 32 },
  wallet: { marginTop: 18 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  figure: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 10 },
  hero: { fontSize: 40, lineHeight: 44 },
  pnl: { marginLeft: 'auto' },
  reading: { marginTop: 10 },
  walletActions: { marginTop: 16 },
  gauges: { gap: 16 },
  gaugeBlock: { gap: 6 },
  limit: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  limitLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  limitValue: { fontSize: 14, flexShrink: 1, textAlign: 'right' },
  moves: { gap: 12 },
  instructions: { marginTop: 20 },
  after: { marginTop: 10 },
  prose: { color: color.textDim, marginTop: 6 },
  sheetAction: { marginTop: 20 },
});
