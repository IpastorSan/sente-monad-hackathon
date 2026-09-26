/**
 * The Welcome screen's board (SEN-57): the product's idea in one picture —
 * stones placed inside a line the enclave draws. A 9×9 grid, a dashed mandate
 * boundary, a few stones inside it, one refusal outside it, and the tengen
 * (centre) stone breathing: the agent is live, and it is still inside the line.
 *
 * Drawn in `docs/design/mockups.html`'s own 200-unit coordinates and scaled to
 * the width it is given, so the two stay comparable point for point.
 *
 * The breath is a blurred purple halo behind the stone, not a scale on the
 * stone itself: a stone that grows reads as a move, and nothing moved. Reduced
 * motion leaves the halo off and the board still.
 */
import {
  BlurMask,
  Canvas,
  Circle,
  DashPathEffect,
  Group,
  Line,
  RoundedRect,
  vec,
} from '@shopify/react-native-skia';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { color } from './theme';

/** The mockup's viewBox side. */
const VIEW = 200;
const MAX_SIZE = 300;
/** One full breath, in then out, as the mockup's `breathe-stone`. */
const BREATH_MS = 3_000;
const LINES = Array.from({ length: 9 }, (_, i) => 20 + i * 20);

export function GobanHero() {
  const [width, setWidth] = useState(0);
  const size = Math.min(width, MAX_SIZE);
  const reduced = useReducedMotion();

  const breath = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    breath.value = withRepeat(
      withTiming(1, { duration: BREATH_MS / 2, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [breath, reduced]);
  const haloOpacity = useDerivedValue(() => 0.8 * breath.value);

  return (
    <View
      style={{ width: '100%', alignItems: 'center' }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {size > 0 ? (
        <Canvas style={{ width: size, height: size }}>
          <Group transform={[{ scale: size / VIEW }]}>
            <Group color={color.lineStrong} style="stroke" strokeWidth={1}>
              {LINES.map((p) => (
                <Group key={p}>
                  <Line p1={vec(20, p)} p2={vec(180, p)} />
                  <Line p1={vec(p, 20)} p2={vec(p, 180)} />
                </Group>
              ))}
            </Group>

            {/* The mandate: territory, then its boundary. */}
            <RoundedRect
              x={50}
              y={50}
              width={100}
              height={100}
              r={4}
              color="rgba(131, 110, 249, 0.07)"
            />
            <RoundedRect
              x={50}
              y={50}
              width={100}
              height={100}
              r={4}
              color={color.purpleSoft}
              style="stroke"
              strokeWidth={1}
            >
              <DashPathEffect intervals={[4, 4]} />
            </RoundedRect>

            <Circle cx={80} cy={80} r={8} color={color.text} />
            <Circle cx={120} cy={120} r={8} color={color.purple} />
            <Circle cx={140} cy={80} r={8} color={color.purple} />

            {/* Tengen, breathing. */}
            <Circle cx={100} cy={100} r={11} color={color.purple} opacity={haloOpacity}>
              <BlurMask blur={8} style="normal" />
            </Circle>
            <Circle cx={100} cy={100} r={9} color={color.purpleHi} />

            {/* A refusal, outside the line: the one move the enclave held. */}
            <Circle
              cx={160}
              cy={140}
              r={7}
              color={color.purpleSoft}
              style="stroke"
              strokeWidth={2}
            />
            <Line
              p1={vec(153, 147)}
              p2={vec(167, 133)}
              color={color.purpleSoft}
              style="stroke"
              strokeWidth={2}
            />
          </Group>
        </Canvas>
      ) : null}
    </View>
  );
}
