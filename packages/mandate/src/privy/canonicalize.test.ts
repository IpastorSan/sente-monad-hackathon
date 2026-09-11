// Ported from turnstile's `buyer/org/org.test.ts`, canonicalization section.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalize } from './canonicalize.ts';

test('canonicalize sorts object keys, as RFC 8785 requires', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(
    canonicalize({ url: 'u', method: 'POST', body: { z: 1, a: 2 } }),
    '{"body":{"a":2,"z":1},"method":"POST","url":"u"}',
  );
});

test('canonicalize drops undefined members and emits no whitespace', () => {
  assert.equal(canonicalize({ a: 1, b: undefined, c: 'x' }), '{"a":1,"c":"x"}');
  assert.equal(canonicalize([1, 'two', true, null]), '[1,"two",true,null]');
});

test('canonicalize refuses a non-integer rather than serializing it wrong', () => {
  // RFC 8785 mandates ECMAScript Number::toString for these. Half-implementing
  // it would produce a signature that fails at Privy with no local symptom, so
  // the failure belongs here instead.
  assert.throws(() => canonicalize({ price: 0.35 }), /only safe integers/);
});

test('canonicalize refuses a bigint — a policy body must carry uints as hex strings', () => {
  assert.throws(() => canonicalize({ cap: 1n }), /unsupported value of type bigint/);
});
