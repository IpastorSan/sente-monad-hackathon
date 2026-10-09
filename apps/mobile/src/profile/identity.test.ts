/** Defaults under overrides (SEN-172). Plain node. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { avatarSeedFor, avatarStepOf, identityOf, rolledName } from './identity.ts';
import { nameFor } from './names.ts';

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const LOWER = ADDRESS.toLowerCase();

test('no overrides: the name and face come from the address, case-insensitively', () => {
  const me = identityOf(ADDRESS, { name: null, avatarSeed: null });
  assert.deepEqual(me, {
    name: nameFor(LOWER),
    avatarSeed: LOWER,
    defaultName: true,
    defaultAvatar: true,
    avatarStep: 0,
  });
  assert.deepEqual(identityOf(LOWER, { name: null, avatarSeed: null }), me);
});

test('overrides win, and the face is per user', () => {
  const me = identityOf(ADDRESS, { name: 'Rekt Otter', avatarSeed: '3' });
  assert.equal(me.name, 'Rekt Otter');
  assert.equal(me.avatarSeed, `${LOWER}/3`);
  assert.equal(me.avatarStep, 3);
  assert.equal(me.defaultName, false);
  assert.equal(me.defaultAvatar, false);
  const other = identityOf('0x' + 'b'.repeat(40), { name: null, avatarSeed: '3' });
  assert.notEqual(other.avatarSeed, me.avatarSeed);
});

test('the re-roll counter round-trips, and 0 is the default', () => {
  assert.equal(avatarSeedFor(0), null);
  assert.equal(avatarSeedFor(-1), null);
  assert.equal(avatarSeedFor(4), '4');
  assert.equal(avatarStepOf('4'), 4);
  assert.equal(avatarStepOf(null), 0);
  // A seed some other client wrote is a face, not a step.
  assert.equal(avatarStepOf('abc'), 0);
  assert.equal(avatarStepOf('04'), 0);
  assert.equal(identityOf(ADDRESS, { name: null, avatarSeed: 'abc' }).avatarSeed, `${LOWER}/abc`);
});

test('a rolled name is generated, deterministic and never the current one', () => {
  const current = nameFor(LOWER);
  for (let n = 0; n < 20; n++) {
    const rolled = rolledName(ADDRESS, n, current);
    assert.notEqual(rolled, current);
    assert.equal(rolled, rolledName(ADDRESS, n, current));
    assert.match(rolled, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  }
});
