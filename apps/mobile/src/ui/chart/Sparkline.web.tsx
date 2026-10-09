/**
 * Web twin of `Sparkline.tsx` (SEN-173): the same model, line and dot, drawn
 * as DOM SVG. A market list is a column of sparklines, and as Skia canvases
 * each one was a WebGL context — Chrome keeps ~16 per page (`docs/web.md`).
 */
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
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      focusable={false}
      style={SVG_STYLE}
    >
      {model !== null ? (
        <>
          <path
            d={model.path}
            fill="none"
            stroke={tone}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <circle cx={model.end.x} cy={model.end.y} r={2.5} fill={tone} />
        </>
      ) : null}
    </svg>
  );
}

const SVG_STYLE = { display: 'block', flexShrink: 0 } as const;
