/**
 * The goban corner inside an agent's `Sigil` (SEN-55), drawn with Skia.
 *
 * Native only: the web build resolves `SigilBoard.web.tsx`, the same layout as
 * DOM SVG, because a roster of Skia canvases on web is a roster of WebGL
 * contexts (SEN-173, `docs/web.md`).
 */
import { Canvas, Circle, Group, Line, vec } from '@shopify/react-native-skia';

import { sigilBoard } from './sigil';
import { color } from './theme';

export function SigilBoard({ seed, size }: { seed: string; size: number }) {
  const { board, gridStroke, lines, stones } = sigilBoard(seed, size);
  return (
    <Canvas style={{ width: board, height: board }}>
      <Group color={color.lineStrong} style="stroke" strokeWidth={gridStroke}>
        {lines.map((l) => (
          <Line key={`${l.x1},${l.y1},${l.x2}`} p1={vec(l.x1, l.y1)} p2={vec(l.x2, l.y2)} />
        ))}
      </Group>
      {stones.map((stone) => (
        <Circle
          key={`${stone.cx},${stone.cy}`}
          cx={stone.cx}
          cy={stone.cy}
          r={stone.r}
          color={stone.tone === 'purple' ? color.purple : color.text}
        />
      ))}
    </Canvas>
  );
}
