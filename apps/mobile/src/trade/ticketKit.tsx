/**
 * The pieces both order tickets share (SEN-119 spot, SEN-120 perps): the
 * frame a stage sits in, the keypad and the web's hardware keys (SEN-167),
 * the hold-to-confirm, and the stones a running step list draws.
 */
import * as Haptics from '@/platform/haptics';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { txUrl } from '@/chain';
import type { Key, StepState } from '@/trade/ticket';
import { Stone } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import { IconButton, isHovered, TopBar } from '@/ui/kit';
import { color, font, GUTTER, RADIUS, text } from '@/ui/theme';

/** How long the confirm must be held. Long enough to be deliberate, short enough not to annoy. */
export const HOLD_MS = 1_200;
/** How long a typed key lights its keypad key: the web's stand-in for a haptic tick. */
export const KEY_FLASH_MS = 140;
/** Outcome colours: the final confirm, and the selected side. Long is a buy, short a sell. */
export const SIDE_TONE = { buy: color.mint, sell: color.berry } as const;

export function Frame({
  onClose,
  embedded = false,
  children,
}: {
  onClose: () => void;
  /** Beside a market's chart: there is no route to close, so no close button. */
  embedded?: boolean;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top, paddingBottom: insets.bottom + 40 },
      ]}
    >
      {embedded ? null : (
        <TopBar right={<IconButton icon="close" label="Close" onPress={onClose} />} />
      )}
      {children}
    </ScrollView>
  );
}

/**
 * A typed key goes through `press`, like a tapped one, and lights its keypad
 * key for {@link KEY_FLASH_MS}: the web's stand-in for a haptic tick.
 */
export function useLitKey(press: (key: Key) => void): {
  lit: Key | null;
  typeKey: (key: Key) => void;
} {
  const [lit, setLit] = useState<Key | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const typeKey = (key: Key) => {
    press(key);
    setLit(key);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLit(null), KEY_FLASH_MS);
  };
  return { lit, typeKey };
}

/**
 * Hardware keys on the web (SEN-167), while the screen holding the caller is
 * focused and `active`. `handle` sees keydown and keyup and returns whether it
 * took the key; a taken key goes no further. The capture phase is why: Enter
 * would otherwise also press whichever Pressable has focus. A key typed into a
 * text field, or with a modifier (a browser shortcut), is left alone. Native
 * has no hardware-key path here, so this is a no-op there.
 */
export function useWebKeys(active: boolean, handle: (event: KeyboardEvent) => boolean) {
  const handleRef = useRef(handle);
  handleRef.current = handle;
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web' || !active) return;
      const listener = (event: KeyboardEvent) => {
        if (event.metaKey || event.ctrlKey || event.altKey || inTextField(event.target)) return;
        if (handleRef.current(event)) {
          event.preventDefault();
          event.stopPropagation();
        }
      };
      window.addEventListener('keydown', listener, true);
      window.addEventListener('keyup', listener, true);
      return () => {
        window.removeEventListener('keydown', listener, true);
        window.removeEventListener('keyup', listener, true);
      };
    }, [active]),
  );
}

function inTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  );
}

const KEYS: readonly Key[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];

export function Keypad({
  onKey,
  lit,
  compact,
}: {
  onKey: (key: Key) => void;
  /** The key just typed on a keyboard, lit as if pressed. */
  lit: Key | null;
  /** Shorter keys, for a ticket that is also typed into (wide web). */
  compact: boolean;
}) {
  return (
    <View style={styles.keypad}>
      {KEYS.map((key) => (
        <Pressable
          key={key}
          accessibilityRole="button"
          accessibilityLabel={key === 'back' ? 'Delete' : key === '.' ? 'Decimal point' : key}
          onPress={() => onKey(key)}
          style={(state) => [
            styles.key,
            compact && styles.keyCompact,
            isHovered(state) && styles.keyHover,
            (state.pressed || key === lit) && styles.keyPressed,
          ]}
        >
          {key === 'back' ? (
            <Icon name="back" size={22} color={color.text} />
          ) : (
            <Text style={styles.keyText}>{key}</Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

export function Note({ icon, children }: { icon: 'stop' | 'shield'; children: ReactNode }) {
  return (
    <View style={styles.note}>
      <Icon name={icon} size={14} color={color.textDim} />
      <Text style={[text.dim, styles.grow]}>{children}</Text>
    </View>
  );
}

export function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/**
 * The final confirm: hold for {@link HOLD_MS}, in the side's colour (`tone`). Letting
 * go early drains it. Under reduced motion there is no fill to watch, so it is
 * a plain press — same colour, same label.
 */
export function HoldToConfirm({
  tone,
  keys,
  label,
  onConfirm,
}: {
  /** The side's colour: mint for a buy or a long, berry for a sell or a short. */
  tone: string;
  /** Holding Enter (or Space) holds the button, on the web. */
  keys: boolean;
  label: string;
  onConfirm: () => void;
}) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  const firedRef = useRef(false);

  const fire = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    onConfirm();
  }, [onConfirm]);

  const fill = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  const hold = () => {
    void Haptics.selectionAsync();
    progress.value = withTiming(1, { duration: HOLD_MS, easing: Easing.linear }, (finished) => {
      if (finished) scheduleOnRN(fire);
    });
  };
  const letGo = () => {
    if (firedRef.current) return;
    cancelAnimation(progress);
    progress.value = withTiming(0, { duration: 180 });
  };
  useWebKeys(keys, (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return false;
    if (event.repeat) return true;
    if (event.type === 'keydown') {
      if (reduced) fire();
      else hold();
    } else if (!reduced) letGo();
    return true;
  });

  if (reduced) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={fire}
        style={({ pressed }) => [styles.hold, { backgroundColor: tone }, pressed && styles.pressed]}
      >
        <Text style={styles.holdText}>
          {label.replace(/^Hold to (\w)/, (_, c: string) => c.toUpperCase())}
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Press and hold to confirm"
      onPressIn={hold}
      onPressOut={letGo}
      style={[styles.hold, { backgroundColor: `${tone}38` }]}
    >
      <Animated.View style={[styles.holdFill, { backgroundColor: tone }, fill]} />
      <Text style={styles.holdText}>{label}</Text>
    </Pressable>
  );
}

export function StepStone({ state }: { state: StepState }) {
  const reduced = useReducedMotion();
  const breath = useSharedValue(0);
  useEffect(() => {
    if (state !== 'now' || reduced) return;
    breath.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(breath);
  }, [state, reduced, breath]);
  const halo = useAnimatedStyle(() => ({ opacity: 0.25 + 0.5 * breath.value }));
  if (state === 'done') return <Stone kind="trade" size={18} />;
  if (state === 'failed') return <Stone kind="refusal" size={18} />;
  if (state === 'now') {
    return <Animated.View style={[styles.ring, { borderColor: color.purple }, halo]} />;
  }
  return <View style={[styles.ring, { borderColor: color.lineStrong }]} />;
}

/**
 * A transaction hash, shortened, that opens the block explorer when there is
 * one (`txUrl`); plain mono text otherwise. `suffix` follows it, unlinked.
 */
export function TxLink({ hash, suffix = '' }: { hash: string; suffix?: string }) {
  const url = txUrl(hash);
  const short = `${hash.slice(0, 6)}…${hash.slice(-4)}`;
  if (url === null) {
    return (
      <Text style={text.mono} numberOfLines={1}>
        {short}
        {suffix}
      </Text>
    );
  }
  return (
    <Text style={text.mono} numberOfLines={1}>
      <Text
        style={styles.txLink}
        accessibilityRole="link"
        accessibilityLabel={`Transaction ${short} in the explorer`}
        onPress={() => void Linking.openURL(url)}
      >
        {short} ↗
      </Text>
      {suffix}
    </Text>
  );
}

const styles = StyleSheet.create({
  txLink: { color: color.purpleHi, textDecorationLine: 'underline' },
  root: { flex: 1, backgroundColor: color.ink },
  content: { paddingHorizontal: GUTTER },
  grow: { flex: 1 },
  pressed: { opacity: 0.7 },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', marginVertical: 12 },
  key: {
    width: '33.33%',
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.well,
  },
  keyCompact: { height: 44 },
  keyHover: { backgroundColor: color.board },
  keyPressed: { backgroundColor: color.well },
  keyText: {
    fontFamily: font.medium,
    fontSize: 24,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  hold: {
    minHeight: 54,
    borderRadius: RADIUS.stone,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  holdFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  holdText: { fontFamily: font.semibold, fontSize: 15, color: color.ink },
  ring: { width: 18, height: 18, borderRadius: 9, borderWidth: 2.5, marginTop: 2 },
});
