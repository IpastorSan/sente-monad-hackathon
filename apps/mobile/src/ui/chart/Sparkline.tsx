/**
 * The market row's sparkline (SEN-107): 64×28, a 1.5 px line with a dot on
 * the last price, mint if the series is up and berry if it is down. chart.js's
 * `type: "spark"`: no gradient, no pill, no levels, no scrub.
 *
 * `up` overrides the sign when the row already knows it (the 24h change beside
 * the line), so the colour and the number next to it can never disagree.
 */
import { Canvas, Circle, Path } from '@shopify/react-native-skia';
import { useMemo } from 'react';

import { color } from '../theme';
import { isUp, linePath, pointsXY, scaleFor, toPrice, type Decimal } from './geometry';

const PAD = 3;
/** Room on the right for the end dot. */
const PAD_RIGHT = 4;

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
  const model = useMemo(() => {
    const closes = points.map(toPrice);
    if (closes.length === 0) return null;
    const scale = scaleFor(closes, [], { height, padTop: PAD, padBottom: PAD });
    const plotWidth = width - PAD_RIGHT;
    const xy = pointsXY(closes, scale, plotWidth);
    return {
      rising: isUp(closes[0] ?? 0, closes[closes.length - 1] ?? 0),
      path: linePath(closes, scale, plotWidth),
      end: xy[xy.length - 1] ?? { x: plotWidth, y: height / 2 },
    };
  }, [points, width, height]);

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
