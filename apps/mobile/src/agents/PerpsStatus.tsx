/**
 * The agent page's "Perps" line (SEN-187): whether the agent's own Perpl
 * account is open, opening, or waiting on something only the owner can give
 * it — AUSD, gas, or a mandate whose collateral cap can open an account.
 *
 * Sente opens the account; this only says where that stands. Reads
 * `GET /agents/:id/perpl` on focus and every 3 s while it is opening. A
 * `nudge` (the owner just funded the agent) asks `POST /agents/:id/perpl/onboard`
 * instead, which keeps looking for the funds to land. Renders nothing for an
 * agent without Perpl, a revoked one, or an API without the route.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Agent } from '@/agents/api';
import { perpsLine, perpsPollMs, type PerpsStatusDto } from '@/agents/perps';
import { useSession } from '@/session';
import { Pill } from '@/ui/goban';
import { Button } from '@/ui/kit';
import { color, RADIUS, text } from '@/ui/theme';

export function PerpsStatus({
  agent,
  nudge,
  onFund,
}: {
  agent: Agent;
  /** Bumped after a fund: ask the API to open the account once the funds land. */
  nudge: number;
  onFund: (token: 'AUSD' | 'MON') => void;
}) {
  const { agents: api } = useSession();
  const [status, setStatus] = useState<PerpsStatusDto | null>(null);
  const [focused, setFocused] = useState(0);
  const relevant = agent.status === 'active' && agent.mandate.venues.includes('perpl');
  const asked = useRef(0);

  useFocusEffect(useCallback(() => setFocused((n) => n + 1), []));

  useEffect(() => {
    if (!api || !relevant) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (kick: boolean) => {
      try {
        const next = kick ? await api.perplOnboard(agent.id) : await api.perplStatus(agent.id);
        if (stopped) return;
        setStatus(next);
        const again = perpsPollMs(next);
        if (again !== null) timer = setTimeout(() => void read(false), again);
      } catch {
        // A blip keeps the last line; the next focus or nudge asks again.
      }
    };
    const kick = nudge > asked.current;
    asked.current = nudge;
    void read(kick);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, agent.id, relevant, nudge, focused]);

  const line = relevant ? perpsLine(status) : null;
  if (!line) return null;
  return (
    <View style={styles.box} accessibilityLiveRegion="polite">
      <View style={styles.head}>
        <Pill label={line.title} tone={line.tone} />
        {line.fund ? (
          <Button
            label={`Fund ${line.fund}`}
            kind="soft"
            size="sm"
            icon="plus"
            onPress={() => onFund(line.fund!)}
          />
        ) : null}
      </View>
      <Text style={text.dim}>{line.detail}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    marginTop: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
    gap: 6,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
});
