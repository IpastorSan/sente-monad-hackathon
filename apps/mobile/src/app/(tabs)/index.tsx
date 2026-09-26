/**
 * Home (SEN-57): what you hold, what your agents are doing with it, and the
 * last thing one of them did. Signing in is `/welcome` and the signing key is
 * on Account (SEN-55), so nothing here is about the passkey.
 *
 * The AUSD figure leads because it is what an agent trades with on Perpl (and
 * the Agora bounty asks for it on screen); USDC and MON follow on one line, MON
 * last because gas is sponsored and a user should not have to think about it.
 *
 * The address is the user's PRIVY WALLET (SEN-40), not the passkey EOA and not
 * the old Kernel account: it is the address to fund, and showing any other one
 * here is how money ends up somewhere the app cannot spend it.
 *
 * "Add funds" is a sheet with the whole address and the system share sheet,
 * not a copy button: the app has no clipboard module, and adding one is a
 * native dependency (a dev-client rebuild) for something `Share` already does.
 *
 * What is chosen and how it is worded — which agents make the list, their
 * pills, the latest move as a sentence — is `agents/home.ts`, under test.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import type { Address } from 'viem';

import type { Agent, AgentSummary } from '@/agents/api';
import { readBalance } from '@/agents/balances';
import { FUNDING_TOKENS } from '@/agents/fund';
import {
  agentPill,
  homeAgents,
  latestMove,
  pnlToday,
  sinceLabel,
  stableBalance,
  type LatestMove,
} from '@/agents/home';
import { useAgentsOverview } from '@/agents/useAgentsOverview';
import { useSession } from '@/session';
import { ConsensusFeed, ConsensusRamp } from '@/ui/ConsensusRamp';
import { formatBalance, shortAddress } from '@/ui/format';
import { Mark, Pill, Sigil, Stone } from '@/ui/goban';
import {
  Button,
  ButtonRow,
  Card,
  Loading,
  Notice,
  Screen,
  Section,
  SectionLink,
  Sheet,
} from '@/ui/kit';
import { color, text } from '@/ui/theme';
import { balanceOf, type UseUserWallet } from '@/wallet';

/** What an agent's balance on Home counts: its stablecoins, as one quote figure. */
const STABLES = FUNDING_TOKENS.filter(
  (token) => token.symbol === 'USDC' || token.symbol === 'AUSD',
);

export default function Home() {
  const router = useRouter();
  // The session lives in <SessionProvider> so the agent screens share it. The
  // tabs layout only renders this once it is signed in.
  const { wallet } = useSession();
  const overview = useAgentsOverview();
  const activity = useLatestMove();
  const [fundOpen, setFundOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Bumped by a pull, so the agent balances re-read with everything else. */
  const [pulls, setPulls] = useState(0);

  // Balances move while the user is elsewhere in the app — an agent trades, a
  // faucet lands. Re-read whenever this screen comes back into view. (The
  // overview and the latest move do the same in their own hooks.)
  useFocusEffect(
    useCallback(() => {
      void wallet.refresh();
    }, [wallet.refresh]),
  );

  const refresh = async () => {
    setRefreshing(true);
    setPulls((n) => n + 1);
    await Promise.all([wallet.refresh(), overview.refresh(), activity.refresh()]);
    setRefreshing(false);
  };

  const address = wallet.wallet?.address ?? null;
  const move = activity.move;
  const share = () => {
    if (address !== null) void Share.share({ message: address });
  };

  return (
    <Screen tabbed refreshing={refreshing} onRefresh={() => void refresh()}>
      <View style={styles.header}>
        <Text style={text.label}>gmonad</Text>
        <Mark />
      </View>

      <WalletCard wallet={wallet} onAddFunds={() => setFundOpen(true)} onShare={share} />

      <Agents overview={overview.state} pulls={pulls} />

      {move !== null ? (
        <Section
          label="Latest move"
          aside={
            <SectionLink
              label="Ledger"
              onPress={() =>
                router.push({
                  pathname: '/agents/[id]/ledger',
                  params: { id: move.agentId },
                })
              }
            />
          }
        >
          <Move move={move} />
        </Section>
      ) : null}

      {address !== null ? (
        <FundSheet
          visible={fundOpen}
          address={address}
          onShare={share}
          onClose={() => setFundOpen(false)}
        />
      ) : null}
    </Screen>
  );
}

/** The balance card: what the user holds, and the two ways to add to it. */
function WalletCard({
  wallet,
  onAddFunds,
  onShare,
}: {
  wallet: UseUserWallet;
  onAddFunds: () => void;
  onShare: () => void;
}) {
  const held = wallet.wallet;
  return (
    <Card goban style={styles.walletCard}>
      <View style={styles.between}>
        <Text style={text.label}>Available to trade</Text>
        <Pill label="Gas sponsored" tone="live" />
      </View>

      {wallet.status === 'registering' || (held === null && wallet.status !== 'error') ? (
        <>
          <Loading />
          <Text style={text.caption}>Claiming the wallet your device key owns…</Text>
        </>
      ) : held === null ? (
        <Notice
          tone="error"
          title="Could not reach your wallet"
          detail={wallet.error?.message ?? 'The API did not answer. Pull to try again.'}
        />
      ) : (
        <>
          <View style={styles.hero}>
            <Text style={[text.hero, styles.heroFigure]} numberOfLines={1} adjustsFontSizeToFit>
              {formatBalance(balanceOf(held, 'AUSD'))}
            </Text>
            <Text style={[text.strong, styles.heroSymbol]}>AUSD</Text>
          </View>
          <Text style={[text.dim, text.num, styles.minor]}>
            + {formatBalance(balanceOf(held, 'USDC'))} USDC ·{' '}
            {formatBalance(balanceOf(held, 'MON'))} MON
          </Text>
          {wallet.status === 'error' && wallet.error ? (
            <Notice tone="error" title="Balances may be stale" detail={wallet.error.message} />
          ) : null}
        </>
      )}

      <View style={styles.walletButtons}>
        <ButtonRow>
          <Button
            label="Add funds"
            kind="primary"
            size="sm"
            icon="plus"
            onPress={onAddFunds}
            disabled={held === null}
            style={styles.grow}
          />
          <Button
            label={held !== null ? shortAddress(held.address) : '—'}
            kind="soft"
            size="sm"
            icon="share"
            onPress={onShare}
            disabled={held === null}
            style={styles.grow}
          />
        </ButtonRow>
      </View>
    </Card>
  );
}

/** Where to send money, whole and selectable, and a way to send it elsewhere. */
function FundSheet({
  visible,
  address,
  onShare,
  onClose,
}: {
  visible: boolean;
  address: string;
  onShare: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} title="Add funds" onClose={onClose}>
      <Text style={text.dim}>
        Send AUSD or USDC on Monad testnet to your wallet. That is what your agents trade with; gas
        is sponsored, so you never need MON.
      </Text>
      <View style={styles.addressWell}>
        <Text style={[text.mono, styles.address]} selectable>
          {address}
        </Text>
      </View>
      <Text style={text.caption}>Only send on Monad testnet. Other networks will not arrive.</Text>
      <Button
        label="Share address"
        kind="primary"
        icon="share"
        onPress={onShare}
        style={styles.sheetButton}
      />
    </Sheet>
  );
}

function Agents({
  overview,
  pulls,
}: {
  overview: ReturnType<typeof useAgentsOverview>['state'];
  pulls: number;
}) {
  const router = useRouter();
  const seeAll = <SectionLink label="See all" onPress={() => router.push('/agents')} />;

  if (overview.kind === 'loading') {
    return (
      <Section label="Your agents">
        <Loading />
      </Section>
    );
  }
  if (overview.kind === 'failed') {
    return (
      <Section label="Your agents" aside={seeAll}>
        <Notice tone="error" title={overview.title} detail={overview.detail} />
      </Section>
    );
  }
  if (overview.agents.length === 0) {
    return (
      <Section label="Your agents">
        <Card>
          <Text style={text.title}>Put an agent to work</Text>
          <Text style={[text.dim, styles.inviteText]}>
            An agent trades for you inside a mandate you set: which markets, how much, and until
            when. The enclave refuses anything outside it.
          </Text>
          <Button
            label="Hire your first agent"
            kind="primary"
            icon="plus"
            onPress={() => router.push('/agents/new')}
            style={styles.inviteButton}
          />
        </Card>
      </Section>
    );
  }
  return (
    <Section label="Your agents" aside={seeAll}>
      <AgentList
        agents={homeAgents(overview.agents, overview.summaries)}
        summaries={overview.summaries}
        pulls={pulls}
      />
    </Section>
  );
}

function AgentList({
  agents,
  summaries,
  pulls,
}: {
  agents: Agent[];
  summaries: ReadonlyMap<string, AgentSummary>;
  pulls: number;
}) {
  const router = useRouter();
  const balances = useAgentBalances(agents, pulls);
  const now = Date.now();
  return (
    <View>
      {agents.map((agent, index) => {
        const summary = summaries.get(agent.id);
        const pill = agentPill(agent, summary, now);
        const pnl = pnlToday(summary);
        return (
          <Pressable
            key={agent.id}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/agents/[id]', params: { id: agent.id } })}
            style={({ pressed }) => [
              styles.agentRow,
              index === agents.length - 1 && styles.lastRow,
              pressed && styles.pressed,
            ]}
          >
            <Sigil seed={agent.id} dimmed={agent.status === 'revoked'} />
            <View style={styles.agentMain}>
              <Text style={text.strong} numberOfLines={1}>
                {agent.name}
              </Text>
              <Pill label={pill.label} tone={pill.tone} />
            </View>
            <View style={styles.agentFigures}>
              <Text style={[text.strong, text.num]}>{balances.get(agent.id) ?? '—'}</Text>
              {pnl !== null ? (
                <Text
                  style={[
                    text.dim,
                    text.num,
                    pnl.tone === 'up' && text.up,
                    pnl.tone === 'down' && text.down,
                  ]}
                >
                  {pnl.label}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Each listed agent's stablecoin balance, read from the chain. A failed read
 * leaves that agent's figure a dash: a balance we could not read is not zero.
 */
function useAgentBalances(agents: Agent[], pulls: number): ReadonlyMap<string, string> {
  const [balances, setBalances] = useState<ReadonlyMap<string, string>>(new Map());
  // Keyed on the ids and addresses, not the array: the overview hands back a
  // new array on every focus, and that alone must not re-read the chain.
  const key = agents.map((agent) => `${agent.id}:${agent.address}`).join(',');
  const targets = useMemo(
    () => agents.map((agent) => ({ id: agent.id, address: agent.address })),
    [key],
  );

  useEffect(() => {
    let live = true;
    void Promise.all(
      targets.map(async ({ id, address }) => {
        try {
          return [id, stableBalance(await readStables(address), STABLES)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((entries) => {
      if (!live) return;
      setBalances(new Map(entries.filter((entry): entry is [string, string] => entry[1] !== null)));
    });
    return () => {
      live = false;
    };
  }, [targets, pulls]);

  return balances;
}

async function readStables(owner: Address): Promise<Record<string, bigint>> {
  const entries = await Promise.all(
    STABLES.map(async (token) => [token.symbol, await readBalance(token, owner)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * The newest event across every agent. The route is new in SEN-56 and may not
 * be deployed yet, so any failure reads as "no activity": the section is left
 * out, never shown as an error on the home screen.
 */
function useLatestMove(): { move: LatestMove | null; refresh: () => Promise<void> } {
  const { agents: api } = useSession();
  const [move, setMove] = useState<LatestMove | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const [newest] = await api.activity(1);
      setMove(newest ? latestMove(newest) : null);
    } catch {
      setMove(null);
    }
  }, [api]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  return { move, refresh };
}

/** One ledger event as a sentence, with its stone, and the ramp if it landed in a block. */
function Move({ move }: { move: LatestMove }) {
  return (
    <View style={styles.move}>
      <View style={styles.moveStone}>
        <Stone kind={move.stone} />
      </View>
      <View style={styles.grow}>
        <View style={styles.moveHead}>
          <Text style={[text.strong, styles.grow]}>{move.title}</Text>
          <Text style={[text.mono, styles.moveTime]}>{sinceLabel(move.at, Date.now())}</Text>
        </View>
        {move.detail !== null ? (
          <Text style={text.dim} numberOfLines={2}>
            {move.detail}
          </Text>
        ) : null}
        {move.block !== null ? (
          // The ramp polls through a feed; Home has exactly one ramp, so one feed.
          <ConsensusFeed>
            <ConsensusRamp blockNumber={move.block.number} consensus={move.block.consensus} />
          </ConsensusFeed>
        ) : null}
      </View>
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
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  grow: { flex: 1 },
  walletCard: { marginTop: 8 },
  hero: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 14 },
  heroFigure: { flexShrink: 1 },
  heroSymbol: { color: color.textDim },
  minor: { marginTop: 6 },
  walletButtons: { marginTop: 18 },
  addressWell: {
    marginVertical: 16,
    padding: 14,
    borderRadius: 14,
    backgroundColor: color.well,
  },
  address: { fontSize: 14, lineHeight: 22, color: color.text },
  sheetButton: { marginTop: 20 },
  inviteText: { marginTop: 6 },
  inviteButton: { marginTop: 16 },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  lastRow: { borderBottomWidth: 0 },
  pressed: { opacity: 0.7 },
  agentMain: { flex: 1, minWidth: 0, gap: 4 },
  agentFigures: { alignItems: 'flex-end', gap: 2 },
  move: { flexDirection: 'row', gap: 14 },
  moveStone: { marginTop: 4 },
  moveHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  moveTime: { fontSize: 11, color: color.textFaint },
});
