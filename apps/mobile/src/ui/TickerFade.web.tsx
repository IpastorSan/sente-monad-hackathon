/**
 * Web twin of `TickerFade.tsx` (SEN-173): the same two edge fades as one CSS
 * gradient on a plain element, so the ticker costs no WebGL context
 * (`docs/web.md`).
 */
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
  const clear = `${background}00`;
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        pointerEvents: 'none',
        background: `linear-gradient(to right, ${background} 0px, ${clear} ${fade}px, ${clear} ${width - fade}px, ${background} ${width}px)`,
      }}
    />
  );
}
