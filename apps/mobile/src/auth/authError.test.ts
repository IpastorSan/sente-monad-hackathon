import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MeraError } from '@category-labs/mera';

import { describeAuthError } from './authError.ts';

/** What mera throws when `navigator.credentials` rejects (passkey.js wraps it). */
function wrapped(name: string, message: string, ceremony = 'Passkey creation failed'): MeraError {
  return new MeraError('PASSKEY_OPERATION_FAILED', ceremony, {
    cause: new DOMException(message, name),
  });
}

// Chrome's exact text, as measured on the SEN-165 harness.
const NOT_ALLOWED =
  'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.';

test('a dismissed or timed-out browser dialog reads as cancelled, not as a broken build', () => {
  for (const ceremony of ['Passkey creation failed', 'Passkey assertion failed']) {
    const described = describeAuthError(wrapped('NotAllowedError', NOT_ALLOWED, ceremony));
    assert.equal(described.code, 'PASSKEY_OPERATION_FAILED');
    assert.equal(described.title, 'Passkey cancelled');
    assert.doesNotMatch(described.detail, /assetlinks/);
  }
});

test('a page off the rpId says to open sente.lol', () => {
  const described = describeAuthError(
    wrapped(
      'SecurityError',
      'The relying party ID is not a registrable domain suffix of, nor equal to the current domain.',
      'Passkey assertion failed',
    ),
  );
  assert.equal(described.title, 'Passkeys only work on sente.lol');
  assert.match(described.detail, /https:\/\/sente\.lol/);
});

test('a provider without PRF keeps its own message on web too', () => {
  const described = describeAuthError(
    new MeraError('PRF_UNAVAILABLE', 'Authenticator did not enable PRF'),
  );
  assert.equal(described.title, 'This passkey cannot hold a wallet');
  assert.match(described.detail, /Google Password Manager/);
});

test("Android's native rejection (a plain object) still gets the platform's words", () => {
  const described = describeAuthError(
    new MeraError('PASSKEY_OPERATION_FAILED', 'Passkey creation failed', {
      cause: { error: 'UserCancelled', message: 'The user cancelled the request.' },
    }),
  );
  assert.equal(described.title, 'Passkey ceremony failed');
  assert.match(described.detail, /The user cancelled the request/);
});
