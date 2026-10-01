/**
 * The trading kit (SEN-108): the pieces the Markets, asset, portfolio and
 * cockpit screens share. The visual spec is the study's `trading.css`
 * (`.big`, `.mkt`, `.tok`, `.tag-perp`, `.levels`, `.pressure`, `.ranges`,
 * `.side--*`, `.ticker`, `.asof`); every choice with a rule behind it lives in
 * `tradingFormat.ts`, so this file only lays out.
 *
 * Mint and berry are direction colours here and nothing else: a price change,
 * a P&L, a side. Purple stays an event (the PERP tag is the only purple, and
 * it marks a leveraged venue, which is a move of its own).
 */
import { Canvas, LinearGradient, Rect, vec } from '@shopify/react-native-skia';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Sparkline } from './chart/Sparkline';
import type { Decimal } from './chart/geometry';
import { color, font, RADIUS, text } from './theme';
import {
  asOfLabel,
  formatPct,
  formatPrice,
  glyphFor,
  isStale,
  leverageTag,
  maskDigits,
  pctDirection,
  pressureSplit,
  splitDecimals,
  STALE_AFTER_MS,
  type Direction,
} from './tradingFormat';

/** `--berry-deep` in sente.css: the liquidation edge, darker than a stop. */
const BERRY_DEEP = '#A0055D';

const DIRECTION_TONE: Record<Direction, string> = {
  up: color.mint,
  down: color.berry,
  flat: color.textDim,
};

// ─── Numbers ────────────────────────────────────────────────────────────────

const BIG_SIZE = { md: 32, lg: 44, xl: 64 } as const;

/**
 * The headline figure with dimmed decimals: `1,284` at full weight, `.50`
 * smaller and faint, so the eye lands on the part that moves the decision.
 *
 * The study sets it in Bricolage at 80 % width; the app only loads the
 * normal-width cut, so the condensing comes from tighter tracking instead of a
 * second font file. `blurred` masks the digits rather than blurring them: RN
 * has no text blur on iOS, and dots keep the figure's shape without leaking it.
 */
export function BigNumber({
  value,
  places = 2,
  prefix = '',
  approx = false,
  size = 'lg',
  blurred = false,
  style,
}: {
  value: Decimal;
  places?: number;
  /** Currency sign at full size, e.g. `$`. */
  prefix?: string;
  /** Mixed-venue totals (USDC + AUSD) are only ≈ in dollars. */
  approx?: boolean;
  size?: keyof typeof BIG_SIZE;
  blurred?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  const px = BIG_SIZE[size];
  const parts = splitDecimals(value, places) ?? { whole: '—', fraction: '' };
  const whole = blurred ? maskDigits(parts.whole) : parts.whole;
  const fraction = blurred ? maskDigits(parts.fraction) : parts.fraction;
  const small = { fontSize: Math.round(px * 0.62), letterSpacing: -0.02 * px * 0.62 };
  return (
    <Text
      style={[
        styles.big,
        { fontSize: px, lineHeight: Math.round(px * 1.05), letterSpacing: -0.035 * px },
        style,
      ]}
      accessibilityLabel={blurred ? 'Hidden' : undefined}
      numberOfLines={1}
    >
      {approx ? <Text style={[styles.bigSmall, small]}>≈ </Text> : null}
      {prefix}
      {whole}
      {fraction ? <Text style={[styles.bigSmall, small]}>{fraction}</Text> : null}
    </Text>
  );
}

/**
 * A change as `+2.41%`, mint up and berry down. `lead` goes before it in the
 * same colour (`+$84.12 (`… the amount), `suffix` after it (` today`).
 */
export function ChangeText({
  pct,
  lead = '',
  suffix = '',
  style,
}: {
  /** Percent, e.g. `2.41`. `null` prints a dash. */
  pct: number | null;
  lead?: string;
  suffix?: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text style={[styles.chg, { color: DIRECTION_TONE[pctDirection(pct)] }, style]}>
      {lead}
      {formatPct(pct)}
      {suffix}
    </Text>
  );
}

// ─── Market rows ────────────────────────────────────────────────────────────

/** A token as a stone with its first letter. No third-party logos. */
export function TokenGlyph({ symbol, size = 'md' }: { symbol: string; size?: 'md' | 'sm' }) {
  const { letter, tint } = glyphFor(symbol);
  const d = size === 'md' ? 36 : 24;
  return (
    <View
      style={[styles.tok, { width: d, height: d, borderRadius: d / 2, backgroundColor: tint }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.tokLetter, { fontSize: size === 'md' ? 14 : 11 }]}>{letter}</Text>
    </View>
  );
}

/** The PERP badge beside a symbol: `PERP 20×`. */
export function PerpTag({ leverage }: { leverage?: number | null }) {
  // Thin spaces stand in for padding: a Text nested in a line ignores padding.
  return <Text style={styles.perp}>{`\u2009${leverageTag(leverage)}\u2009`}</Text>;
}

/**
 * One market: stone, symbol over its venue, a sparkline, price over change.
 * The sparkline takes its colour from the change beside it, so the line and
 * the number can never disagree.
 */
export function MarketRow({
  symbol,
  subline,
  price,
  tick,
  changePct,
  points,
  perp,
  divider = true,
  onPress,
}: {
  symbol: string;
  /** Venue or quote, e.g. `Kuru spot`, `Perpl perps`. */
  subline: string;
  price: Decimal;
  /** The market's tick; sets the decimals shown. */
  tick?: Decimal;
  changePct: number | null;
  /** Closes for the sparkline, oldest first. Omitted → no line. */
  points?: readonly Decimal[];
  /** Set for a perp; `leverage` is its max, shown as `PERP n×`. */
  perp?: { leverage?: number | null };
  divider?: boolean;
  onPress?: () => void;
}) {
  const direction = pctDirection(changePct);
  const shownPrice = formatPrice(price, tick) ?? '—';
  const change = formatPct(changePct);
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.mkt, divider && styles.mktDivider, pressed && styles.pressed]}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${symbol}${perp ? ' perpetual' : ''}, ${subline}, ${shownPrice}, ${change}`}
    >
      <TokenGlyph symbol={symbol} />
      <View style={styles.mktMain}>
        <Text style={text.strong} numberOfLines={1}>
          {symbol}
          {perp ? ' ' : null}
          {perp ? <PerpTag leverage={perp.leverage} /> : null}
        </Text>
        <Text style={text.caption} numberOfLines={1}>
          {subline}
        </Text>
      </View>
      <View style={styles.mktSpark}>
        {points && points.length > 1 ? (
          <Sparkline points={points} up={direction === 'flat' ? undefined : direction === 'up'} />
        ) : null}
      </View>
      <View style={styles.mktPx}>
        <Text style={[text.strong, text.num]} numberOfLines={1}>
          {shownPrice}
        </Text>
        <Text style={[text.dim, text.num, { color: DIRECTION_TONE[direction] }]}>{change}</Text>
      </View>
    </Pressable>
  );
}

// ─── Positions ──────────────────────────────────────────────────────────────

/** LONG / SHORT, in the direction colour. */
export function SideTag({ side }: { side: 'long' | 'short' }) {
  const long = side === 'long';
  return (
    <Text
      style={[
        styles.side,
        long
          ? { color: color.mint, backgroundColor: 'rgba(95, 227, 179, 0.12)' }
          : { color: color.berry, backgroundColor: 'rgba(240, 80, 140, 0.12)' },
      ]}
    >
      {long ? 'LONG' : 'SHORT'}
    </Text>
  );
}

const LEVEL_TILES = [
  { key: 'entry', label: 'Entry', edge: color.text },
  { key: 'target', label: 'Target', edge: color.mint },
  { key: 'stop', label: 'Stop', edge: color.berry },
  { key: 'liq', label: 'Liq. est', edge: BERRY_DEEP },
] as const;

/**
 * Entry / Target / Stop / Liq tiles, each with the coloured top edge its line
 * has on the chart, so the tile and the dashed level read as the same thing.
 * A level that isn't set shows a dash, never a zero.
 */
export function Levels({
  tick,
  ...values
}: {
  entry?: Decimal | null;
  target?: Decimal | null;
  stop?: Decimal | null;
  liq?: Decimal | null;
  tick?: Decimal;
}) {
  return (
    <View style={styles.levels}>
      {LEVEL_TILES.map(({ key, label, edge }) => {
        const value = values[key];
        return (
          <View key={key} style={[styles.level, { borderTopColor: edge }]}>
            <Text style={text.caption}>{label}</Text>
            <Text style={[styles.levelValue, text.num]} numberOfLines={1} adjustsFontSizeToFit>
              {value ? (formatPrice(value, tick) ?? '—') : '—'}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Order-book pressure: bids mint from the left, asks berry behind them, with
 * the split underneath. An empty book draws an empty track and no legend.
 */
export function PressureBar({
  bids,
  asks,
  legend = true,
}: {
  /** Resting size on each side, any unit, as long as both match. */
  bids: Decimal;
  asks: Decimal;
  legend?: boolean;
}) {
  const split = pressureSplit(bids, asks);
  return (
    <View>
      <View
        style={[styles.pressure, split === null && { backgroundColor: color.well }]}
        accessibilityLabel={
          split ? `Bids ${split.bid} percent, asks ${split.ask} percent` : 'Order book empty'
        }
      >
        {split !== null ? (
          <View
            style={[
              styles.pressureBid,
              { width: `${split.bid}%` },
              split.bid > 0 && split.ask > 0 && styles.pressureSeam,
            ]}
          />
        ) : null}
      </View>
      {legend && split !== null ? (
        <View style={styles.pressureLegend}>
          <Text style={[text.caption, text.up]}>Bids {split.bid}%</Text>
          <Text style={[text.caption, text.down]}>Asks {split.ask}%</Text>
        </View>
      ) : null}
    </View>
  );
}

// ─── Chart surroundings ─────────────────────────────────────────────────────

/** The chart's range switch: 1H 1D 1W 1M 1Y, the chosen one on a well. */
export function RangePills<T extends string>({
  options,
  value,
  onChange,
  trailing,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  /** After the pills, e.g. the line/candles toggle. */
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.ranges} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option === value;
        return (
          <Pressable
            key={option}
            onPress={() => onChange(option)}
            style={[styles.range, selected && styles.rangeOn]}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            hitSlop={4}
          >
            <Text style={[styles.rangeText, selected && { color: color.text }]}>{option}</Text>
          </Pressable>
        );
      })}
      {trailing}
    </View>
  );
}

/**
 * `● as of 3s`: how fresh the numbers are. The dot breathes while the data is
 * live and turns into a hollow ring once it is stale (or `paused` — a screen
 * out of focus stops polling), so an old price never looks live.
 */
export function AsOf({
  at,
  paused = false,
  staleAfterMs = STALE_AFTER_MS,
}: {
  /** When the data was fetched, epoch ms. `null` before the first answer. */
  at: number | null;
  paused?: boolean;
  staleAfterMs?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // One tick a second is the label's resolution; it stops once paused.
    if (paused || at === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [paused, at]);

  const live = at !== null && !paused && !isStale(at, now, staleAfterMs);
  return (
    <View style={styles.asof}>
      {live ? <LiveDot /> : <View style={[styles.asofDot, styles.asofPaused]} />}
      <Text style={styles.asofText}>{at === null ? 'loading' : asOfLabel(at, now)}</Text>
    </View>
  );
}

function LiveDot() {
  const reduced = useReducedMotion();
  const halo = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    halo.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(halo);
  }, [halo, reduced]);
  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.35 * halo.value,
    transform: [{ scale: 1 + halo.value }],
  }));
  return (
    <View style={styles.asofDotWrap}>
      <Animated.View style={[styles.asofDot, styles.asofLive, styles.asofHalo, haloStyle]} />
      <View style={[styles.asofDot, styles.asofLive]} />
    </View>
  );
}

// ─── Ticker ─────────────────────────────────────────────────────────────────

export type TickerItem = {
  symbol: string;
  price: Decimal;
  tick?: Decimal;
  changePct: number | null;
};

const TICKER_GAP = 18;
const TICKER_HEIGHT = 18;
/** Pixels a second: the study's 22 s loop over a ~600 px strip. */
const TICKER_SPEED = 28;
const FADE = 24;

/**
 * The majors strip on Home: the row drawn twice side by side and slid left by
 * one copy's width, forever, so the seam never shows. Under reduced motion it
 * stands still and scrolls by hand instead.
 */
export function TickerMarquee({
  items,
  background = color.ink,
}: {
  items: readonly TickerItem[];
  /** What the edge fades fade into: the screen's ground, as `#RRGGBB` (an alpha byte is appended). */
  background?: string;
}) {
  const reduced = useReducedMotion();
  const [copyWidth, setCopyWidth] = useState(0);
  const [box, setBox] = useState(0);
  const x = useSharedValue(0);

  useEffect(() => {
    if (reduced || copyWidth === 0) return;
    x.value = 0;
    x.value = withRepeat(
      withTiming(-copyWidth, {
        duration: (copyWidth / TICKER_SPEED) * 1000,
        easing: Easing.linear,
      }),
      -1,
      false,
    );
    return () => cancelAnimation(x);
  }, [x, copyWidth, reduced]);

  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  // Copies after the first: one on a phone, where a copy outruns the screen;
  // enough to cover the strip when it is wider than a copy (wide web, SEN-167).
  const trailing = copyWidth > 0 && box > copyWidth ? Math.ceil(box / copyWidth) : 1;

  const copy = (key: string, onLayout?: (e: LayoutChangeEvent) => void) => (
    <View key={key} style={styles.tickerCopy} onLayout={onLayout}>
      {items.map((item, i) => (
        <Text key={`${item.symbol}-${i}`} style={styles.tickerItem} numberOfLines={1}>
          <Text style={styles.tickerSymbol}>{item.symbol} </Text>
          <Text style={{ color: DIRECTION_TONE[pctDirection(item.changePct)] }}>
            {formatPrice(item.price, item.tick) ?? '—'} {formatPct(item.changePct)}
          </Text>
        </Text>
      ))}
    </View>
  );

  return (
    <View
      style={styles.ticker}
      onLayout={(e) => setBox(e.nativeEvent.layout.width)}
      accessibilityLabel={items
        .map((i) => `${i.symbol} ${formatPrice(i.price, i.tick) ?? ''} ${formatPct(i.changePct)}`)
        .join(', ')}
    >
      {reduced ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {copy('a')}
        </ScrollView>
      ) : (
        <Animated.View style={[styles.tickerTrack, slide]}>
          {copy('a', (e) => setCopyWidth(e.nativeEvent.layout.width))}
          {Array.from({ length: trailing }, (_, i) => copy(`b${i}`))}
        </Animated.View>
      )}
      {box > 0 ? (
        // One object, not an array: Skia's web Canvas spreads its style into a
        // <div>, and an array there throws (SEN-167), blanking Home on the web.
        <Canvas
          style={StyleSheet.flatten([styles.tickerFade, { width: box }])}
          pointerEvents="none"
        >
          <Rect x={0} y={0} width={FADE} height={TICKER_HEIGHT}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(FADE, 0)}
              colors={[background, `${background}00`]}
            />
          </Rect>
          <Rect x={box - FADE} y={0} width={FADE} height={TICKER_HEIGHT}>
            <LinearGradient
              start={vec(box - FADE, 0)}
              end={vec(box, 0)}
              colors={[`${background}00`, background]}
            />
          </Rect>
        </Canvas>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  big: {
    fontFamily: font.displaySemibold,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  bigSmall: { color: color.textFaint },
  chg: {
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
    fontVariant: ['tabular-nums'],
  },
  tok: { alignItems: 'center', justifyContent: 'center' },
  tokLetter: { fontFamily: font.display, color: color.ink },
  perp: {
    fontFamily: font.semibold,
    fontSize: 9.5,
    lineHeight: 15,
    letterSpacing: 0.6,
    color: color.purpleHi,
    backgroundColor: 'rgba(131, 110, 249, 0.16)',
  },
  mkt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  mktDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  pressed: { opacity: 0.7 },
  mktMain: { flex: 1, minWidth: 0, gap: 1 },
  mktSpark: { width: 64, height: 28 },
  mktPx: { alignItems: 'flex-end', gap: 1 },
  side: {
    alignSelf: 'flex-start',
    fontFamily: font.semibold,
    fontSize: 10,
    lineHeight: 16,
    letterSpacing: 0.8,
    paddingHorizontal: 6,
    borderRadius: 4,
    overflow: 'hidden',
  },
  levels: { flexDirection: 'row', gap: 6 },
  level: {
    flex: 1,
    gap: 2,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
    borderTopWidth: 2,
  },
  levelValue: { fontFamily: font.semibold, fontSize: 14, lineHeight: 20, color: color.text },
  pressure: {
    height: 6,
    borderRadius: 6,
    backgroundColor: color.berry,
    overflow: 'hidden',
  },
  pressureBid: { height: '100%', backgroundColor: color.mint },
  pressureSeam: { borderRightWidth: 2, borderRightColor: color.ink },
  pressureLegend: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  ranges: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    marginTop: 8,
  },
  range: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    borderRadius: RADIUS.stone,
  },
  rangeOn: { backgroundColor: color.well },
  rangeText: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, color: color.textFaint },
  asof: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  asofText: { fontFamily: font.chain, fontSize: 11, lineHeight: 14, color: color.textFaint },
  asofDotWrap: { width: 6, height: 6 },
  asofDot: { width: 6, height: 6, borderRadius: 3 },
  asofLive: { backgroundColor: color.mint },
  asofHalo: { position: 'absolute' },
  asofPaused: { borderWidth: 1.5, borderColor: color.textFaint },
  ticker: { height: TICKER_HEIGHT, overflow: 'hidden' },
  tickerTrack: { flexDirection: 'row' },
  tickerCopy: { flexDirection: 'row', gap: TICKER_GAP, paddingRight: TICKER_GAP },
  tickerItem: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: TICKER_HEIGHT,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  tickerSymbol: { fontFamily: font.semibold, color: color.text },
  tickerFade: { position: 'absolute', top: 0, left: 0, height: TICKER_HEIGHT },
});
