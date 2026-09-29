/**
 * Alerts (SEN-156): what your agents did while you weren't looking.
 *
 * Spec: docs/design/trading/cockpit.html, "Alerts". Each alert leads with its
 * Ledger stone and reads like its Ledger row, so the feed and the spine say the
 * same thing; Held is lilac, never red, because the boundary working is not an
 * error. Tapping a fill opens that agent's live position, anything else its
 * Ledger.
 *
 * Unread dots are drawn against the marks as they stood when the screen was
 * opened, so what was new stays marked for this whole visit even though the
 * store is moved up as soon as the page arrives (the bell on Home then reads
 * zero on the way back). What arrives by poll while you are here is marked
 * seen too — it was on screen.
 *
 * Left out of the study's screen: "your agents are on both sides of MON" and
 * the revoked agent's inline return need positions and balances across
 * agents, which `/agents/activity` does not carry. Every choice is
 * `agents/alerts.ts`, under test; this file only lays out.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  alertFilters,
  filterKey,
  groupAlerts,
  inAlertFilter,
  isUnread,
  type Alert,
  type AlertFilter,
  type Seen,
} from '@/agents/alerts';
import { entryTime } from '@/agents/ledgerView';
import { readSeen, useAlerts } from '@/agents/useAlerts';
import { Pill, Stone } from '@/ui/goban';
import { Chip, Chips, Loading, Notice, Screen, TopBar } from '@/ui/kit';
import { color, font, text } from '@/ui/theme';

export default function Alerts() {
  const router = useRouter();
  const feed = useAlerts();
  const [filter, setFilter] = useState<AlertFilter>('all');
  /** The marks as this visit found them; `undefined` until read. */
  const [opened, setOpened] = useState<Seen | null | undefined>(undefined);

  useFocusEffect(
    useCallback(() => {
      void readSeen().then(setOpened);
    }, []),
  );

  const { alerts, markSeen } = feed;
  const loaded = feed.polled.data !== null;
  // Only once the visit's snapshot is taken, or the dots would be drawn
  // against marks that already include what they are meant to flag.
  useEffect(() => {
    if (loaded && opened !== undefined && alerts.length > 0) void markSeen(alerts);
  }, [loaded, opened, alerts, markSeen]);

  const chips = useMemo(() => alertFilters(alerts), [alerts]);
  const shown = alerts.filter((alert) => inAlertFilter(alert, filter));
  const now = Date.now();
  const groups = groupAlerts(shown, now);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const open = (alert: Alert) => {
    if (alert.target.kind === 'position') {
      router.push({
        pathname: '/agents/[id]/position/[symbol]',
        params: {
          id: alert.agentId,
          symbol: alert.target.symbol,
          ...(alert.target.venue !== null ? { venue: alert.target.venue } : {}),
        },
      });
    } else {
      router.push({ pathname: '/agents/[id]/ledger', params: { id: alert.agentId } });
    }
  };

  return (
    <Screen
      refreshing={false}
      onRefresh={() => {
        feed.polled.refresh();
      }}
    >
      <TopBar back={{ label: 'Home', onPress: back }} />
      <Text style={text.display}>Alerts</Text>

      {feed.polled.error !== null && loaded ? (
        <Text style={[text.caption, styles.under]}>Not updating — {feed.polled.error.message}</Text>
      ) : null}

      {!loaded && feed.polled.error === null ? (
        <Loading />
      ) : !loaded ? (
        <Notice
          tone="error"
          title="Could not read your agents’ activity"
          detail={feed.polled.error?.message ?? 'Pull to try again.'}
        />
      ) : alerts.length === 0 ? (
        <Text style={[text.dim, styles.nothing]}>
          Nothing yet. When one of your agents trades, is held to its mandate or is funded, it shows
          up here.
        </Text>
      ) : (
        <>
          <Chips>
            {chips.map((chip) => (
              <Chip
                key={chip.key}
                label={chip.label}
                selected={filterKey(filter) === chip.key}
                onPress={() => setFilter(chip.filter)}
              />
            ))}
          </Chips>
          {groups.length === 0 ? (
            <Text style={[text.dim, styles.nothing]}>Nothing of this kind yet.</Text>
          ) : (
            groups.map((group) => (
              <View key={group.label} style={styles.group}>
                <Text style={text.label}>{group.label}</Text>
                {group.alerts.map((alert, i) => (
                  <AlertRow
                    key={alert.key}
                    alert={alert}
                    unread={isUnread(alert, opened ?? null)}
                    time={entryTime(alert.at, now)}
                    last={i === group.alerts.length - 1}
                    onPress={() => open(alert)}
                  />
                ))}
              </View>
            ))
          )}
        </>
      )}
    </Screen>
  );
}

/** The study's `.alert`: stone, sentence (name in bold), a line under it, the time. */
function AlertRow({
  alert,
  unread,
  time,
  last,
  onPress,
}: {
  alert: Alert;
  unread: boolean;
  time: string;
  last: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={
        alert.target.kind === 'position' ? 'Opens the position' : 'Opens the agent’s ledger'
      }
      onPress={onPress}
      style={({ pressed }) => [styles.row, !last && styles.divider, pressed && styles.pressed]}
    >
      {/* The dot is an event, so it is purple (the study's `.alert--unread`). */}
      {unread ? <View style={styles.dot} accessibilityLabel="Unread" /> : null}
      <View style={styles.stone}>
        <Stone kind={alert.stone} size={12} />
      </View>
      <View style={styles.body}>
        <Text style={styles.sentence}>
          <Text style={styles.name}>{alert.agentName}</Text>
          {alert.lead}
          {alert.figure !== null ? (
            <Text
              style={[
                text.num,
                alert.figure.tone === 'up' && text.up,
                alert.figure.tone === 'down' && text.down,
              ]}
            >
              {` ${alert.figure.text}`}
            </Text>
          ) : null}
        </Text>
        {alert.detail !== null ? (
          <Text style={text.caption} numberOfLines={2}>
            {alert.detail}
          </Text>
        ) : null}
        {alert.held !== null ? (
          <View style={styles.pill}>
            <Pill tone="held" label={alert.held} />
          </View>
        ) : null}
      </View>
      <Text style={styles.time}>{time}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  under: { marginTop: 6 },
  nothing: { marginTop: 18 },
  group: { marginTop: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
  },
  divider: { borderBottomWidth: 1, borderBottomColor: color.line },
  pressed: { opacity: 0.7 },
  dot: {
    position: 'absolute',
    left: -12,
    top: 20,
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: color.purple,
  },
  stone: { marginTop: 4 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  sentence: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: color.text },
  name: { fontFamily: font.semibold },
  pill: { flexDirection: 'row', marginTop: 4 },
  time: { fontFamily: font.chain, fontSize: 11, lineHeight: 20, color: color.textFaint },
});
