/**
 * Pins the permanent auth constants. Runs under plain node, like `derive.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RP_ID } from './constants.ts';

test('RP_ID is pinned to sente.lol', () => {
  // SEN-138: the rpId is an input to every PRF output and so to every wallet
  // address (CLAUDE.md, "Permanent, unchangeable values"). A rename compiles,
  // passes every other test, and strands every existing account. There is no
  // legitimate reason to update this assertion.
  assert.equal(RP_ID, 'sente.lol');
});
