/**
 * The Agents tab's archived drawer (SEN-197): "Archived (N)" under the
 * roster, folded until asked. Each row opens the agent (its page and history
 * still work) or brings it back with Unarchive. Hidden while there are none.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { describeAgentsError, type Agent } from '@/agents/api';
import { useSession } from '@/session';
import { isoDate } from '@/ui/format';
import { Sigil } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import { Button, Notice } from '@/ui/kit';
import { color, font, text } from '@/ui/theme';

export function ArchivedAgents({
  reloadKey,
  onOpen,
  onRestored,
}: {
  /** Anything that changes when the roster reloads, so this reloads with it. */
  reloadKey: unknown;
  onOpen: (agent: Agent) => void;
  /** An agent came back: the roster above should show it. */
  onRestored: () => void;
}) {
  const { agents: api } = useSession();
  const [archived, setArchived] = useState<Agent[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      // `archivedAt` checked too: an API that predates archiving ignores the
      // query and answers the whole roster.
      setArchived((await api.list({ archived: true })).filter((agent) => agent.archivedAt));
    } catch {
      // An API without archiving answers the whole roster or fails; show nothing.
      setArchived([]);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  if (archived.length === 0) return null;

  const unarchive = async (agent: Agent) => {
    if (!api) return;
    setBusyId(agent.id);
    setError(null);
    try {
      await api.unarchive(agent.id);
      await load();
      onRestored();
    } catch (caught) {
      setError(describeAgentsError(caught));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
      >
        <Text style={text.label}>Archived ({archived.length})</Text>
        <View style={expanded ? styles.chevronOpen : styles.chevron}>
          <Icon name="chevron" size={14} color={color.textDim} />
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.rows}>
          {error ? <Notice tone="error" title={error.title} detail={error.detail} /> : null}
          {archived.map((agent) => (
            <View key={agent.id} style={styles.row}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${agent.name}, archived`}
                onPress={() => onOpen(agent)}
                style={({ pressed }) => [styles.who, pressed && styles.pressed]}
              >
                <Sigil seed={agent.id} dimmed />
                <View style={styles.grow}>
                  <Text style={styles.name} numberOfLines={1}>
                    {agent.name}
                  </Text>
                  <Text style={text.caption} numberOfLines={1}>
                    Archived{agent.archivedAt ? ` ${isoDate(agent.archivedAt)}` : ''}
                  </Text>
                </View>
              </Pressable>
              <Button
                label="Unarchive"
                size="sm"
                kind="soft"
                busy={busyId === agent.id}
                onPress={() => void unarchive(agent)}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 22 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: color.line,
  },
  chevron: { transform: [{ rotate: '90deg' }] },
  chevronOpen: { transform: [{ rotate: '-90deg' }] },
  rows: { gap: 10, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, gap: 2 },
  name: { fontFamily: font.displaySemibold, fontSize: 15, color: color.textDim },
  pressed: { opacity: 0.85 },
});
