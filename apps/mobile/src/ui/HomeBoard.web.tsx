/**
 * Web twin of `HomeBoard.tsx` (SEN-191): "the board, fading out" — a 19-line
 * goban grid (cells `CELL`px, lines `rgba(64,56,106,.55)`) with its star
 * points (every 6th intersection, `rgba(168,152,255,.55)`, ~2.2px radius),
 * masked by a radial gradient strongest at the top right and fading to clear
 * by 85%. A plain positioned `div`, not a canvas (SEN-173, `docs/web.md`):
 * CSS background layers and `mask-image`, nothing react-native-web needs to
 * resolve through a style object with camelCase keys (the same trick as
 * `TickerFade.web.tsx` and `ConsensusTrack.web.tsx`).
 *
 * `zIndex: -1` so it paints behind its siblings instead of above them:
 * react-native-web otherwise stacks a `position: absolute`, `z-index: auto`
 * element above normal-flow content regardless of DOM order. Its parent (the
 * board wrapper in `index.tsx`) sets `position: relative, zIndex: 0` so that
 * negative index is contained there, not escaped behind the screen's own ink
 * ground.
 *
 * Height is fixed rather than filling its wrapper: the wrapper sizes to the
 * header alone, and this overflows into the hero below it (allowed —
 * `overflow` is never set to `hidden` on the wrapper), far enough that the
 * mask has already faded to clear before the total-value figure, never
 * lowering its contrast.
 */
const CELL = 44;
const STAR = CELL * 6;
const HEIGHT = 520;

export function HomeBoard() {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: HEIGHT,
        zIndex: -1,
        pointerEvents: 'none',
        backgroundImage: [
          'radial-gradient(circle, rgba(168,152,255,.55) 0 2.2px, transparent 3px)',
          'linear-gradient(rgba(64,56,106,.55) 1px, transparent 1px)',
          'linear-gradient(90deg, rgba(64,56,106,.55) 1px, transparent 1px)',
        ].join(', '),
        backgroundSize: `${STAR}px ${STAR}px, ${CELL}px ${CELL}px, ${CELL}px ${CELL}px`,
        backgroundPosition: `${STAR / 2}px ${STAR / 2}px, 0 0, 0 0`,
        WebkitMaskImage:
          'radial-gradient(ellipse 75% 70% at 70% 30%, #000 0%, rgba(0,0,0,.45) 45%, transparent 85%)',
        maskImage:
          'radial-gradient(ellipse 75% 70% at 70% 30%, #000 0%, rgba(0,0,0,.45) 45%, transparent 85%)',
        opacity: 0.55,
      }}
    />
  );
}
