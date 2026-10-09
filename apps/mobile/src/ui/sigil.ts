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
