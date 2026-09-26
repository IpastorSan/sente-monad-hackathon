/**
 * Agent sigils (SEN-55): every agent gets a 4×4 corner of a goban with its own
 * stones on it, derived from its id — so two agents never look alike, the same
 * agent looks the same on every screen and every phone, and there is no avatar
 * to generate, store or moderate.
 *
 * Pure so it runs under plain node: `Sigil.tsx` only draws what this returns.
 * The algorithm is the one `docs/design/sigil.js` renders in the mockups (FNV-1a
 * seed, xorshift32 stream), so the mockups and the app agree on every agent.
 */

export const SIGIL_LINES = 4;

export type SigilStone = {
  /** Intersection column and row, 0-based, `< SIGIL_LINES`. */
  readonly x: number;
  readonly y: number;
  /** Alternating from the first: the agent plays purple, then white. */
  readonly tone: 'purple' | 'white';
};

function stream(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
}

/** Three or four stones on distinct intersections, stable for a given seed. */
export function sigilStones(seed: string): SigilStone[] {
  const rand = stream(seed);
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
