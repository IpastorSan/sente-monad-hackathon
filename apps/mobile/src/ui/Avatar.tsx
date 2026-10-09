/**
 * The user's face (SEN-172), drawn with Skia from `avatarArt` — the pure
 * generator is the single source of truth, this only paints it.
 *
 * Native only: on web Metro picks `Avatar.web.tsx`, which shows the same
 * shapes as an SVG image, because every Skia canvas on web holds a WebGL
 * context and Chrome drops the oldest past ~16 per page (SEN-174).
 */
import {
  Canvas,
  Circle,
  Group,
  Path,
  RadialGradient,
  Rect,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { View } from 'react-native';

import { AVATAR_BOX, avatarArt, avatarStrokes, stonePaint } from './avatarArt';
import { color } from './theme';

const C = AVATAR_BOX / 2;
const CLIP = Skia.Path.Make();
CLIP.addCircle(C, C, C);

const path = (d: string) => Skia.Path.MakeFromSVGString(d) ?? Skia.Path.Make();

export function Avatar({ seed, size = 36 }: { seed: string; size?: number }) {
  const art = useMemo(() => avatarArt(seed), [seed]);
  const paths = useMemo(
    () => ({ spokes: path(art.spokes), territory: path(art.territory), trail: path(art.trail) }),
    [art],
  );
  const s = avatarStrokes(size);
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Canvas style={{ width: size, height: size }} pointerEvents="none">
        <Group transform={[{ scale: size / AVATAR_BOX }]} clip={CLIP}>
          <Rect x={0} y={0} width={AVATAR_BOX} height={AVATAR_BOX}>
            <RadialGradient
              c={vec(art.glow.cx, art.glow.cy)}
              r={art.glow.r}
              colors={[art.glow.inner, color.ink]}
            />
          </Rect>
          <Group
            style="stroke"
            strokeWidth={s.grid}
            color={color.lineStrong}
            opacity={s.gridOpacity}
          >
            {art.rings.map((r) => (
              <Circle key={r} cx={C} cy={C} r={r} />
            ))}
            <Path path={paths.spokes} />
          </Group>
          <Path
            path={paths.territory}
            style="stroke"
            strokeWidth={s.territory}
            strokeCap="round"
            color={art.accent}
            opacity={s.territoryOpacity}
          />
          <Path
            path={paths.trail}
            style="stroke"
            strokeWidth={s.trail}
            strokeCap="round"
            strokeJoin="round"
            color={art.accent}
            opacity={s.trailOpacity}
          />
          {art.stones.map((stone, i) => {
            const p = stonePaint(stone, art.accent, s);
            return (
              <Group key={i}>
                <Circle cx={stone.cx} cy={stone.cy} r={p.r} color={p.fill} />
                {p.stroke ? (
                  <Circle
                    cx={stone.cx}
                    cy={stone.cy}
                    r={p.r}
                    style="stroke"
                    strokeWidth={p.stroke.width}
                    color={p.stroke.color}
                  />
                ) : null}
              </Group>
            );
          })}
          <Circle
            cx={C}
            cy={C}
            r={C - s.rim / 2}
            style="stroke"
            strokeWidth={s.rim}
            color={color.lineStrong}
          />
        </Group>
      </Canvas>
    </View>
  );
}
