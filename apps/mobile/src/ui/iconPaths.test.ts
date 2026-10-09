/** The icon set's path data (SEN-173). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ICON_NAMES, PATHS } from './iconPaths.ts';

test('every icon name has path data both renderers can parse', () => {
  assert.ok(ICON_NAMES.length > 0);
  for (const name of ICON_NAMES) {
    const d = PATHS[name];
    assert.match(d, /^M/, `${name} starts with a moveto`);
    // Path commands, numbers and separators only: nothing either renderer would reject.
    assert.match(d, /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/, `${name} is plain path data`);
  }
});

test('the hide-balances pair differs only by the strike', () => {
  assert.equal(PATHS.balancesHidden, `${PATHS.balances}M4 4l16 16`);
});
