/** The perp ticket's rules (SEN-120). Plain node. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluatePerpTicket,
  leverageChoices,
  perplFreeAusd,
  setupCta,
  setupSteps,
  type PerpTicketInput,
} from './perpTicket.ts';

const BTC = { symbol: 'BTC-PERP', base: 'BTC', stepSize: '0.00001', maxLeverage: 20 };

const input = (over: Partial<PerpTicketInput> = {}): PerpTicketInput => ({
  market: BTC,
  side: 'long',
  value: '',
  leverage: 2,
  mark: '82947.4',
  available: null,
  ...over,
});

test('leverage chips stop at the market maximum, and include it', () => {
  assert.deepEqual(leverageChoices(20), [1, 2, 3, 5, 10, 20]);
  assert.deepEqual(leverageChoices(12.5), [1, 2, 3, 5, 10, 12.5]);
  assert.deepEqual(leverageChoices(1), [1]);
  assert.deepEqual(leverageChoices(null), [1], 'no maximum: only what cannot exceed one');
});

test('the SEN-82 live order: 41.47 AUSD at 2x is 0.0005 BTC and ≈ 20.74 margin', () => {
  // 0.0005 BTC at 82,947.4 is 41.4737; type a touch more and the size floors to the step.
  const t = evaluatePerpTicket(input({ value: '41.48' }));
  assert.equal(t.size, '0.0005');
  assert.equal(t.notional, '41.47');
  assert.equal(t.margin, '20.74');
  assert.equal(t.cta.enabled, true);
  assert.equal(t.cta.label, 'Review long');
  assert.match(t.sub ?? '', /0\.0005 BTC · 20\.74 AUSD margin/);
});

test('the size never exceeds what was typed', () => {
  const t = evaluatePerpTicket(input({ value: '100' }));
  assert.ok(Number(t.size) * 82947.4 <= 100);
  assert.ok(Number(t.size) * 82947.4 > 100 - 82947.4 * 0.00001);
});

test('nothing to send: no price, no amount, under one step', () => {
  assert.equal(evaluatePerpTicket(input({ mark: null, value: '50' })).cta.enabled, false);
  assert.equal(evaluatePerpTicket(input({ value: '' })).cta.label, 'Enter an amount to long');
  assert.equal(
    evaluatePerpTicket(input({ side: 'short', value: '0' })).cta.label,
    'Enter an amount to short',
  );
  const tiny = evaluatePerpTicket(input({ value: '0.5' }));
  assert.equal(tiny.cta.enabled, false);
  assert.match(tiny.sub ?? '', /smallest BTC order is 0\.00001/);
});

test('margin above what Perpl holds free is refused before review', () => {
  const t = evaluatePerpTicket(input({ value: '1000', leverage: 2, available: '100' }));
  assert.equal(t.short, true);
  assert.equal(t.cta.enabled, false);
  assert.equal(
    evaluatePerpTicket(input({ value: '1000', leverage: 20, available: '100' })).cta.enabled,
    true,
  );
});

test('free AUSD comes from the Perpl section’s balances', () => {
  assert.equal(perplFreeAusd([{ asset: 'AUSD', available: '79.26' }]), '79.26');
  assert.equal(perplFreeAusd([]), null);
  assert.equal(perplFreeAusd(undefined), null);
});

test('setup steps follow what the account needs, never a second account', () => {
  const keys = (needs: Parameters<typeof setupSteps>[0]) =>
    setupSteps(needs, '100').map((s) => s.key);
  assert.deepEqual(keys({ open: true, forwarding: false, enroll: true }), [
    'perpl.approve',
    'perpl.createAccount',
    'perpl.allowForwarding',
    'enroll',
  ]);
  assert.deepEqual(keys({ open: false, forwarding: true, enroll: true }), [
    'perpl.allowForwarding',
    'enroll',
  ]);
  assert.deepEqual(keys({ open: false, forwarding: false, enroll: true }), ['enroll']);
  assert.equal(
    setupCta({ open: true, forwarding: false, enroll: true }, '250'),
    'Open account with 250 AUSD',
  );
  assert.equal(
    setupCta({ open: false, forwarding: false, enroll: true }, '100'),
    'Add trading key',
  );
});
