/** Generated names (SEN-172). Plain node. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NAME_ADJECTIVES, NAME_NOUNS, nameFor } from './names.ts';
import { nameProblem, NAME_MAX } from './rules.ts';

test('the same seed always gets the same name', () => {
  assert.equal(nameFor('0xabc'), nameFor('0xabc'));
});

test('pinned: a known address keeps its name (the lists are append-only)', () => {
  assert.equal(nameFor('0x70997970c51812dc3a010c7d01b50e0d17dc79c8'), 'Sharded Ronin');
});

test('different seeds spread across the lists', () => {
  const names = new Set(Array.from({ length: 500 }, (_, i) => nameFor(`0x${i.toString(16)}`)));
  // 2,304 combinations; 500 draws should collide only a little.
  assert.ok(names.size > 400, `only ${names.size} distinct names in 500`);
  const adjectives = new Set([...names].map((n) => n.split(' ')[0]));
  assert.ok(adjectives.size > NAME_ADJECTIVES.length * 0.9);
});

test('wordlists: at least 40 each, no duplicates, Title Case single words', () => {
  for (const list of [NAME_ADJECTIVES, NAME_NOUNS]) {
    assert.ok(list.length >= 40, `${list.length} words`);
    assert.equal(new Set(list).size, list.length, 'duplicate word');
    assert.equal(new Set(list.map((w) => w.toLowerCase())).size, list.length);
    for (const word of list) assert.match(word, /^[A-Z][a-z]+$/, word);
  }
});

test('every possible name passes the rules a chosen name must', () => {
  for (const adjective of NAME_ADJECTIVES) {
    for (const noun of NAME_NOUNS) {
      const name = `${adjective} ${noun}`;
      assert.equal(nameProblem(name), null, name);
      assert.ok(name.length <= NAME_MAX);
    }
  }
});

test('nothing on the deny list made it into the words', () => {
  const deny = /stone|high|baked|weed|dope|sex|nsfw|kill|nazi|slut|drunk|coke|acid|trip|cum/i;
  for (const word of [...NAME_ADJECTIVES, ...NAME_NOUNS]) assert.doesNotMatch(word, deny, word);
});
