/**
 * Home's background board (SEN-191): "the board, fading out" — a faint goban
 * grid and star points behind the header and hero, strongest top right and
 * fading out before it reaches the total-value figure.
 *
 * Native only: the web build resolves `HomeBoard.web.tsx`, the same board as
 * a DOM background rather than a Skia canvas (SEN-173, `docs/web.md`).
 * Android has no `react-native-svg` dependency, and adding one would
 * invalidate the installed dev client APK (CLAUDE.md, gotcha 5) for a
 * decoration, so native renders nothing.
 */
export function HomeBoard() {
  return null;
}
