/** The landing's copy (SEN-196): every link reaches a real anchor. Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAnchor } from '../howItWorks/content.ts';
import { ICON_NAMES } from '../ui/iconPaths.ts';
import { howItWorksHref, POINTS, showcaseAgentHref, STEPS } from './landing.ts';

test('every point and step links to an anchor /how-it-works has', () => {
  for (const { anchor } of [...POINTS, ...STEPS]) {
    assert.notEqual(resolveAnchor(anchor), null, `unknown anchor #${anchor}`);
  }
});

test('points use real icons', () => {
  for (const { icon } of POINTS) assert.ok(ICON_NAMES.includes(icon), icon);
});

test('three points and three steps', () => {
  assert.equal(POINTS.length, 3);
  assert.equal(STEPS.length, 3);
});

test('howItWorksHref', () => {
  assert.equal(howItWorksHref('mandate'), '/how-it-works#mandate');
});

test('showcaseAgentHref: hidden when unset or blank', () => {
  assert.equal(showcaseAgentHref(undefined), null);
  assert.equal(showcaseAgentHref(null), null);
  assert.equal(showcaseAgentHref(''), null);
  assert.equal(showcaseAgentHref('   '), null);
});

test('showcaseAgentHref: a plain id becomes its public page', () => {
  assert.equal(showcaseAgentHref('agt_9f2c-1'), '/a/agt_9f2c-1');
  assert.equal(showcaseAgentHref('  abc  '), '/a/abc');
});

test('showcaseAgentHref: anything that is not an id is refused', () => {
  for (const bad of ['../account', 'a/b', 'https://evil.example', 'id?x=1', 'x'.repeat(129)]) {
    assert.equal(showcaseAgentHref(bad), null, bad);
  }
});
