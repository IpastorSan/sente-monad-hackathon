/**
 * User avatars (SEN-172): your stone. An agent's face is a square corner of a
 * goban (`sigil.ts`); yours is the board wrapped into a circle — concentric
 * rings for lines, spokes for files — with a short game traced across it: the
 * white stone is you, where the game started, and the path walks from
 * intersection to neighbouring intersection, following a ring where it stays
 * on one. A glow in one of four accents sits behind it, so a face is told
 * apart at 30 px by its colour and at 120 px by its game.
 *
 * Deterministic from the seed (the signer address, or the address plus a
 * re-roll counter), so nothing is stored and every device draws the same one.
 * Pure, so it runs under plain node: `Avatar.tsx` only draws what this returns,
 * and `avatarSvg` renders the same shapes as an SVG string.
 *
 * Everything is in a 100-unit box centred on (50, 50), clipped to r = 50.
 */
import { color } from './palette.ts';
import { pick, seedStream } from './seed.ts';

export const AVATAR_BOX = 100;
const C = AVATAR_BOX / 2;

/** The accents a face may glow in. Index order is part of the algorithm: append only. */
export const AVATAR_ACCENTS = [color.purpleHi, color.mint, color.purpleSoft, color.berry] as const;

export type AvatarStone = {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  /** `key` is the white stone you start from; `solid` and `ring` are the moves after it. */
  readonly kind: 'key' | 'solid' | 'ring';
};

export type AvatarArt = {
  /** The face's accent, one of `AVATAR_ACCENTS`. */
  readonly accent: string;
  /** The radial glow behind the board: from `inner` at its centre to `color.ink`. */
  readonly glow: {
    readonly cx: number;
    readonly cy: number;
    readonly r: number;
    readonly inner: string;
  };
  /** Ring radii, innermost first. */
  readonly rings: readonly number[];
  /** SVG path data: the spokes, from the innermost ring to the outermost. */
  readonly spokes: string;
  /** SVG path data: a stretch of the outer ring held as territory, drawn wide and faint. */
  readonly territory: string;
  /** SVG path data: the game, stone to stone. */
  readonly trail: string;
  /** In play order: the key stone first. */
  readonly stones: readonly AvatarStone[];
};

type Node = { ring: number; spoke: number } | 'tengen';

const round = (n: number) => Math.round(n * 100) / 100;

/** `#rrggbb` mixed toward `toward` by `t` (0 = `from`, 1 = `toward`). Opaque, so every renderer reads it. */
export function mixHex(from: string, toward: string, t: number): string {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(toward.slice(1), 16);
  const channel = (shift: number) => {
    const x = (a >> shift) & 0xff;
    const y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * t);
  };
  const out = (channel(16) << 16) | (channel(8) << 8) | channel(0);
  return `#${out.toString(16).padStart(6, '0')}`;
}

export function avatarArt(seed: string): AvatarArt {
  const rand = seedStream(`avatar:${seed}`);

  const accent = AVATAR_ACCENTS[pick(rand, AVATAR_ACCENTS.length)]!;

  // The glow sits off-centre, so the light comes from somewhere.
  const glowAngle = rand() * Math.PI * 2;
  const glowDistance = 10 + rand() * 20;
  const glow = {
    cx: round(C + Math.cos(glowAngle) * glowDistance),
    cy: round(C + Math.sin(glowAngle) * glowDistance),
    r: round(58 + rand() * 18),
    inner: mixHex(color.board, accent, 0.26 + rand() * 0.12),
  };

  // The board: three or four rings, five to nine spokes at a seeded rotation.
  const ringCount = 3 + pick(rand, 2);
  const inner = ringCount === 3 ? 14 : 11;
  // Room for the key stone on the outer ring inside the rim.
  const outer = 38;
  const rings = Array.from({ length: ringCount }, (_, i) =>
    round(inner + ((outer - inner) * i) / (ringCount - 1)),
  );
  const spokeCount = 5 + pick(rand, 5);
  const rotation = rand() * Math.PI * 2;
  const angleOf = (spoke: number) => rotation + (spoke * Math.PI * 2) / spokeCount;
  const at = (node: Node) => {
    if (node === 'tengen') return { x: C, y: C };
    const a = angleOf(node.spoke);
    const r = rings[node.ring]!;
    return { x: C + Math.cos(a) * r, y: C + Math.sin(a) * r };
  };

  const spokes = Array.from({ length: spokeCount }, (_, s) => {
    const a = angleOf(s);
    const p = (r: number) => `${round(C + Math.cos(a) * r)} ${round(C + Math.sin(a) * r)}`;
    return `M${p(inner)}L${p(outer)}`;
  }).join('');

  // Territory: two or three spoke intervals of the outer ring.
  const from = pick(rand, spokeCount);
  const span = 2 + pick(rand, 2);
  const territory = arcPath(outer, angleOf(from), angleOf(from + span));

  // The game: a walk over neighbouring intersections, four to six stones.
  const length = 4 + pick(rand, 3);
  const key = (node: Node) => (node === 'tengen' ? 't' : `${node.ring}:${node.spoke}`);
  const visited = new Set<string>();
  const walk: Node[] = [];
  let here: Node =
    rand() < 0.12 ? 'tengen' : { ring: pick(rand, ringCount), spoke: pick(rand, spokeCount) };
  walk.push(here);
  visited.add(key(here));
  while (walk.length < length) {
    const options = neighbours(here, ringCount, spokeCount).filter((n) => !visited.has(key(n)));
    if (options.length === 0) break;
    here = options[pick(rand, options.length)]!;
    walk.push(here);
    visited.add(key(here));
  }

  let trail = '';
  walk.forEach((node, i) => {
    const p = at(node);
    if (i === 0) {
      trail += `M${round(p.x)} ${round(p.y)}`;
      return;
    }
    const prev = walk[i - 1]!;
    if (prev !== 'tengen' && node !== 'tengen' && prev.ring === node.ring) {
      // Along the ring, the short way round: the board's own line.
      trail += arcTo(rings[node.ring]!, angleOf(prev.spoke), angleOf(node.spoke));
    } else {
      trail += `L${round(p.x)} ${round(p.y)}`;
    }
  });

  const stones: AvatarStone[] = walk.map((node, i) => {
    const p = at(node);
    const last = i === walk.length - 1;
    const kind: AvatarStone['kind'] = i === 0 ? 'key' : last || i % 2 === 0 ? 'solid' : 'ring';
    const r = i === 0 ? 7.5 : last ? 5.5 : kind === 'ring' ? 3.9 : 3.6;
    return { cx: round(p.x), cy: round(p.y), r, kind };
  });

  return { accent, glow, rings, spokes, territory, trail, stones };
}

/** Intersections one step away: along the ring, across to the next ring, or to tengen. */
function neighbours(node: Node, ringCount: number, spokeCount: number): Node[] {
  if (node === 'tengen') {
    return Array.from({ length: spokeCount }, (_, spoke) => ({ ring: 0, spoke }));
  }
  const out: Node[] = [];
  const wrap = (s: number) => (s + spokeCount) % spokeCount;
  out.push({ ring: node.ring, spoke: wrap(node.spoke + 1) });
  out.push({ ring: node.ring, spoke: wrap(node.spoke - 1) });
  if (node.ring + 1 < ringCount) out.push({ ring: node.ring + 1, spoke: node.spoke });
  if (node.ring > 0) out.push({ ring: node.ring - 1, spoke: node.spoke });
  else out.push('tengen');
  return out;
}

/** An arc on the circle of radius `r`, from angle `a` to angle `b`, the short way. */
function arcTo(r: number, a: number, b: number): string {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  const end = a + delta;
  const sweep = delta >= 0 ? 1 : 0;
  return `A${r} ${r} 0 0 ${sweep} ${round(C + Math.cos(end) * r)} ${round(C + Math.sin(end) * r)}`;
}

/** A clockwise arc from `a` to `b` (b > a, less than a full turn) as a standalone path. */
function arcPath(r: number, a: number, b: number): string {
  const large = b - a > Math.PI ? 1 : 0;
  const x = (t: number) => round(C + Math.cos(t) * r);
  const y = (t: number) => round(C + Math.sin(t) * r);
  return `M${x(a)} ${y(a)}A${r} ${r} 0 ${large} 1 ${x(b)} ${y(b)}`;
}

export type AvatarStrokes = {
  readonly grid: number;
  readonly gridOpacity: number;
  readonly territory: number;
  readonly territoryOpacity: number;
  readonly trail: number;
  readonly trailOpacity: number;
  /** A hollow stone's ring. */
  readonly ring: number;
  readonly rim: number;
  /** Stones are drawn this much larger than `AvatarStone.r`. */
  readonly stoneScale: number;
};

/** Below this many px a face is a header chip: bolder lines, bigger stones. */
export const AVATAR_SMALL = 56;

/**
 * Stroke widths and opacities for a face drawn `size` px wide, shared by
 * `Avatar.tsx` and `avatarSvg` so the two renderings agree. In avatar units
 * (the 100 box): at 30 px a 1.3-unit line is 0.4 px and the game disappears,
 * so a small face draws its game heavier and its board fainter.
 */
export function avatarStrokes(size: number): AvatarStrokes {
  return size < AVATAR_SMALL
    ? {
        grid: 1.8,
        gridOpacity: 0.6,
        territory: 7,
        territoryOpacity: 0.4,
        trail: 4.2,
        trailOpacity: 0.95,
        ring: 3,
        rim: 2.5,
        stoneScale: 1.2,
      }
    : {
        grid: 1.3,
        gridOpacity: 0.9,
        territory: 5,
        territoryOpacity: 0.32,
        trail: 2.6,
        trailOpacity: 0.85,
        ring: 2.2,
        rim: 1.6,
        stoneScale: 1,
      };
}

/**
 * The same face as a standalone SVG document, `size` px square — for contexts
 * without Skia (a share card, an `<img>`, the tests). The ids are suffixed so
 * two avatars inlined on one page do not share a gradient.
 */
export function avatarSvg(seed: string, size = 96): string {
  const art = avatarArt(seed);
  const id = idSuffix(seed);
  const s = avatarStrokes(size);
  const stones = art.stones
    .map((stone) => {
      const r = round(stone.r * s.stoneScale);
      const at = `cx="${stone.cx}" cy="${stone.cy}" r="${r}"`;
      if (stone.kind === 'key') {
        return `<circle ${at} fill="${color.text}" stroke="${color.ink}" stroke-width="1.5"/>`;
      }
      if (stone.kind === 'ring') {
        return `<circle ${at} fill="${color.ink}" stroke="${art.accent}" stroke-width="${s.ring}"/>`;
      }
      return `<circle ${at} fill="${art.accent}"/>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${AVATAR_BOX} ${AVATAR_BOX}">` +
    `<defs>` +
    `<radialGradient id="g${id}" gradientUnits="userSpaceOnUse" cx="${art.glow.cx}" cy="${art.glow.cy}" r="${art.glow.r}">` +
    `<stop offset="0" stop-color="${art.glow.inner}"/><stop offset="1" stop-color="${color.ink}"/>` +
    `</radialGradient>` +
    `<clipPath id="c${id}"><circle cx="${C}" cy="${C}" r="${C}"/></clipPath>` +
    `</defs>` +
    `<g clip-path="url(#c${id})">` +
    `<rect width="${AVATAR_BOX}" height="${AVATAR_BOX}" fill="url(#g${id})"/>` +
    `<g fill="none" stroke="${color.lineStrong}" stroke-width="${s.grid}" opacity="${s.gridOpacity}">` +
    art.rings.map((r) => `<circle cx="${C}" cy="${C}" r="${r}"/>`).join('') +
    `<path d="${art.spokes}"/>` +
    `</g>` +
    `<path d="${art.territory}" fill="none" stroke="${art.accent}" stroke-width="${s.territory}" stroke-linecap="round" opacity="${s.territoryOpacity}"/>` +
    `<path d="${art.trail}" fill="none" stroke="${art.accent}" stroke-width="${s.trail}" stroke-linecap="round" stroke-linejoin="round" opacity="${s.trailOpacity}"/>` +
    stones +
    `<circle cx="${C}" cy="${C}" r="${C - s.rim / 2}" fill="none" stroke="${color.lineStrong}" stroke-width="${s.rim}"/>` +
    `</g></svg>`
  );
}

/** A short, id-safe tag for the seed, so inlined SVGs never collide on ids. */
function idSuffix(seed: string): string {
  return Math.floor(seedStream(`id:${seed}`)() * 2 ** 32).toString(36);
}
