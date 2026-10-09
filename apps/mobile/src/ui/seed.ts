/**
 * The one seeded random stream every generated face in the app draws from:
 * agent sigils (`sigil.ts`), user avatars (`avatarArt.ts`) and generated names
 * (`profile/names.ts`). FNV-1a over the seed's UTF-16 code units, then
 * xorshift32 — the same stream `docs/design/sigil.js` renders in the mockups,
 * so changing a single operator here changes every agent's face on every
 * phone. Pure, so the specs run under plain node.
 */

/** A stream of floats in `[0, 1)`, the same sequence for the same seed, forever. */
export function seedStream(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
}

/** An integer in `[0, n)` drawn from `rand`. */
export function pick(rand: () => number, n: number): number {
  return Math.floor(rand() * n);
}
