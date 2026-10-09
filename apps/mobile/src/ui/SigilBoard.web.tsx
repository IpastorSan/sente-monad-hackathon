/**
 * Web twin of `SigilBoard.tsx` (SEN-173): the same grid and stones as DOM SVG,
 * so an agent list does not spend one WebGL context per row (`docs/web.md`).
 */
import { sigilBoard } from './sigil';
import { color } from './theme';

export function SigilBoard({ seed, size }: { seed: string; size: number }) {
  const { board, gridStroke, lines, stones } = sigilBoard(seed, size);
  return (
    <svg
      width={board}
      height={board}
      viewBox={`0 0 ${board} ${board}`}
      aria-hidden
      focusable={false}
      style={SVG_STYLE}
    >
      <g stroke={color.lineStrong} strokeWidth={gridStroke}>
        {lines.map((l) => (
          <line key={`${l.x1},${l.y1},${l.x2}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
        ))}
      </g>
      {stones.map((stone) => (
        <circle
          key={`${stone.cx},${stone.cy}`}
          cx={stone.cx}
          cy={stone.cy}
          r={stone.r}
          fill={stone.tone === 'purple' ? color.purple : color.text}
        />
      ))}
    </svg>
  );
}

const SVG_STYLE = { display: 'block', flexShrink: 0 } as const;
