/**
 * The four tabs (SEN-55): Home, Agents, Board, Account. Agent detail, the
 * Ledger and the hire flow are stack screens above them, so they cover the tab
 * bar rather than sitting inside it.
 *
 * Everything under a tab needs a signed-in session, so the gate lives here:
 * signed out goes to `/welcome`, and the first frame — while the stored
 * credential hint is still being read — is the bare ground rather than a flash
 * of the welcome screen for someone who is about to be signed in.
 *
 * Headless `expo-router/ui` tabs rather than `Tabs` from expo-router, which
 * would pull in `@react-navigation/bottom-tabs`: this bar is ours to draw, and
 * the app gains no dependency for it.
 */
import { Redirect } from 'expo-router';
import { TabList, Tabs, TabSlot, TabTrigger, type TabTriggerSlotProps } from 'expo-router/ui';
import { forwardRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '@/session';
import { Icon, type IconName } from '@/ui/icons';
import { color, font } from '@/ui/theme';

export default function TabsLayout() {
  const { auth } = useSession();
  const insets = useSafeAreaInsets();

  if (auth.status === 'restoring') return <View style={styles.ground} />;
  if (auth.status !== 'ready') return <Redirect href="/welcome" />;

  return (
    <Tabs style={styles.ground}>
      <TabSlot />
      <TabList style={[styles.bar, { paddingBottom: insets.bottom + 8 }]}>
        <TabTrigger name="index" href="/" asChild>
          <TabButton icon="home" label="Home" />
        </TabTrigger>
        <TabTrigger name="agents" href="/agents" asChild>
          <TabButton icon="agents" label="Agents" />
        </TabTrigger>
        <TabTrigger name="leaderboard" href="/leaderboard" asChild>
          <TabButton icon="board" label="Board" />
        </TabTrigger>
        <TabTrigger name="account" href="/account" asChild>
          <TabButton icon="account" label="Account" />
        </TabTrigger>
      </TabList>
    </Tabs>
  );
}

type TabButtonProps = TabTriggerSlotProps & { icon: IconName; label: string };

const TabButton = forwardRef<View, TabButtonProps>(function TabButton(
  { icon, label, isFocused, ...props },
  ref,
) {
  return (
    <Pressable
      ref={ref}
      {...props}
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused }}
      accessibilityLabel={label}
      style={styles.tab}
    >
      <Icon name={icon} size={22} color={isFocused ? color.purpleHi : color.textFaint} />
      <Text style={[styles.tabLabel, isFocused && styles.tabLabelOn]}>{label}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: color.ink },
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 10,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: color.line,
    backgroundColor: color.ink,
  },
  tab: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 2 },
  tabLabel: { fontFamily: font.medium, fontSize: 10, color: color.textFaint },
  tabLabelOn: { color: color.text },
});
