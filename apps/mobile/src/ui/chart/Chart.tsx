/**
 * The price chart (SEN-107): a line, an equity area or candles, with the
 * position's levels drawn on it, the ledger's stones on the fills, and a scrub.
 *
 * The visual spec is the study's `docs/design/trading/chart.js`, reproduced
 * rather than reinterpreted, and the brief's "Goban, extended": entry in
 * `text`, TP `mint`, SL `berry`, liquidation `berry` dotted, a limit in
 * `purpleSoft`, the previous close `lineStrong` dashed; the agent's fills are
 * purple stones and yours are white ones, so the chart speaks the ledger's
 * language. Every number comes from `geometry.ts`; this file only draws.
 *
 * One Skia canvas, for the same reason as `ConsensusRamp`: the line, its
 * gradient, the levels and the stones are one surface, not a stack of views
 * that can round to different pixel rows.
 *
 * THE CHART NEVER OWNS THE HEADLINE. Scrubbing reports the sample under the
 * finger through `onScrub(index)`, and `onScrub(null)` when it lets go; the
 * screen decides what its big number says. The crosshair and dot move on the
 * UI thread through shared values, and `onScrub` fires only when the index
 * changes, so a drag is not a re-render per frame.
 *
 * `kind: 'area'` is the equity/P&L chart: no last-price pill (every study page
 * that draws one sets `last: false`), so it keeps its full width. `line` and
 * `candles` carry the pill in a right gutter sized to the widest price.
 */
import {
  Canvas,
  Circle,
  DashPathEffect,
  Group,
  Line,
  LinearGradient,
  Path,
  RoundedRect,
  Text,
  useFont,
  vec,
  type SkFont,
} from '@shopify/react-native-skia';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono/500Medium';
import { GeistMono_600SemiBold } from '@expo-google-fonts/geist-mono/600SemiBold';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { color } from '../theme';
import {
  areaPath,
  candleRects,
  formatPrice,
  isUp,
  lastTagWidth,
  levelLayout,
  linePath,
  markerIndex,
  nearestIndex,
  pointsXY,
  priceDecimals,
  scaleFor,
  toPrice,
  yOf,
  type ChartKline,
  type ChartLevel,
  type Decimal,
  type LevelKind,
} from './geometry';

export type ChartMarker = {
  /** Sample index; negative counts back from the end (`-1` is the last sample). */
  readonly index: number;
  /** The agent's fills are purple stones, yours are white ones. */
  readonly who: 'you' | 'agent';
  /** A few characters above the stone, e.g. a size (`+60`). */
  readonly label?: string;
};

export type ChartTone = 'auto' | 'purple' | 'mint' | 'berry';

export type ChartProps = {
  readonly kind: 'line' | 'area' | 'candles';
  /** Closes, oldest first. For `line` and `area`. */
  readonly points?: readonly Decimal[];
  /** Candles, oldest first. For `candles`; `KlineDto[]` fits as is. */
  readonly klines?: readonly ChartKline[];
  readonly levels?: readonly ChartLevel[];
  readonly markers?: readonly ChartMarker[];
  /** Drawn as a dashed line, always kept on the scale, and what `auto` tone measures against. */
  readonly prevClose?: Decimal;
  readonly height: number;
  /** `false` scales to the price only; out-of-range levels become edge chips. Default `true`. */
  readonly fit?: boolean;
  /** `auto` (default): mint if the series ended at or above where it is measured from, else berry. */
  readonly tone?: ChartTone;
  /** The sample under the finger while scrubbing, `null` on release. No scrub without it. */
  readonly onScrub?: (index: number | null) => void;
  /** What a screen reader says. */
  readonly label?: string;
};

/** chart.js's padding, in px. */
const PAD_TOP = 14;
const PAD_BOTTOM = 14;
/** The area chart keeps a sliver of right gutter so the line's end cap is not clipped. */
const PAD_RIGHT_BARE = 8;
/** The pill sits this far right of the plot. */
const TAG_GAP = 6;
const TAG_HEIGHT = 20;
/** Level labels sit this far above their line, 6 px in from the left. */
const LABEL_LIFT = 5;
const LABEL_X = 6;
/** The scrub starts on a horizontal drag, so a vertical one still scrolls the screen. */
const SCRUB_ACTIVATE_X = 6;
const SCRUB_FAIL_Y = 12;

const LEVEL_STYLE: Record<LevelKind, { color: string; dash: number[] }> = {
  entry: { color: color.text, dash: [5, 4] },
  tp: { color: color.mint, dash: [5, 4] },
  sl: { color: color.berry, dash: [5, 4] },
  liq: { color: color.berry, dash: [1.5, 3.5] },
  limit: { color: color.purpleSoft, dash: [5, 4] },
};

/** Stable empties, so an omitted prop does not recompute the geometry every render. */
const NO_LEVELS: readonly ChartLevel[] = [];
const NO_MARKERS: readonly ChartMarker[] = [];

/** Your stone, as chart.js draws it: a warm white with a white rim. */
const YOU_FILL = '#ECE8FB';
const YOU_RIM = '#FFFFFF';

function toneColor(tone: ChartTone, up: boolean): string {
  if (tone === 'purple') return color.purple;
  if (tone === 'mint') return color.mint;
  if (tone === 'berry') return color.berry;
  return up ? color.mint : color.berry;
}

/** `#RRGGBB` + an alpha fraction, for the gradient's two stops. */
function alpha(hex: string, fraction: number): string {
  const byte = Math.round(Math.max(0, Math.min(1, fraction)) * 255);
  return `${hex}${byte.toString(16).padStart(2, '0')}`;
}

export function Chart({
  kind,
  points,
  klines,
  levels = NO_LEVELS,
  markers = NO_MARKERS,
  prevClose,
  height,
  fit = true,
  tone = 'auto',
  onScrub,
  label,
}: ChartProps) {
  const [width, setWidth] = useState(0);
  const levelFont = useFont(GeistMono_500Medium, 9.5);
  const tagFont = useFont(GeistMono_600SemiBold, 10);
  const markerFont = useFont(Geist_600SemiBold, 9);

  const candles = kind === 'candles';
  const hasTag = kind !== 'area';

  const model = useMemo(() => {
    const bars = candles ? (klines ?? []) : [];
    const closes = candles ? bars.map((k) => toPrice(k.close)) : (points ?? []).map(toPrice);
    if (closes.length === 0 || width <= 0) return null;

    const first = candles ? Number(bars[0]?.open) : (closes[0] ?? 0);
    const last = closes[closes.length - 1] ?? 0;
    // A blank or garbled previous close is no reference at all, not a zero (SEN-141).
    const prevPrice = prevClose === undefined ? Number.NaN : toPrice(prevClose);
    const prev = Number.isFinite(prevPrice) ? prevPrice : null;
    const up = isUp(prev ?? first, last);
    const decimals = priceDecimals(last);

    const extent = candles ? bars.flatMap((k) => [toPrice(k.high), toPrice(k.low)]) : closes;
    const lastText = candles
      ? (bars[bars.length - 1]?.close ?? String(last))
      : (points?.[points.length - 1] ?? String(last));
    const lastLabel = formatPrice(lastText, decimals) ?? lastText;
    // Sized from the widest price on the chart, so the gutter holds still as it ticks.
    const widest = formatPrice(String(Math.max(...extent)), decimals) ?? lastLabel;
    const padRight = hasTag ? lastTagWidth(widest) : PAD_RIGHT_BARE;
    const plotWidth = Math.max(1, width - padRight);

    const levelPrices = levels.map((l) => Number(l.price));
    const scale = scaleFor(prev === null ? extent : [...extent, prev], levelPrices, {
      height,
      padTop: PAD_TOP,
      padBottom: PAD_BOTTOM,
      fit,
    });
    const xy = pointsXY(closes, scale, plotWidth);

    return {
      n: closes.length,
      up,
      padRight,
      plotWidth,
      line: candles ? null : linePath(closes, scale, plotWidth),
      area: candles ? null : areaPath(closes, scale, plotWidth, height),
      bars: candles ? candleRects(bars, scale, plotWidth) : [],
      prevY: prev === null ? null : yOf(scale, prev),
      levels: levelLayout(levelPrices, scale, height).map((place, i) => {
        const level = levels[i] as ChartLevel;
        const price = formatPrice(level.price, decimals) ?? level.price;
        return { ...place, kind: level.kind, text: `${level.label} ${price}` };
      }),
      stones: markers.map((m) => {
        const at = markerIndex(m.index, closes.length);
        return { ...m, at: at === null ? undefined : xy[at] };
      }),
      end: xy[xy.length - 1] ?? { x: plotWidth, y: height / 2 },
      lastLabel,
      xs: xy.map((p) => p.x),
      ys: xy.map((p) => p.y),
    };
  }, [candles, klines, points, prevClose, levels, markers, width, height, fit, hasTag]);

  const stroke = toneColor(tone, model?.up ?? true);

  // ── Scrub ────────────────────────────────────────────────────────────────
  const scrubX = useSharedValue(0);
  const scrubY = useSharedValue(0);
  const scrubOn = useSharedValue(0);
  const scrubIndex = useSharedValue(-1);
  const crossTop = useDerivedValue(() => vec(scrubX.value, 0));
  const crossBottom = useDerivedValue(() => vec(scrubX.value, height));
  const crossOpacity = useDerivedValue(() => scrubOn.value * 0.5);

  // The latest callback, read at call time, so a new closure from the screen
  // does not rebuild the gesture mid-drag.
  const onScrubRef = useRef(onScrub);
  useEffect(() => {
    onScrubRef.current = onScrub;
  }, [onScrub]);
  const emit = useMemo(() => (index: number | null) => onScrubRef.current?.(index), []);

  const scrubbable = onScrub !== undefined && model !== null;
  const gesture = useMemo(() => {
    const xs = model?.xs ?? [];
    const ys = model?.ys ?? [];
    const n = xs.length;
    const plotWidth = model?.plotWidth ?? 1;
    const follow = (x: number) => {
      'worklet';
      const i = nearestIndex(x, n, plotWidth);
      scrubX.value = xs[i] ?? 0;
      scrubY.value = ys[i] ?? 0;
      scrubOn.value = 1;
      if (i !== scrubIndex.value) {
        scrubIndex.value = i;
        scheduleOnRN(emit, i);
      }
    };
    const release = () => {
      'worklet';
      scrubOn.value = 0;
      if (scrubIndex.value !== -1) {
        scrubIndex.value = -1;
        scheduleOnRN(emit, null);
      }
    };
    return Gesture.Pan()
      .activeOffsetX([-SCRUB_ACTIVATE_X, SCRUB_ACTIVATE_X])
      .failOffsetY([-SCRUB_FAIL_Y, SCRUB_FAIL_Y])
      .onStart((e) => follow(e.x))
      .onUpdate((e) => follow(e.x))
      .onFinalize(() => release());
  }, [model, emit, scrubX, scrubY, scrubOn, scrubIndex]);

  const canvas =
    model === null ? null : (
      <Canvas style={{ width, height }}>
        {model.prevY !== null ? (
          <Line
            p1={vec(0, model.prevY)}
            p2={vec(model.plotWidth, model.prevY)}
            color={color.lineStrong}
            strokeWidth={1}
            style="stroke"
          >
            <DashPathEffect intervals={[2, 4]} />
          </Line>
        ) : null}

        {model.area !== null && model.line !== null ? (
          <Group>
            <Path path={model.area}>
              <LinearGradient
                start={vec(0, 0)}
                end={vec(0, height)}
                colors={[alpha(stroke, 0.28), alpha(stroke, 0)]}
              />
            </Path>
            <Path
              path={model.line}
              color={stroke}
              style="stroke"
              strokeWidth={2}
              strokeJoin="round"
              strokeCap="round"
            />
          </Group>
        ) : null}

        {model.bars.map((bar, i) => {
          const fill = bar.up ? color.mint : color.berry;
          return (
            <Group key={i}>
              <Line
                p1={vec(bar.x, bar.wick.top)}
                p2={vec(bar.x, bar.wick.bottom)}
                color={fill}
                strokeWidth={1}
                style="stroke"
              />
              <RoundedRect
                x={bar.body.x}
                y={bar.body.y}
                width={bar.body.width}
                height={bar.body.height}
                r={1}
                color={fill}
              />
            </Group>
          );
        })}

        {model.levels.map((level, i) => {
          const style = LEVEL_STYLE[level.kind];
          if (!level.onScale) {
            return (
              <Group key={i}>
                <Path path={chevron(LABEL_X, level.y, level.edge === 'top')} color={style.color} />
                <Halo
                  font={levelFont}
                  x={LABEL_X + 10}
                  y={level.y}
                  text={level.text}
                  fill={style.color}
                />
              </Group>
            );
          }
          return (
            <Group key={i}>
              <Line
                p1={vec(0, level.y)}
                p2={vec(model.plotWidth, level.y)}
                color={style.color}
                strokeWidth={1.2}
                style="stroke"
              >
                <DashPathEffect intervals={style.dash} />
              </Line>
              <Halo
                font={levelFont}
                x={LABEL_X}
                y={level.y - LABEL_LIFT}
                text={level.text}
                fill={style.color}
              />
            </Group>
          );
        })}

        {model.stones.map((stone, i) =>
          stone.at === undefined ? null : (
            <Group key={i}>
              {stone.who === 'agent' ? (
                <>
                  <Circle cx={stone.at.x} cy={stone.at.y} r={6} color={color.purple} />
                  <Circle
                    cx={stone.at.x}
                    cy={stone.at.y}
                    r={6}
                    color={color.purpleHi}
                    style="stroke"
                    strokeWidth={1.5}
                  />
                </>
              ) : (
                <>
                  <Circle cx={stone.at.x} cy={stone.at.y} r={6} color={YOU_FILL} />
                  <Circle
                    cx={stone.at.x}
                    cy={stone.at.y}
                    r={6}
                    color={YOU_RIM}
                    style="stroke"
                    strokeWidth={1}
                  />
                </>
              )}
              {stone.label !== undefined && markerFont !== null ? (
                <Text
                  font={markerFont}
                  x={stone.at.x - markerFont.measureText(stone.label).width / 2}
                  y={stone.at.y - 10}
                  text={stone.label}
                  color={color.text}
                />
              ) : null}
            </Group>
          ),
        )}

        {hasTag ? (
          <Group>
            <Circle cx={model.end.x} cy={model.end.y} r={3.5} color={stroke} />
            <RoundedRect
              x={width - model.padRight + TAG_GAP}
              y={model.end.y - TAG_HEIGHT / 2}
              width={model.padRight - 8}
              height={TAG_HEIGHT}
              r={TAG_HEIGHT / 2}
              color={stroke}
            />
            {tagFont !== null ? (
              <Text
                font={tagFont}
                x={
                  width -
                  model.padRight +
                  TAG_GAP +
                  (model.padRight - 8 - tagFont.measureText(model.lastLabel).width) / 2
                }
                y={model.end.y + 4}
                text={model.lastLabel}
                color={color.ink}
              />
            ) : null}
          </Group>
        ) : null}

        {scrubbable ? (
          <Group>
            <Line
              p1={crossTop}
              p2={crossBottom}
              color={color.textDim}
              strokeWidth={1}
              style="stroke"
              opacity={crossOpacity}
            />
            <Group opacity={scrubOn}>
              <Circle cx={scrubX} cy={scrubY} r={5} color={stroke} />
              <Circle
                cx={scrubX}
                cy={scrubY}
                r={5}
                color={color.ink}
                style="stroke"
                strokeWidth={2}
              />
            </Group>
          </Group>
        ) : null}
      </Canvas>
    );

  return (
    <View
      style={{ height, width: '100%' }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      {scrubbable ? (
        // A root of its own, so the chart scrubs wherever it is mounted; nested
        // under an app-level root it behaves as a plain view.
        <GestureHandlerRootView style={{ flex: 1 }}>
          <GestureDetector gesture={gesture}>
            <View style={{ flex: 1 }}>{canvas}</View>
          </GestureDetector>
        </GestureHandlerRootView>
      ) : (
        canvas
      )}
    </View>
  );
}

/**
 * A level label with chart.js's halo: the text stroked in `ink` first, then
 * filled, so a label crossing the line stays legible.
 */
function Halo({
  font,
  x,
  y,
  text,
  fill,
}: {
  font: SkFont | null;
  x: number;
  y: number;
  text: string;
  fill: string;
}) {
  if (font === null) return null;
  return (
    <Group>
      <Text
        font={font}
        x={x}
        y={y}
        text={text}
        color={color.ink}
        style="stroke"
        strokeWidth={3}
        strokeJoin="round"
      />
      <Text font={font} x={x} y={y} text={text} color={fill} />
    </Group>
  );
}

/**
 * The edge chip's arrow, as a drawn triangle rather than an `↑` glyph the mono
 * face may not carry. `y` is the label's baseline.
 */
function chevron(x: number, y: number, pointsUp: boolean): string {
  return pointsUp
    ? `M${x},${y - 1}L${x + 3.5},${y - 7}L${x + 7},${y - 1}Z`
    : `M${x},${y - 7}L${x + 7},${y - 7}L${x + 3.5},${y - 1}Z`;
}
