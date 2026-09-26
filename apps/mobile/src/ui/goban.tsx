/**
 * The pieces that make Sente look like Sente (SEN-55): stones, agent sigils,
 * the mark, status pills and mandate gauges. The plain primitives — buttons,
 * fields, sheets — are in `kit.tsx`; these are the ones with a meaning.
 *
 * Reference: `docs/design/design-system.html` ("Stones", "Components").
 */
import { Canvas, Circle, Group, Line, vec } from '@shopify/react-native-skia';
import { useEffect, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated';

import { Icon } from './icons';
import { SIGIL_LINES, sigilStones } from './sigil';
import { color, font, RADIUS, text } from './theme';

// ─── Stones ─────────────────────────────────────────────────────────────────

/**
 * One stone per ledger entry kind, and the shape is the meaning:
 *
 * - `deposit` white stone — capital entering; the only entry the agent didn't make
 * - `thesis`  hollow purple ring — intent, written before the move
 * - `trade`   solid purple stone — a move on the board
 * - `refusal` ring behind a bar — the enclave's boundary held (never berry)
 * - `win` / `loss` half stone in mint / berry — what the move was worth
 */
export type StoneKind = 'deposit' | 'thesis' | 'trade' | 'refusal' | 'win' | 'loss';

export function Stone({ kind, size = 14 }: { kind: StoneKind; size?: number }) {
  const ring = Math.max(2, Math.round(size / 7));
  const base = { width: size, height: size, borderRadius: size / 2 };
  switch (kind) {
    case 'deposit':
      return <View style={[base, styles.deposit]} />;
    case 'thesis':
      return <View style={[base, { borderWidth: ring, borderColor: color.purple }]} />;
    case 'trade':
      return <View style={[base, styles.trade]} />;
    case 'refusal':
      return (
        <View style={[base, styles.center, { borderWidth: ring, borderColor: color.purpleSoft }]}>
          <View
            style={{
              position: 'absolute',
              width: size + ring * 2,
              height: ring,
              borderRadius: ring,
              backgroundColor: color.purpleSoft,
              transform: [{ rotate: '-45deg' }],
            }}
          />
        </View>
      );
    case 'win':
    case 'loss': {
      const tone = kind === 'win' ? color.mint : color.berry;
      return (
        <View style={[base, { borderWidth: ring, borderColor: tone, overflow: 'hidden' }]}>
          <View style={{ width: '50%', height: '100%', backgroundColor: tone }} />
        </View>
      );
    }
  }
}

// ─── Sigil ──────────────────────────────────────────────────────────────────

/** An agent's face: a 4×4 goban corner with its own stones, seeded from its id. */
export function Sigil({
  seed,
  size = 40,
  dimmed = false,
}: {
  seed: string;
  size?: number;
  dimmed?: boolean;
}) {
  const board = size * 0.75;
  const edge = board * 0.12;
  const step = (board - edge * 2) / (SIGIL_LINES - 1);
  const at = (i: number) => edge + i * step;
  const lines = Array.from({ length: SIGIL_LINES }, (_, i) => at(i));
  return (
    <View
      style={[
        styles.sigil,
        { width: size, height: size, borderRadius: size * 0.3 },
        dimmed && styles.dimmed,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Canvas style={{ width: board, height: board }}>
        <Group color={color.lineStrong} style="stroke" strokeWidth={Math.max(1, board / 34)}>
          {lines.map((p) => (
            <Group key={p}>
              <Line p1={vec(edge, p)} p2={vec(board - edge, p)} />
              <Line p1={vec(p, edge)} p2={vec(p, board - edge)} />
            </Group>
          ))}
        </Group>
        {sigilStones(seed).map((stone) => (
          <Circle
            key={`${stone.x},${stone.y}`}
            cx={at(stone.x)}
            cy={at(stone.y)}
            r={step * 0.44}
            color={stone.tone === 'purple' ? color.purple : color.text}
          />
        ))}
      </Canvas>
    </View>
  );
}

// ─── Mark ───────────────────────────────────────────────────────────────────

/** 先 (sen, "ahead") on a Monad-purple stone. */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <View
      style={[styles.mark, { width: size, height: size, borderRadius: size / 2 }]}
      accessibilityLabel="Sente"
    >
      <Text style={[styles.markGlyph, { fontSize: size * 0.53, lineHeight: size * 0.7 }]}>先</Text>
    </View>
  );
}

// ─── Pill ───────────────────────────────────────────────────────────────────

/**
 * A status. `live` breathes — the only idle animation in the app, and it means
 * "this agent is running right now". `held` is an enclave refusal: lilac, not
 * red, because the product working is not an error.
 */
export type PillTone = 'live' | 'idle' | 'held' | 'revoked';

export function Pill({ label, tone = 'idle' }: { label: string; tone?: PillTone }) {
  const ink = PILL_INK[tone];
  return (
    <View style={[styles.pill, { backgroundColor: PILL_GROUND[tone] }]}>
      {tone === 'live' ? (
        <BreathingDot color={ink} />
      ) : (
        <View
          style={[
            styles.dot,
            tone === 'held' ? { borderWidth: 1.5, borderColor: ink } : { backgroundColor: ink },
          ]}
        />
      )}
      <Text style={[styles.pillText, { color: ink }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const PILL_INK: Record<PillTone, string> = {
  live: color.purpleHi,
  idle: color.textDim,
  held: color.purpleSoft,
  revoked: color.berry,
};

const PILL_GROUND: Record<PillTone, string> = {
  live: 'rgba(131, 110, 249, 0.16)',
  idle: color.well,
  held: 'rgba(221, 215, 254, 0.10)',
  revoked: 'rgba(240, 80, 140, 0.12)',
};

function BreathingDot({ color: tint }: { color: string }) {
  const reduced = useReducedMotion();
  const halo = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    halo.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [halo, reduced]);
  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.35 * halo.value,
    transform: [{ scale: 1 + halo.value * 0.9 }],
  }));
  return (
    <View style={styles.dotWrap}>
      <Animated.View style={[styles.dot, styles.halo, { backgroundColor: tint }, haloStyle]} />
      <View style={[styles.dot, { backgroundColor: tint }]} />
    </View>
  );
}

// ─── Gauge ──────────────────────────────────────────────────────────────────

export type Enforcer = 'enclave' | 'sente';

/**
 * One mandate limit, drawn as territory: how much is used, and where the line
 * is. Ten notches so 70% reads at a glance; the cap is a hard lilac tick.
 *
 * `used` is 0..1 and clamped — a value past the cap is still drawn full, and
 * the caller says so in `value`. `hot` shades the fill toward berry, for a
 * limit whose approach is bad news (a loss limit), never for time or size.
 */
export function Gauge({
  label,
  value,
  used,
  enforcer,
  hot = false,
}: {
  label: string;
  value: string;
  used: number;
  enforcer?: Enforcer;
  hot?: boolean;
}) {
  const fill = Math.min(1, Math.max(0, used));
  return (
    <View style={styles.gauge} accessibilityLabel={`${label}: ${value}`}>
      <View style={styles.gaugeHead}>
        <View style={styles.gaugeLabel}>
          <Text style={text.dim}>{label}</Text>
          {enforcer ? <EnforcerTag enforcer={enforcer} /> : null}
        </View>
        <Text style={[text.strong, text.num, styles.gaugeValue]}>{value}</Text>
      </View>
      <View style={styles.track}>
        {Array.from({ length: 10 }, (_, i) => (
          <View key={i} style={styles.notch} />
        ))}
        <View
          style={[
            styles.fill,
            {
              width: `${fill * 100}%`,
              backgroundColor: hot && fill > 0.6 ? color.berry : color.purple,
            },
          ]}
        />
        <View style={styles.cap} />
      </View>
    </View>
  );
}

/** Who enforces a limit: the signer refuses (`enclave`) or we check before sending (`sente`). */
export function EnforcerTag({ enforcer }: { enforcer: Enforcer }) {
  const enclave = enforcer === 'enclave';
  return (
    <View style={styles.enforcer}>
      {enclave ? <Icon name="shield" size={11} color={color.purpleSoft} strokeWidth={2.2} /> : null}
      <Text style={[styles.enforcerText, { color: enclave ? color.purpleSoft : color.textFaint }]}>
        {enforcer}
      </Text>
    </View>
  );
}

// ─── Stat ───────────────────────────────────────────────────────────────────

/** A labelled figure in a well, used three across. */
export function Stat({
  label,
  value,
  tone,
  style,
}: {
  label: string;
  value: ReactNode;
  tone?: 'up' | 'down';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.stat, style]}>
      <Text style={text.label}>{label}</Text>
      <Text style={[styles.statValue, tone === 'up' && text.up, tone === 'down' && text.down]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  deposit: {
    backgroundColor: '#ECE8FB',
    borderWidth: 1,
    borderColor: '#FFFFFF',
  },
  trade: {
    backgroundColor: color.purple,
    borderWidth: 1,
    borderColor: color.purpleHi,
    shadowColor: color.purple,
    shadowOpacity: 0.8,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  sigil: {
    backgroundColor: color.well,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dimmed: { opacity: 0.45 },
  mark: {
    backgroundColor: color.purple,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: color.purpleHi,
  },
  markGlyph: { color: color.ink, fontWeight: '900', textAlign: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingVertical: 3,
    paddingLeft: 8,
    paddingRight: 10,
    borderRadius: RADIUS.stone,
  },
  pillText: { fontFamily: font.medium, fontSize: 11, lineHeight: 15, letterSpacing: 0.2 },
  dotWrap: { width: 6, height: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  halo: { position: 'absolute' },
  gauge: { gap: 8 },
  gaugeHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  gaugeLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  gaugeValue: { fontSize: 14 },
  track: { height: 8, flexDirection: 'row', gap: 2 },
  notch: { flex: 1, borderRadius: 2, backgroundColor: color.well },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4 },
  cap: {
    position: 'absolute',
    right: -1,
    top: -4,
    bottom: -4,
    width: 2,
    borderRadius: 1,
    backgroundColor: color.purpleSoft,
  },
  enforcer: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  enforcerText: {
    fontFamily: font.medium,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  stat: {
    flex: 1,
    gap: 4,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
  statValue: {
    fontFamily: font.displaySemibold,
    fontSize: 18,
    lineHeight: 22,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
});
