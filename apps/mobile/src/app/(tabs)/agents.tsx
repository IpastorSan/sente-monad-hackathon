/**
 * Your agents, one card each (SEN-58): is it working, and is it making money.
 * A card carries the agent's sigil, what it trades, its status, the balance in
 * its own wallet, today's P&L and its last move as a stone.
 *
 * A revoked agent that still holds funds says so and offers the return inline
 * (SEN-17): "how do I get my money back" has the same one-tap answer after the
 * agent has stopped, so the roster is where it is asked.
 */
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { modelLabel, type Agent, type AgentSummary } from '@/agents/api';
import { signedPnl } from '@/agents/ledger';
import { MoveLine } from '@/agents/MoveLine';
import {
  describeMove,
  formatHolding,
  holdsReturnable,
  isTrading,
  mainHolding,
  pnlTone,
  venuesCaption,
  type Holding,
} from '@/agents/usage';
import { useAgentsOverview } from '@/agents/useAgentsOverview';
import { useWalletHoldings } from '@/agents/useWalletHoldings';
import { useSession } from '@/session';
import { isoDate } from '@/ui/format';
import { Pill, Sigil } from '@/ui/goban';
import { Button, Card, Loading, Notice, Screen, Segmented } from '@/ui/kit';
import { color, text } from '@/ui/theme';

type Filter = 'all' | 'active' | 'revoked';

export default function AgentsScreen() {
  const router = useRouter();
  const { agents: api } = useSession();
  // Refetches on focus: after a hire, an amend or a revoke, the list has to say so.
  const { state, refreshing, refresh } = useAgentsOverview();
  const [filter, setFilter] = useState<Filter>('all');

  const agents = state.kind === 'loaded' ? state.agents : null;
  const holdings = useWalletHoldings(agents);

  const hire = () => router.push('/agents/new');
  const open = (agent: Agent, sheet?: 'return') =>
    router.push({
      pathname: '/agents/[id]',
      params: sheet ? { id: agent.id, sheet } : { id: agent.id },
    });

  const counts = useMemo(() => {
    const active = agents?.filter((agent) => agent.status === 'active').length ?? 0;
    return { all: agents?.length ?? 0, active, revoked: (agents?.length ?? 0) - active };
  }, [agents]);
  const shown = agents?.filter((agent) => filter === 'all' || agent.status === filter) ?? [];
  const now = Date.now();

  return (
    <Screen tabbed refreshing={refreshing} onRefresh={api ? () => void refresh() : undefined}>
      <View style={styles.header}>
        <Text style={text.display}>Agents</Text>
        {api ? <Button label="Hire" kind="primary" size="sm" icon="plus" onPress={hire} /> : null}
      </View>

      {!api ? (
        <Notice
          title="Sign in first"
          detail="Agents belong to your passkey account. Sign in, then come back."
        />
      ) : state.kind === 'loading' ? (
        <Loading />
      ) : state.kind === 'failed' ? (
        <>
          <Notice tone="error" title={state.title} detail={state.detail} />
          <Button label="Try again" onPress={() => void refresh()} style={styles.cta} />
        </>
      ) : state.agents.length === 0 ? (
        <Card style={styles.empty}>
          <Text style={text.title}>Hire your first agent</Text>
          <Text style={text.dim}>
            An agent trades for you inside a mandate you set: which markets, how much per deposit,
            how large an order, and until when. The enclave won’t sign anything past it.
          </Text>
          <Button label="Hire an agent" kind="primary" icon="plus" onPress={hire} />
        </Card>
      ) : (
        <>
          <View style={styles.filter}>
            <Segmented
              options={[
                { value: 'all', label: `All ${counts.all}` },
                { value: 'active', label: `Active ${counts.active}` },
                { value: 'revoked', label: `Revoked ${counts.revoked}` },
              ]}
              value={filter}
              onChange={setFilter}
            />
          </View>
          <View style={styles.list}>
            {shown.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                summary={state.summaries.get(agent.id)}
                holdings={holdings.get(agent.id)}
                now={now}
                onOpen={() => open(agent)}
                onReturn={() => open(agent, 'return')}
              />
            ))}
            {shown.length === 0 ? (
              <Text style={[text.dim, styles.none]}>
                {filter === 'active' ? 'No active agents.' : 'No revoked agents.'}
              </Text>
            ) : null}
          </View>
        </>
      )}
    </Screen>
  );
}

function AgentCard({
  agent,
  summary,
  holdings,
  now,
  onOpen,
  onReturn,
}: {
  agent: Agent;
  summary: AgentSummary | undefined;
  /** `undefined` until the chain answers, or if it didn't. */
  holdings: Holding[] | undefined;
  now: number;
  onOpen: () => void;
  onReturn: () => void;
}) {
  const active = agent.status === 'active';
  const trading = active && isTrading(summary, now);
  const main = holdings
    ? mainHolding(holdings, agent.mandate.venues.includes('kuru') ? 'USDC' : 'AUSD')
    : null;
  const move = summary?.lastEvent ? describeMove(summary.lastEvent) : null;
  const today = summary?.pnl.last24h;
  const tone = pnlTone(today);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${agent.name}, ${active ? (trading ? 'trading' : 'watching') : 'revoked'}`}
      onPress={onOpen}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Card quiet={!active}>
        <View style={styles.top}>
          <Sigil seed={agent.id} dimmed={!active} />
          <View style={styles.grow}>
            <Text style={[text.title, !active && styles.dim]} numberOfLines={1}>
              {agent.name}
            </Text>
            <Text style={text.caption} numberOfLines={1}>
              {active
                ? `${modelLabel(agent.model)} · ${venuesCaption(agent.mandate)}`
                : `Revoked${agent.revokedAt ? ` ${isoDate(agent.revokedAt)}` : ''}`}
            </Text>
          </View>
          {active ? (
            <Pill label={trading ? 'Trading' : 'Watching'} tone={trading ? 'live' : 'idle'} />
          ) : (
            <Pill label="Revoked" tone="revoked" />
          )}
        </View>

        {active ? (
          <>
            <View style={styles.figures}>
              <Text style={[text.strong, text.num]}>
                {main ? formatHolding(main) : '—'}{' '}
                <Text style={text.dim}>{main?.symbol ?? ''}</Text>
              </Text>
              {today !== undefined ? (
                <Text
                  style={[
                    text.dim,
                    text.num,
                    tone === 'up' && text.up,
                    tone === 'down' && text.down,
                  ]}
                >
                  {tone === null ? '0' : signedPnl(today)} today
                </Text>
              ) : null}
            </View>
            {move ? (
              <>
                <View style={styles.hairline} />
                <MoveLine move={move} now={now} />
              </>
            ) : null}
          </>
        ) : holdings && main && holdsReturnable(holdings) ? (
          <View style={styles.figures}>
            <Text style={[text.dim, text.num, styles.grow]}>
              {formatHolding(main)} {main.symbol} still in its wallet
            </Text>
            <Button label="Return" kind="soft" size="sm" onPress={onReturn} />
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 44,
  },
  filter: { marginTop: 18 },
  list: { marginTop: 16, gap: 12 },
  cta: { marginTop: 20 },
  empty: { marginTop: 24, gap: 12 },
  none: { marginTop: 8 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, gap: 2 },
  dim: { color: color.textDim },
  figures: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 14,
  },
  hairline: { height: 1, backgroundColor: color.line, marginVertical: 12 },
  pressed: { opacity: 0.85 },
});
