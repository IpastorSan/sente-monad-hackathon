/**
 * The ticker marquee's edge fades (SEN-108): `fade` px of the screen's ground
 * at each end, fading to clear, laid over the sliding row.
 *
 * Native only: the web build resolves `TickerFade.web.tsx`, a CSS gradient,
 * because a Skia canvas on web is a WebGL context (SEN-173, `docs/web.md`).
 */
import { Canvas, LinearGradient, Rect, vec } from '@shopify/react-native-skia';

export function TickerFade({
  width,
  height,
  fade,
  background,
}: {
  width: number;
  height: number;
  fade: number;
  /** `#RRGGBB`; an alpha byte is appended for the clear end. */
  background: string;
}) {
  return (
    <Canvas style={{ position: 'absolute', top: 0, left: 0, width, height }} pointerEvents="none">
      <Rect x={0} y={0} width={fade} height={height}>
        <LinearGradient
          start={vec(0, 0)}
          end={vec(fade, 0)}
          colors={[background, `${background}00`]}
        />
      </Rect>
      <Rect x={width - fade} y={0} width={fade} height={height}>
        <LinearGradient
          start={vec(width - fade, 0)}
          end={vec(width, 0)}
          colors={[`${background}00`, background]}
        />
      </Rect>
    </Canvas>
  );
}
