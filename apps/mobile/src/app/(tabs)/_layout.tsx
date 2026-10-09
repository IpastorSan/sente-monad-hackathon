/**
 * The shell (SEN-55, a floating dock since SEN-109): Home, Markets, Agents and
 * Portfolio in a pill that hovers over the screen, and beside it a round Trade
 * button that opens `/trade` as a modal — trading is an action from anywhere,
 * not a place. Account and the Board are stack screens above the tabs now:
 * Account sits behind the avatar (reached from Agents until Home grows one),
 * and the Board waits to be folded into Agents → Top. Agent detail, the Ledger
 * and the hire flow cover the dock rather than sitting inside it.
 *
 * The dock is drawn over the tab screens, so `Screen tabbed` pads its scroll by
 * `DOCK` to let the last row clear it.
 *
 * Everything under a tab needs a signed-in session, so the gate lives here:
 * signed out goes to `/welcome`, and the first frame — while the stored
 * credential hint is still being read — is the bare ground rather than a flash
 * of the welcome screen for someone who is about to be signed in.
 *
 * Headless `expo-router/ui` tabs rather than `Tabs` from expo-router, which
 * would pull in `@react-navigation/bottom-tabs`: this bar is ours to draw, and
 * the app gains no dependency for it. `TabList` must stay a direct child of
 * `Tabs` — the router only finds triggers there — so the pill is the TabList
 * itself and the Trade button is its absolutely placed sibling.
 *
 * On a wide web window (`useWide`, SEN-166) the same TabList is restyled as a
 * left rail — the mark, the four tabs, a full-width Trade stone, and Account at
 * the foot, under the user's face and name (SEN-172) — and the screen beside it reads in a centred column (`Screen`).
 * The rail's extras sit inside the TabList: the router ignores children of a
 * TabList that are not triggers, and renders them. The narrow tree is the dock
 * exactly as it was.
 */
import { Redirect, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { TabList, Tabs, TabSlot, TabTrigger, type TabTriggerSlotProps } from 'expo-router/ui';
import { forwardRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '@/session';
import { Avatar } from '@/ui/Avatar';
import { Icon, type IconName } from '@/ui/icons';
import { Mark } from '@/ui/goban';
import { DOCK, isHovered, RAIL, useWide } from '@/ui/kit';
import { color, font, RADIUS } from '@/ui/theme';

/** Distance from the screen edges, and between the pill and the button. */
const EDGE = 14;
const GAP = 10;
const FAB = 58;

export default function TabsLayout() {
  const router = useRouter();
  const { auth, profile } = useSession();
  const insets = useSafeAreaInsets();
  const wide = useWide();

  if (auth.status === 'restoring') return <View style={styles.ground} />;
  if (auth.status !== 'ready') return <Redirect href="/welcome" />;

  if (wide) {
    // `row-reverse` puts the TabList (second child) on the left without
    // reordering the children the router parses.
    return (
      <Tabs style={[styles.ground, styles.desktop]}>
        <TabSlot />
        <TabList style={styles.rail}>
          <View style={styles.brand}>
            <Mark size={30} />
            <Text style={styles.wordmark}>Sente</Text>
          </View>
          <TabTrigger name="index" href="/" asChild>
            <RailButton icon="home" label="Home" />
          </TabTrigger>
          <TabTrigger name="markets" href="/markets" asChild>
            <RailButton icon="markets" label="Markets" />
          </TabTrigger>
          <TabTrigger name="agents" href="/agents" asChild>
            <RailButton icon="agents" label="Agents" />
          </TabTrigger>
          <TabTrigger name="portfolio" href="/portfolio" asChild>
            <RailButton icon="portfolio" label="Portfolio" />
          </TabTrigger>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Trade"
            onPress={() => router.push('/trade')}
            style={(state) => [
              styles.railTrade,
              isHovered(state) && styles.railTradeHover,
              state.pressed && styles.pressed,
            ]}
          >
            <Icon name="trade" size={20} color={color.text} strokeWidth={2} />
            <Text style={styles.railTradeLabel}>Trade</Text>
          </Pressable>
          <View style={styles.grow} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Account"
            onPress={() => router.push('/account')}
            style={(state) => [
              styles.railItem,
              isHovered(state) && styles.railItemHover,
              state.pressed && styles.pressed,
            ]}
          >
            {profile.identity !== null ? (
              <Avatar seed={profile.identity.avatarSeed} size={32} />
            ) : (
              <View style={styles.avatar} />
            )}
            <View style={styles.railWho}>
              <Text style={styles.railLabel} numberOfLines={1}>
                {profile.identity?.name ?? 'Account'}
              </Text>
              <Text style={styles.railCaption}>Account · testnet</Text>
            </View>
          </Pressable>
        </TabList>
      </Tabs>
    );
  }

  const bottom = insets.bottom + DOCK.lift;

  return (
    <Tabs style={styles.ground}>
      <TabSlot />
      <TabList style={[styles.pill, { bottom }]}>
        <TabTrigger name="index" href="/" asChild>
          <TabButton icon="home" label="Home" />
        </TabTrigger>
        <TabTrigger name="markets" href="/markets" asChild>
          <TabButton icon="markets" label="Markets" />
        </TabTrigger>
        <TabTrigger name="agents" href="/agents" asChild>
          <TabButton icon="agents" label="Agents" />
        </TabTrigger>
        <TabTrigger name="portfolio" href="/portfolio" asChild>
          <TabButton icon="portfolio" label="Portfolio" />
        </TabTrigger>
      </TabList>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Trade"
        onPress={() => router.push('/trade')}
        style={({ pressed }) => [
          styles.fab,
          { bottom: bottom + (DOCK.height - FAB) / 2 },
          pressed && styles.pressed,
        ]}
      >
        <Icon name="trade" size={24} color={color.text} strokeWidth={2} />
      </Pressable>
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
      style={[styles.tab, isFocused && styles.tabOn]}
    >
      {isFocused ? <PageTitle label={label} /> : null}
      <Icon name={icon} size={22} color={isFocused ? color.purpleHi : color.textFaint} />
      <Text style={[styles.tabLabel, isFocused && styles.tabLabelOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
});

/** The browser tab's title on web; `Head` renders nothing on Android. */
function PageTitle({ label }: { label: string }) {
  return (
    <Head>
      <title>{`${label} · Sente`}</title>
    </Head>
  );
}

/** A tab on the wide rail: icon and label in a row, the page title when focused. */
const RailButton = forwardRef<View, TabButtonProps>(function RailButton(
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
      style={(state) => [
        styles.railItem,
        isFocused ? styles.railItemOn : isHovered(state) && styles.railItemHover,
      ]}
    >
      {isFocused ? <PageTitle label={label} /> : null}
      <Icon name={icon} size={20} color={isFocused ? color.purpleHi : color.textFaint} />
      <Text style={[styles.railLabel, !isFocused && styles.railLabelOff]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: color.ink },
  desktop: { flexDirection: 'row-reverse' },
  // The rail is the ground, not a board: a hairline is all that separates it.
  rail: {
    width: RAIL,
    flexDirection: 'column',
    justifyContent: 'flex-start',
    gap: 4,
    paddingHorizontal: 14,
    paddingTop: 22,
    paddingBottom: 18,
    borderRightWidth: 1,
    borderRightColor: color.line,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 8,
    marginBottom: 26,
  },
  wordmark: {
    fontFamily: font.display,
    fontSize: 22,
    letterSpacing: -0.5,
    color: color.text,
  },
  railItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: RADIUS.stone,
  },
  railItemOn: { backgroundColor: 'rgba(131, 110, 249, 0.18)' },
  railItemHover: { backgroundColor: color.well },
  railLabel: { fontFamily: font.medium, fontSize: 14, color: color.text },
  railLabelOff: { color: color.textDim },
  railCaption: { fontFamily: font.regular, fontSize: 12, color: color.textFaint },
  railWho: { flex: 1, minWidth: 0 },
  railTrade: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 48,
    marginTop: 18,
    borderRadius: RADIUS.stone,
    backgroundColor: color.purple,
    borderWidth: 1,
    borderColor: color.purple,
    boxShadow: '0 12px 30px -10px rgba(131, 110, 249, 0.55)',
  },
  railTradeHover: { borderColor: color.purpleHi },
  railTradeLabel: { fontFamily: font.semibold, fontSize: 15, color: color.text },
  grow: { flex: 1 },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#ECE8FB',
    borderWidth: 1,
    borderColor: '#FFFFFF',
  },
  // `.dock__tabs` in docs/design/trading/trading.css. No backdrop blur: that
  // would need a native module, and the tinted well reads the same over ink.
  pill: {
    position: 'absolute',
    left: EDGE,
    right: EDGE + FAB + GAP,
    height: DOCK.height,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.lineStrong,
    backgroundColor: 'rgba(29, 24, 56, 0.94)',
    boxShadow: '0 16px 40px -16px rgba(0, 0, 0, 0.8)',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
    paddingVertical: 4,
    paddingHorizontal: 2,
    borderRadius: 999,
  },
  tabOn: { backgroundColor: 'rgba(131, 110, 249, 0.18)' },
  tabLabel: { fontFamily: font.medium, fontSize: 10, color: color.textFaint },
  tabLabelOn: { color: color.text },
  // `.dock__fab`: the one purple thing on the dock, because pressing it trades.
  fab: {
    position: 'absolute',
    right: EDGE,
    width: FAB,
    height: FAB,
    borderRadius: FAB / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.purple,
    borderWidth: 1,
    borderColor: color.purpleHi,
    boxShadow: '0 12px 30px -8px rgba(131, 110, 249, 0.55)',
  },
  pressed: { opacity: 0.85 },
});
