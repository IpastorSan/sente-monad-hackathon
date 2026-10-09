/** The Portfolio hero's recorded line (SEN-152). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HERO_RANGES, heroLine, rangeQuery, type ValueHistory } from './history.ts';

const HOUR = 3_600_000;
const T = Date.UTC(2026, 8, 3, 12);

function history(
  points: ValueHistory['points'],
  range: ValueHistory['range'] = '1d',
): ValueHistory {
  return { range, asOf: T + 3 * HOUR, from: T, points, partial: false, everyMs: HOUR, note: '' };
}

test('the pills are the design’s, and each asks for its own range', () => {
  assert.deepEqual([...HERO_RANGES], ['1D', '1W', '1M', 'ALL']);
  assert.deepEqual(HERO_RANGES.map(rangeQuery), ['1d', '1w', '1m', 'all']);
});

test('no recorded point yet: no line, so the hero keeps “since you opened”', () => {
  assert.equal(heroLine(null, '1D', { at: T, usd: '1' }), null);
  assert.equal(heroLine(history([]), '1D', { at: T, usd: '1' }), null);
});

test('the recorded points end at the live total, and the change is exact', () => {
  const line = heroLine(
    history([
      { at: T, usd: '100' },
      { at: T + HOUR, usd: '101.5' },
    ]),
    '1D',
    { at: T + 2 * HOUR, usd: '102.25' },
  );
  assert.ok(line);
  assert.deepEqual(
    line.points.map((p) => p.usd),
    ['100', '101.5', '102.25'],
  );
  assert.equal(line.change?.delta, '2.25');
  assert.equal(line.change?.tone, 'up');
  assert.equal(line.suffix, ' today');
  assert.equal(line.partial, false);
});

test('the line always ends at the live total, even when a recorded point is newer (SEN-179)', () => {
  // A snapshot taken from an older cached read must not stand in for the
  // number on screen: the change line would disagree with the total.
  const line = heroLine(
    history([
      { at: T, usd: '10' },
      { at: T + HOUR, usd: '9' },
    ]),
    '1W',
    { at: T + HOUR - 1, usd: '50' },
  );
  assert.deepEqual(
    line?.points.map((p) => p.usd),
    ['10', '50'],
  );
  assert.equal(line?.change?.tone, 'up');
  assert.equal(line?.suffix, ' this week');
});

test('one recorded point plus the live total is already a line', () => {
  const line = heroLine(history([{ at: T, usd: '10' }], 'all'), 'ALL', { at: T + HOUR, usd: '11' });
  assert.equal(line?.points.length, 2);
  assert.equal(line?.suffix, ' since Sep 3');
});

test('a partial point is said, not hidden', () => {
  const line = heroLine(
    history([
      { at: T, usd: '10', partial: true },
      { at: T + HOUR, usd: '12' },
    ]),
    '1M',
    null,
  );
  assert.equal(line?.partial, true);
  assert.equal(line?.suffix, ' this month');
});
