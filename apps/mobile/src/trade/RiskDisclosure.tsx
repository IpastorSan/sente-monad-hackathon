/**
 * The first-trade risk disclosure on a review step (SEN-179): what can go
 * wrong, once per wallet and venue, with a box to tick before the confirm
 * appears. Ticked and confirmed, it is remembered in `platform/kv` and never
 * shown again for that wallet and venue. The claims live in `risk.ts`.
 */
import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import * as kv from '@/platform/kv';
import { useSession } from '@/session';
import { Icon } from '@/ui/icons';
import { isHovered } from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';

import { HOW_TRADING_WORKS, riskAckKey, riskPoints, riskTitle, type RiskVenue } from './risk';

export type RiskAck = {
  /** The disclosure is to be shown: this wallet hasn't acknowledged this venue. */
  readonly needed: boolean;
  readonly ticked: boolean;
  /** The confirm may show: acknowledged before, or ticked now. */
  readonly ready: boolean;
  readonly toggle: () => void;
  /** Remembers the acknowledgement; call when the order is confirmed. */
  readonly remember: () => void;
};

export function useRiskAck(venue: RiskVenue): RiskAck {
  const wallet = useSession().wallet.wallet?.address ?? null;
  // `null` while reading: neither shown nor ready, so a confirm never flashes past it.
  const [acked, setAcked] = useState<boolean | null>(null);
  const [ticked, setTicked] = useState(false);

  useEffect(() => {
    if (wallet === null) return;
    let live = true;
    kv.getItemAsync(riskAckKey(venue, wallet)).then(
      (value) => live && setAcked(value !== null),
      // An unreadable store asks again rather than skipping the disclosure.
      () => live && setAcked(false),
    );
    return () => {
      live = false;
    };
  }, [venue, wallet]);

  const remember = useCallback(() => {
    if (wallet === null || acked !== false) return;
    void kv.setItemAsync(riskAckKey(venue, wallet), String(Date.now())).catch(() => undefined);
  }, [venue, wallet, acked]);

  return {
    needed: acked === false,
    ticked,
    ready: acked === true || (acked === false && ticked),
    toggle: () => setTicked((on) => !on),
    remember,
  };
}

export function RiskDisclosure({ venue, ack }: { venue: RiskVenue; ack: RiskAck }) {
  const router = useRouter();
  if (!ack.needed) return null;
  const open = (href: string) => router.push(href as Href);
  return (
    <View style={styles.card}>
      <Text style={text.strong}>{riskTitle(venue)}</Text>
      {riskPoints(venue, Platform.OS === 'web').map((point) => (
        <View key={point.key} style={styles.point}>
          <View style={styles.dot} />
          <Text style={[text.dim, styles.grow]}>
            {point.text}
            {point.link ? (
              <>
                {' '}
                <Text
                  style={styles.link}
                  accessibilityRole="link"
                  onPress={() => open(point.link!.href)}
                >
                  {point.link.label}
                </Text>
              </>
            ) : null}
          </Text>
        </View>
      ))}
      <Text
        style={[styles.link, styles.more]}
        accessibilityRole="link"
        onPress={() => open(HOW_TRADING_WORKS)}
      >
        How trading works
      </Text>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: ack.ticked }}
        aria-checked={ack.ticked}
        accessibilityLabel="I understand these risks"
        onPress={ack.toggle}
        style={(state) => [styles.check, isHovered(state) && styles.checkHover]}
      >
        <View style={[styles.box, ack.ticked && styles.boxOn]}>
          {ack.ticked ? <Icon name="check" size={14} color={color.ink} strokeWidth={2.6} /> : null}
        </View>
        <Text style={styles.checkText}>I understand these risks</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 18,
    padding: 14,
    gap: 8,
    borderRadius: RADIUS.well,
    borderWidth: 1,
    borderColor: color.lineStrong,
    backgroundColor: color.board,
  },
  point: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 8, backgroundColor: color.textFaint },
  grow: { flex: 1 },
  link: { color: color.purpleHi, textDecorationLine: 'underline' },
  more: { fontFamily: font.medium, fontSize: 13, marginTop: 2 },
  check: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
    paddingVertical: 8,
    paddingHorizontal: 8,
    marginHorizontal: -8,
    borderRadius: RADIUS.stone,
  },
  checkHover: { backgroundColor: color.well },
  box: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: color.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: color.purpleSoft, borderColor: color.purpleSoft },
  checkText: { fontFamily: font.medium, fontSize: 14, color: color.text },
});
