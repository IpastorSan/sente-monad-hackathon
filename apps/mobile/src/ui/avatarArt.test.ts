/** User avatars (SEN-172). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AVATAR_ACCENTS, AVATAR_BOX, avatarArt, avatarSvg, mixHex } from './avatarArt.ts';
import { seedStream } from './seed.ts';
import { sigilStones } from './sigil.ts';

const addresses = Array.from(
  { length: 400 },
  (_, i) => `0x${i.toString(16).padStart(4, '0')}${'9f'.repeat(18)}`,
);

test('the same seed always draws the same face', () => {
  const seed = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
  assert.deepEqual(avatarArt(seed), avatarArt(seed));
  assert.equal(avatarSvg(seed), avatarSvg(seed));
});

test('pinned: a known address keeps its face (the algorithm is append-only)', () => {
  const art = avatarArt('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
  // Recorded on first run. A change here re-faces every user who never re-rolled.
  assert.deepEqual(
    { accent: art.accent, rings: art.rings.length, stones: art.stones.length, trail: art.trail },
    {
      accent: '#5FE3B3',
      rings: 3,
      stones: 4,
      trail: 'M75.98 51.1A26 26 0 0 0 69.14 32.41A26 26 0 0 0 51.1 24.02L50.59 36.01',
    },
  );
});

test('every face in a crowd is different, and the accents are all used', () => {
  const games = new Set(addresses.map((a) => avatarArt(a).trail));
  assert.equal(games.size, addresses.length);
  const accents = new Set(addresses.map((a) => avatarArt(a).accent));
  assert.deepEqual([...accents].sort(), [...AVATAR_ACCENTS].sort());
});

test('a re-roll is a different face', () => {
  const a = addresses[0]!;
  const faces = new Set([a, `${a}/1`, `${a}/2`, `${a}/3`].map((s) => avatarSvg(s)));
  assert.equal(faces.size, 4);
});

test('three to six stones, key stone first, all inside the circle', () => {
  for (const seed of addresses.slice(0, 120)) {
    const { stones } = avatarArt(seed);
    assert.ok(stones.length >= 3 && stones.length <= 6, `${seed}: ${stones.length}`);
    assert.equal(stones[0]!.kind, 'key');
    assert.equal(stones.filter((s) => s.kind === 'key').length, 1);
    const at = new Set(stones.map((s) => `${s.cx},${s.cy}`));
    assert.equal(at.size, stones.length, 'no two stones on one intersection');
    for (const s of stones) {
      const d = Math.hypot(s.cx - AVATAR_BOX / 2, s.cy - AVATAR_BOX / 2);
      assert.ok(d + s.r * 1.2 < AVATAR_BOX / 2, `${seed}: stone at ${d} pokes out`);
    }
  }
});

test('the path data is well-formed SVG: commands and finite numbers only', () => {
  for (const seed of addresses.slice(0, 50)) {
    const art = avatarArt(seed);
    for (const d of [art.spokes, art.territory, art.trail]) {
      assert.match(d, /^M[-\d. ]+([MLA][-\d. ]+)*$/);
      assert.ok(!d.includes('NaN') && !d.includes('Infinity'));
    }
  }
});

test('avatarSvg is a standalone, clipped SVG at the asked size, with unique ids', () => {
  const svg = avatarSvg(addresses[1]!, 64);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="64" height="64"/);
  assert.match(svg, /<clipPath id="c[0-9a-z]+">/);
  assert.match(svg, /<\/svg>$/);
  const id = (s: string) => /<clipPath id="(c[0-9a-z]+)"/.exec(s)![1];
  assert.notEqual(id(svg), id(avatarSvg(addresses[2]!, 64)));
});

test('a face is not an agent sigil: different streams for the same seed', () => {
  // Sigils and avatars both seed from ids; an avatar never reuses the sigil's draw.
  const seed = 'range-hunter';
  assert.notEqual(seedStream(seed)(), seedStream(`avatar:${seed}`)());
  assert.ok(sigilStones(seed).length <= 4);
});

test('mixHex mixes channel by channel', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixHex('#102030', '#102030', 0.3), '#102030');
});
