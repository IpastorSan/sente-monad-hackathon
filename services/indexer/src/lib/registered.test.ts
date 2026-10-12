/** `AccountRegistered` on both Kuru deployments (SEN-189). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registeredAddresses } from './registered.ts';

test('Set D: the root owner is both the address and the owner', () => {
  assert.deepEqual(registeredAddresses({ rootOwner: '0xAa' }), { address: '0xAa', owner: '0xAa' });
});

test('Set C: `account` is the address and `owner` is stored apart', () => {
  assert.deepEqual(registeredAddresses({ account: '0xAa', owner: '0xBb' }), {
    address: '0xAa',
    owner: '0xBb',
  });
});
