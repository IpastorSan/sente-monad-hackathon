/** Your agents: name, model, status and wallet. */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { describeAgentsError, modelLabel, type Agent } from '@/agents/api';
import { useSession } from '@/session';
import { isoDate, shortAddress } from '@/ui/format';
import { Button, Loading, Notice, Screen, TopBar } from '@/ui/kit';
import { color, text } from '@/ui/theme';

type ListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; agents: Agent[] }
  | { kind: 'failed'; title: string; detail: string };

export default function AgentsScreen() {
  const router = useRouter();
  const { agents: api } = useSession();
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setState({ kind: 'loaded', agents: await api.list() });
    } catch (error) {
      setState({ kind: 'failed', ...describeAgentsError(error) });
    }
  }, [api]);

  // Refetch whenever the screen comes back into view: after a hire, an amend
  // or a revoke, the list has to say so.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const hire = () => router.push('/agents/new');

  return (
    <Screen refreshing={refreshing} onRefresh={api ? () => void refresh() : undefined}>
      <TopBar
        back={{
          label: 'Home',
          onPress: () => (router.canGoBack() ? router.back() : router.replace('/')),
        }}
      />
      <View style={styles.header}>
        <Text style={text.display}>Agents</Text>
        {api && state.kind === 'loaded' && state.agents.length > 0 ? (
          <Button label="Hire" kind="primary" onPress={hire} style={styles.hire} />
        ) : null}
      </View>

      {!api ? (
        <>
          <Notice
            title="Sign in first"
            detail="Agents belong to your passkey account. Sign in on the home screen, then come back."
          />
          <Button label="Go to sign-in" onPress={() => router.replace('/')} style={styles.cta} />
        </>
      ) : state.kind === 'loading' ? (
        <Loading />
      ) : state.kind === 'failed' ? (
        <>
          <Notice tone="error" title={state.title} detail={state.detail} />
          <Button label="Try again" onPress={() => void load()} style={styles.cta} />
        </>
      ) : state.agents.length === 0 ? (
        <View style={styles.empty}>
          <Text style={text.title}>No agents yet</Text>
          <Text style={text.dim}>
            An agent trades for you inside a mandate you set: which markets, how much per deposit,
            how large an order, and until when.
          </Text>
          <Button label="Hire an agent" kind="primary" onPress={hire} style={styles.cta} />
        </View>
      ) : (
        <View style={styles.list}>
          {state.agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              onPress={() => router.push({ pathname: '/agents/[id]', params: { id: agent.id } })}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

function AgentRow({ agent, onPress }: { agent: Agent; onPress: () => void }) {
  const active = agent.status === 'active';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowTop}>
        <Text style={[text.title, styles.name, !active && styles.faint]} numberOfLines={1}>
          {agent.name}
        </Text>
        <Text style={[text.dim, !active && styles.faint]}>{active ? '● Active' : '○ Revoked'}</Text>
      </View>
      <Text style={text.dim}>
        {modelLabel(agent.model)} · hired {isoDate(agent.createdAt)}
      </Text>
      <Text style={text.mono}>{shortAddress(agent.address)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    marginBottom: 8,
  },
  hire: { minHeight: 36, paddingHorizontal: 14 },
  cta: { marginTop: 20 },
  empty: { marginTop: 24, paddingTop: 20, borderTopWidth: 1, borderTopColor: color.rule, gap: 8 },
  list: { marginTop: 12, borderTopWidth: 1, borderTopColor: color.rule },
  row: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: color.rule, gap: 3 },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  name: { flex: 1 },
  faint: { color: color.textFaint },
  pressed: { opacity: 0.7 },
});
