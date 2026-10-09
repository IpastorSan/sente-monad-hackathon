/**
 * Web twin of `joseki.tsx` (SEN-173): the same layout from `presets/joseki.ts`
 * painted as DOM SVG, because a preset list of Skia canvases on web is a list
 * of WebGL contexts and Chrome keeps ~16 per page (`docs/web.md`).
 *
 * The stone gradients are the native ones in bounding-box units: Skia's centre
 * `(cx − 0.3r, cy − 0.4r)` with radius `1.1r` is `(0.35, 0.3)` and `0.55` of a
 * stone's `2r` box.
 */
import { useId, useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { josekiFor, josekiLayout, type PlacedStone } from '../presets/joseki';
import { color } from './theme';

const AGENT_STONE = [
  ['0', '#A898FF'],
  ['0.6', color.purple],
  ['1', '#5A45D6'],
] as const;
const WHITE_STONE = [
  ['0', '#FFFFFF'],
  ['0.7', '#D8D3EE'],
] as const;

export function Joseki({
  presetId,
  width = 60,
  height = 60,
  large = false,
  style,
}: {
  presetId: string;
  width?: number;
  height?: number;
  /** The featured card's wide board: finer lines, smaller stones, no well. */
  large?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const layout = useMemo(
    () => josekiLayout(josekiFor(presetId), { width, height }, large),
    [presetId, width, height, large],
  );
  // Gradient ids are document-wide: one pair per board.
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const agentFill = `url(#${id}a)`;
  const whiteFill = `url(#${id}w)`;

  return (
    <View
      style={[styles.box, { width, height }, large && styles.large, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden
        focusable={false}
        style={SVG_STYLE}
      >
        <defs>
          <Gradient id={`${id}a`} stops={AGENT_STONE} />
          <Gradient id={`${id}w`} stops={WHITE_STONE} />
        </defs>
        <g
          stroke={color.lineStrong}
          strokeOpacity={large ? 1 : 0.8}
          strokeWidth={layout.gridStroke}
        >
          {layout.grid.map((s) => (
            <line key={`${s.x1},${s.y1},${s.x2}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
          ))}
        </g>
        <g
          stroke={color.purpleHi}
          strokeOpacity={0.55}
          strokeWidth={layout.bandStroke}
          strokeDasharray={layout.dash.join(' ')}
        >
          {layout.bands.map((s) => (
            <line key={s.y1} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
          ))}
        </g>
        {layout.stones.map((stone) => (
          <StoneMark
            key={`${stone.cx},${stone.cy}`}
            stone={stone}
            ring={layout.ringStroke}
            fill={stone.kind === 'agent' ? agentFill : whiteFill}
          />
        ))}
      </svg>
    </View>
  );
}

function Gradient({ id, stops }: { id: string; stops: readonly (readonly [string, string])[] }) {
  return (
    <radialGradient id={id} cx="0.35" cy="0.3" r="0.55">
      {stops.map(([offset, stopColor]) => (
        <stop key={offset} offset={offset} stopColor={stopColor} />
      ))}
    </radialGradient>
  );
}

function StoneMark({ stone, ring, fill }: { stone: PlacedStone; ring: number; fill: string }) {
  const { cx, cy, r } = stone;
  if (stone.kind === 'watched') {
    // Filled with ink so the grid does not show through: a ring is a level,
    // not an empty intersection.
    return (
      <circle cx={cx} cy={cy} r={r} fill={color.ink} stroke={color.purpleHi} strokeWidth={ring} />
    );
  }
  return <circle cx={cx} cy={cy} r={r} fill={fill} />;
}

const SVG_STYLE = { display: 'block' } as const;

const styles = StyleSheet.create({
  box: {
    borderRadius: 14,
    backgroundColor: color.well,
    overflow: 'hidden',
  },
  large: { backgroundColor: 'transparent', borderRadius: 18 },
});
