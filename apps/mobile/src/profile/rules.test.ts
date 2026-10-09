/**
 * The app's name rules against the API's (SEN-172): the field must not accept
 * what `PATCH /profile` refuses, or refuse what it accepts. The API file is
 * loaded by relative path, like `trade/contract.test.ts` does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as api from '../../../../services/api/src/profile/profile-rules.ts';
import * as app from './rules.ts';

const CASES = [
  'Based Whale',
  '  Based   Whale  ',
  'a',
  'ab',
  'x'.repeat(24),
  'x'.repeat(25),
  'Ñandú Veloz',
  '先手',
  "O'Brien",
  'Ape_Lord.eth',
  '-Based',
  '.dot',
  'Based <Whale>',
  'Based​Whale',
  'Based\tWhale',
  'emoji 🐋',
  '',
  '   ',
  '42',
];

test('the same limits', () => {
  assert.equal(app.NAME_MIN, api.NAME_MIN);
  assert.equal(app.NAME_MAX, api.NAME_MAX);
  assert.equal(app.AVATAR_SEED_PATTERN.source, api.AVATAR_SEED_PATTERN.source);
});

test('the same verdict on every case, after the same normalising', () => {
  for (const raw of CASES) {
    const a = app.normalizeName(raw);
    assert.equal(a, api.normalizeName(raw), raw);
    assert.equal(app.nameProblem(a), api.nameProblem(a), raw);
  }
});

test('a few verdicts, spelled out', () => {
  const ok = (raw: string) => app.nameProblem(app.normalizeName(raw)) === null;
  assert.equal(app.normalizeName('  Based   Whale  '), 'Based Whale');
  assert.ok(ok('Based Whale'));
  assert.ok(ok('Ñandú Veloz'));
  assert.ok(!ok('a'));
  assert.ok(!ok('x'.repeat(25)));
  assert.ok(!ok('Based <Whale>'));
  assert.ok(!ok('Based​Whale'));
  assert.ok(!ok('emoji 🐋'));
});
