/**
 * Agent sigils (SEN-55): every agent gets a 4×4 corner of a goban with its own
 * stones on it, derived from its id — so two agents never look alike, the same
 * agent looks the same on every screen and every phone, and there is no avatar
 * to generate, store or moderate.
 *
 * Pure so it runs under plain node: `Sigil.tsx` only draws what this returns.
 * The algorithm is the one `docs/design/sigil.js` renders in the mockups (the
 * FNV-1a + xorshift32 stream in `seed.ts`), so the mockups and the app agree on
 * every agent.
 */
import { seedStream } from './seed.ts';

export const SIGIL_LINES = 4;

export type SigilStone = {
  /** Intersection column and row, 0-based, `< SIGIL_LINES`. */
  readonly x: number;
  readonly y: number;
  /** Alternating from the first: the agent plays purple, then white. */
  readonly tone: 'purple' | 'white';
};

/** Three or four stones on distinct intersections, stable for a given seed. */
export function sigilStones(seed: string): SigilStone[] {
  const rand = seedStream(seed);
  const count = 3 + Math.floor(rand() * 2);
  const taken = new Set<string>();
  const stones: SigilStone[] = [];
  while (stones.length < count) {
    const x = Math.floor(rand() * SIGIL_LINES);
    const y = Math.floor(rand() * SIGIL_LINES);
    if (taken.has(`${x},${y}`)) continue;
    taken.add(`${x},${y}`);
    stones.push({ x, y, tone: stones.length % 2 === 0 ? 'purple' : 'white' });
  }
  return stones;
}

export type SigilBoardLayout = {
  /** The board's side: three quarters of the sigil's. */
  readonly board: number;
  readonly gridStroke: number;
  /** Each grid line, horizontal and vertical, in board coordinates. */
  readonly lines: readonly { x1: number; y1: number; x2: number; y2: number }[];
  readonly stones: readonly { cx: number; cy: number; r: number; tone: SigilStone['tone'] }[];
};

/**
 * Where a sigil of side `size` draws its grid and stones: what `SigilBoard.tsx`
 * (Skia, native) and `SigilBoard.web.tsx` (SVG, SEN-173) both paint.
 */
export function sigilBoard(seed: string, size: number): SigilBoardLayout {
  const board = size * 0.75;
  const edge = board * 0.12;
  const step = (board - edge * 2) / (SIGIL_LINES - 1);
  const at = (i: number) => edge + i * step;
  const lines = Array.from({ length: SIGIL_LINES }, (_, i) => at(i)).flatMap((p) => [
    { x1: edge, y1: p, x2: board - edge, y2: p },
    { x1: p, y1: edge, x2: p, y2: board - edge },
  ]);
  return {
    board,
    gridStroke: Math.max(1, board / 34),
    lines,
    stones: sigilStones(seed).map((stone) => ({
      cx: at(stone.x),
      cy: at(stone.y),
      r: step * 0.44,
      tone: stone.tone,
    })),
  };
}
