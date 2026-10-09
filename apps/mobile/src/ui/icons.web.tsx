/**
 * Web twin of `icons.tsx` (SEN-173): the same paths, stroke, caps and joins,
 * drawn as DOM SVG instead of a Skia `<Canvas>`.
 *
 * On web every Skia canvas is its own WebGL context, and Chrome keeps only ~16
 * per page — past that it drops the oldest, and those canvases turn into
 * broken-image placeholders. A desktop Home (rail, header, buttons, sparklines)
 * mounts far more icons than that, so on web icons never touch WebGL.
 */
import { PATHS, type IconName } from './iconPaths';
import { color as palette } from './theme';

export type { IconName };

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
  // The viewBox scales the stroke with the glyph, as the native Group's scale does.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      style={SVG_STYLE}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** A block box that keeps its size in a row and never takes a touch, as the native canvas. */
const SVG_STYLE = { display: 'block', flexShrink: 0, pointerEvents: 'none' } as const;
