/**
 * The market row's sparkline (SEN-107): 64×28, a 1.5 px line with a dot on
 * the last price, mint if the series is up and berry if it is down. chart.js's
 * `type: "spark"`: no gradient, no pill, no levels, no scrub.
 *
 * `up` overrides the sign when the row already knows it (the 24h change beside
 * the line), so the colour and the number next to it can never disagree.
 *
 * Native only: the web build resolves `Sparkline.web.tsx`, the same model as
 * DOM SVG, because a list of Skia canvases on web is a list of WebGL contexts
 * (SEN-173, `docs/web.md`).
 */
import { Canvas, Circle, Path } from '@shopify/react-native-skia';
import { useMemo } from 'react';

import { color } from '../theme';
import { sparklineModel, type Decimal } from './geometry';

export function Sparkline({
  points,
  up,
  width = 64,
  height = 28,
}: {
  /** Closes, oldest first. */
  points: readonly Decimal[];
  up?: boolean;
  width?: number;
  height?: number;
}) {
  const model = useMemo(() => sparklineModel(points, width, height), [points, width, height]);
  const tone = (up ?? model?.rising ?? true) ? color.mint : color.berry;

  return (
    <Canvas style={{ width, height }} accessibilityElementsHidden>
      {model !== null ? (
        <>
          <Path
            path={model.path}
            color={tone}
            style="stroke"
            strokeWidth={1.5}
            strokeJoin="round"
            strokeCap="round"
          />
          <Circle cx={model.end.x} cy={model.end.y} r={2.5} color={tone} />
        </>
      ) : null}
    </Canvas>
  );
}
