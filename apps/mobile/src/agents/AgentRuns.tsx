/**
 * Where the agent terminal sits on the agent page (SEN-178):
 *
 * - `LiveRunSection` (Overview): the terminal, open, while a run is going —
 *   and it stays up once that run ends, so a run you watched does not vanish
 *   under you. With nothing running, one line about the last run and a link
 *   to open it.
 * - `RunHistorySection` (History): the last runs the server keeps (ten), each
 *   opening its own terminal in place.
 *
 * Both show `useAgentRuns`, which reads `GET /agents/:id/runs` while the
 * screen is focused: every 1.5 s while a run is live, every 6 s otherwise, so a
 * scheduled run shows up on its own. An API without the route renders nothing
 * at all. The page calls the hook once and hands the list to both, and to its
 * header (SEN-177: "Running…" and the Run now button).
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AgentTerminal } from '@/agents/AgentTerminal';
import { describeRun, runsPollDelay, type RunSummary } from '@/agents/terminal';
import { useSession } from '@/session';
import { Pill } from '@/ui/goban';
import { Section, SectionLink } from '@/ui/kit';
import { color, text } from '@/ui/theme';

/**
 * The agent's runs, newest first; `null` until read, or when the route is
 * missing. Changing `nudge` reads again at once (a Run now that just started).
 */
export function useAgentRuns(agentId: string, nudge = 0): RunSummary[] | null {
  const { agents: api } = useSession();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!api) return;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let failures = 0;
      let latest: RunSummary[] | null = null;

      const tick = async () => {
        try {
          latest = await api.runs(agentId);
          failures = 0;
          if (stopped) return;
          setRuns(latest);
          // An API without the route: nothing to poll.
          if (latest === null) return;
        } catch {
          if (stopped) return;
          failures += 1;
        }
        if (!stopped) timer = setTimeout(() => void tick(), runsPollDelay(latest, failures));
      };
      void tick();
      return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [api, agentId, nudge]),
  );

  return runs;
}

export function LiveRunSection({ agentId, runs }: { agentId: string; runs: RunSummary[] | null }) {
  const latest = runs?.[0];
  /** The run whose terminal is up: one that went live here, or the last one, opened. */
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (latest?.status === 'running') setShown(latest.runId);
  }, [latest?.runId, latest?.status]);

  if (!latest) return null;
  const now = Date.now();

  if (shown !== null) {
    const live = runs?.find((r) => r.runId === shown)?.status === 'running';
    return (
      <Section
        label={live ? 'Live run' : 'Last run'}
        aside={live ? undefined : <SectionLink label="Hide" onPress={() => setShown(null)} />}
      >
        <AgentTerminal agentId={agentId} runId={shown} />
      </Section>
    );
  }

  const row = describeRun(latest, now);
  return (
    <Section
      label="Last run"
      aside={<SectionLink label="Open last run" onPress={() => setShown(latest.runId)} />}
    >
      <Text style={text.dim} numberOfLines={1}>
        {row.title}
      </Text>
      <Text style={text.caption} numberOfLines={1}>
        {row.caption}
      </Text>
    </Section>
  );
}

export function RunHistorySection({
  agentId,
  runs,
}: {
  agentId: string;
  runs: RunSummary[] | null;
}) {
  const [open, setOpen] = useState<string | null>(null);

  if (!runs || runs.length === 0) return null;
  const now = Date.now();

  return (
    <Section label="Runs" aside={<Text style={text.caption}>last {runs.length} kept</Text>}>
      {runs.map((run) => {
        const row = describeRun(run, now);
        const expanded = open === run.runId;
        return (
          <View key={run.runId} style={styles.item}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityLabel={`${row.title}. ${row.caption}. ${expanded ? 'Close' : 'Open'} its terminal`}
              onPress={() => setOpen(expanded ? null : run.runId)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <View style={styles.rowText}>
                <Text style={text.strong} numberOfLines={1}>
                  {row.title}
                </Text>
                <Text style={[text.caption, text.num]} numberOfLines={1}>
                  {row.caption}
                </Text>
              </View>
              {row.live ? <Pill label="Live" tone="live" /> : null}
              <Text style={[text.caption, styles.toggle]}>{expanded ? 'Close' : 'Open'}</Text>
            </Pressable>
            {expanded ? <AgentTerminal agentId={agentId} runId={run.runId} /> : null}
          </View>
        );
      })}
    </Section>
  );
}

const styles = StyleSheet.create({
  item: { gap: 8, paddingVertical: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  rowText: { flex: 1, minWidth: 0 },
  toggle: { color: color.purpleHi },
  pressed: { opacity: 0.7 },
});
