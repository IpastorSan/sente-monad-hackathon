/**
 * The icon set (SEN-55): 24-unit paths, 1.8 stroke, round caps — the same
 * glyphs as `docs/design/mockups.html`. Drawn with Skia, which the app already
 * ships for the consensus ramp, so icons add no native module and no font.
 * Stones stand in for agents; there are no robots.
 *
 * Native only: the web build resolves `icons.web.tsx`, which draws the same
 * paths as DOM SVG, because every Skia `<Canvas>` on web is a WebGL context
 * and a page of icons ran Chrome out of them (SEN-173, `docs/web.md`).
 */
import { Canvas, Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';

import { PATHS, type IconName } from './iconPaths';
import { color as palette } from './theme';

export type { IconName };

const cache = new Map<IconName, SkPath>();

function pathFor(name: IconName): SkPath {
  let path = cache.get(name);
  if (!path) {
    path = Skia.Path.MakeFromSVGString(PATHS[name]) ?? Skia.Path.Make();
    cache.set(name, path);
  }
  return path;
}

export function Icon({
  name,
  size = 20,
  color = palette.textDim,
  strokeWidth = 1.8,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  return (
    <Canvas style={{ width: size, height: size }} pointerEvents="none">
      <Group transform={[{ scale: size / 24 }]}>
        <Path
          path={pathFor(name)}
          style="stroke"
          strokeWidth={strokeWidth}
          strokeCap="round"
          strokeJoin="round"
          color={color}
        />
      </Group>
    </Canvas>
  );
}
