/**
 * The icon set (SEN-55): 24-unit paths, 1.8 stroke, round caps — the same
 * glyphs as `docs/design/mockups.html`. Drawn with Skia, which the app already
 * ships for the consensus ramp, so icons add no native module and no font.
 * Stones stand in for agents; there are no robots.
 */
import { Canvas, Group, Path, Skia, type SkPath } from '@shopify/react-native-skia';

import { color as palette } from './theme';

const PATHS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  agents:
    'M12 9a4 4 0 1 1-8 0a4 4 0 1 1 8 0M20 9a4 4 0 1 1-8 0a4 4 0 1 1 8 0M16 16a4 4 0 1 1-8 0a4 4 0 1 1 8 0',
  board: 'M5 20v-8M12 20V4M19 20v-5',
  account: 'M16 8a4 4 0 1 1-8 0a4 4 0 1 1 8 0M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  close: 'M6 6l12 12M18 6L6 18',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  key: 'M12 15a4 4 0 1 1-8 0a4 4 0 1 1 8 0M11 12l9-9M16 7l3 3',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  check: 'M5 12l5 5 9-10',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  return: 'M9 14l-5-5 5-5M4 9h11a5 5 0 0 1 0 10h-3',
  stop: 'M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0M5.6 5.6l12.8 12.8',
  copy: 'M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
} as const;

export type IconName = keyof typeof PATHS;

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
