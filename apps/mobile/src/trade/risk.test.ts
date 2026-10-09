/** The first-trade risk disclosure (SEN-179). Plain node. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PERP_MAX_SLIPPAGE } from './perpTicket.ts';
import { HOW_THE_RELAY_WORKS, riskAckKey, riskPoints, riskTitle } from './risk.ts';

const keys = (venue: 'kuru' | 'perpl', web: boolean) => riskPoints(venue, web).map((p) => p.key);

test('spot says loss, slippage and partial fills, no stops, testnet', () => {
  assert.deepEqual(keys('kuru', true), ['loss', 'market', 'stops', 'testnet']);
  assert.deepEqual(keys('kuru', false), keys('kuru', true), 'no relay on spot, web or not');
  assert.equal(riskTitle('kuru'), 'Before your first spot trade');
});

test('perps add leverage and liquidation, and the relay only in the browser', () => {
  assert.deepEqual(keys('perpl', false), ['loss', 'leverage', 'market', 'stops', 'testnet']);
  assert.deepEqual(keys('perpl', true), [
    'loss',
    'leverage',
    'market',
    'relay',
    'stops',
    'testnet',
  ]);
  const relay = riskPoints('perpl', true).find((p) => p.key === 'relay');
  assert.equal(relay?.link?.href, HOW_THE_RELAY_WORKS);
  assert.match(relay?.text ?? '', /can’t withdraw/);
});

test('the perp market-order bound it states is the one the ticket sends', () => {
  const market = riskPoints('perpl', false).find((p) => p.key === 'market');
  assert.equal(PERP_MAX_SLIPPAGE, '0.01');
  assert.match(market?.text ?? '', /up to 1% away from the mark/);
});

test('an acknowledgement is per venue and per wallet, in a kv-safe key', () => {
  const wallet = '0x0d46fB9bD65FF35604cD654Cf98C5bb6ac75cdaF';
  assert.equal(riskAckKey('kuru', wallet), `sente.riskAck.v1.kuru.${wallet.toLowerCase()}`);
  assert.notEqual(riskAckKey('kuru', wallet), riskAckKey('perpl', wallet));
  assert.match(riskAckKey('perpl', wallet), /^[A-Za-z0-9._-]+$/);
});
