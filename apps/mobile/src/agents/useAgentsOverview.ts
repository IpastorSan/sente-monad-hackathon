/**
 * The user's agents with their one-line summaries (SEN-55/SEN-56), shared by
 * Home and the Agents tab so both read the same two requests the same way.
 *
 * `GET /agents` decides what exists; `GET /agents/summaries` only decorates it.
 * A summaries failure — an API that predates SEN-56, a blip — therefore leaves
 * the list standing with no figures rather than failing the screen: a roster
 * without P&L is still the roster, and an empty one would be a lie.
 *
 * Refetches whenever the screen using it comes back into view, because a hire,
 * an amend, a revoke or a trade elsewhere in the app has to show up here.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useSession } from '@/session';

import { describeAgentsError, type Agent, type AgentSummary } from './api';

export type AgentsOverview =
  | { kind: 'loading' }
  | { kind: 'loaded'; agents: Agent[]; summaries: ReadonlyMap<string, AgentSummary> }
  | { kind: 'failed'; title: string; detail: string };

export function useAgentsOverview(): {
  state: AgentsOverview;
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const { agents: api } = useSession();
  const [state, setState] = useState<AgentsOverview>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!api) return;
    const [agents, summaries] = await Promise.allSettled([api.list(), api.summaries()]);
    if (agents.status === 'rejected') {
      setState({ kind: 'failed', ...describeAgentsError(agents.reason) });
      return;
    }
    setState({
      kind: 'loaded',
      agents: agents.value,
      summaries: new Map(
        summaries.status === 'fulfilled' ? summaries.value.map((s) => [s.agentId, s]) : [],
      ),
    });
  }, [api]);

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

  return { state, refreshing, refresh };
}
