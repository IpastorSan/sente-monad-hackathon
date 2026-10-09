/**
 * A preset's joseki (SEN-114): its strategy's shape as stones on a slice of
 * the board. The geometry and the patterns live in `presets/joseki.ts`; this
 * only paints them, the way agents.html's script does — purple stones for
 * the agent, white for the market, hollow purple rings for watched levels,
 * dashed purple bands for the lines a range or a mean is drawn between.
 *
 * Native only: the web build resolves `joseki.web.tsx`, the same layout as DOM
 * SVG, so a preset list does not cost a WebGL context per card (SEN-173).
 */
import {
  Canvas,
  Circle,
  DashPathEffect,
  Group,
  Line,
  RadialGradient,
  vec,
} from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { josekiFor, josekiLayout, type PlacedStone } from '../presets/joseki';
import { color } from './theme';

/** The study's stone gradients (`#jp`, `#jw`), lit from the upper left. */
const AGENT_STONE = ['#A898FF', color.purple, '#5A45D6'];
const AGENT_STOPS = [0, 0.6, 1];
const WHITE_STONE = ['#FFFFFF', '#D8D3EE'];
const WHITE_STOPS = [0, 0.7];

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

  return (
    <View
      style={[styles.box, { width, height }, large && styles.large, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Canvas style={{ width, height }}>
        <Group
          color={color.lineStrong}
          opacity={large ? 1 : 0.8}
          style="stroke"
          strokeWidth={layout.gridStroke}
        >
          {layout.grid.map((s) => (
            <Line key={`${s.x1},${s.y1},${s.x2}`} p1={vec(s.x1, s.y1)} p2={vec(s.x2, s.y2)} />
          ))}
        </Group>
        <Group color={color.purpleHi} opacity={0.55} style="stroke" strokeWidth={layout.bandStroke}>
          <DashPathEffect intervals={layout.dash} />
          {layout.bands.map((s) => (
            <Line key={s.y1} p1={vec(s.x1, s.y1)} p2={vec(s.x2, s.y2)} />
          ))}
        </Group>
        {layout.stones.map((stone) => (
          <StoneMark key={`${stone.cx},${stone.cy}`} stone={stone} ring={layout.ringStroke} />
        ))}
      </Canvas>
    </View>
  );
}

function StoneMark({ stone, ring }: { stone: PlacedStone; ring: number }) {
  const { cx, cy, r } = stone;
  if (stone.kind === 'watched') {
    // Filled with ink so the grid does not show through: a ring is a level,
    // not an empty intersection.
    return (
      <Group>
        <Circle cx={cx} cy={cy} r={r} color={color.ink} />
        <Circle cx={cx} cy={cy} r={r} color={color.purpleHi} style="stroke" strokeWidth={ring} />
      </Group>
    );
  }
  const agent = stone.kind === 'agent';
  return (
    <Circle cx={cx} cy={cy} r={r}>
      <RadialGradient
        c={vec(cx - r * 0.3, cy - r * 0.4)}
        r={r * 1.1}
        colors={agent ? AGENT_STONE : WHITE_STONE}
        positions={agent ? AGENT_STOPS : WHITE_STOPS}
      />
    </Circle>
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: 14,
    backgroundColor: color.well,
    overflow: 'hidden',
  },
  large: { backgroundColor: 'transparent', borderRadius: 18 },
});
