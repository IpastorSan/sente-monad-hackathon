/** The perp ticket's rules (SEN-120). Plain node. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkPerpLimit,
  evaluatePerpTicket,
  leverageChoices,
  limitFromMark,
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

// ─── Limit orders (SEN-179) ────────────────────────────────────────────────

const limit = (over: Partial<Parameters<typeof checkPerpLimit>[0]> = {}) =>
  checkPerpLimit({
    price: '82900',
    side: 'long',
    mark: '82947.4',
    tickSize: '0.1',
    postOnly: false,
    ...over,
  });

test('a limit price must be there, a number, above zero and on the tick', () => {
  assert.deepEqual(limit({ price: '' }), { problem: 'Enter a limit price', warning: null });
  assert.equal(limit({ price: '1e5' }).problem, 'That isn’t a price');
  assert.equal(limit({ price: '-1' }).problem, 'That isn’t a price');
  assert.equal(limit({ price: '0' }).problem, 'The price must be above zero');
  assert.equal(limit({ price: '0.0' }).problem, 'The price must be above zero');
  assert.equal(limit({ price: '82900.05' }).problem, 'Perpl prices move in steps of 0.1');
  assert.equal(limit({ price: '82900.1' }).problem, null);
  assert.equal(limit({ price: '82900.10' }).problem, null, 'trailing zeros are still on the tick');
  assert.equal(
    limit({ price: '82905', tickSize: '10' }).problem,
    'Perpl prices move in steps of 10',
  );
});

test('a limit on the far side of the mark warns, and says what post-only does there', () => {
  assert.deepEqual(
    limit({ price: '82900' }),
    { problem: null, warning: null },
    'a long below the mark rests',
  );
  assert.match(limit({ price: '83000' }).warning ?? '', /^Above the mark, so it may fill at once/);
  assert.match(
    limit({ price: '83000', postOnly: true }).warning ?? '',
    /post-only refuses that, and the order is cancelled/,
  );
  assert.equal(
    limit({ side: 'short', price: '83000' }).warning,
    null,
    'a short above the mark rests',
  );
  assert.match(limit({ side: 'short', price: '82900' }).warning ?? '', /^Below the mark/);
  assert.equal(limit({ price: '83000', mark: null }).warning, null, 'no mark, nothing to compare');
  assert.equal(limit({ price: '82947.4' }).warning, null, 'at the mark is not across it');
});

test('a limit starts at the mark, floored to the tick', () => {
  assert.equal(limitFromMark('82947.47', '0.1'), '82947.4');
  assert.equal(limitFromMark('82947.4', '0.1'), '82947.4');
  assert.equal(limitFromMark('2483.34', '1'), '2483');
  assert.equal(limitFromMark('0.123', '0.0005'), '0.1230');
  assert.equal(limitFromMark(null, '0.1'), '');
});

test('a limit order is sized at its own price, not the mark', () => {
  const t = evaluatePerpTicket(
    input({ value: '41.48', orderType: 'limit', limitPrice: '41480', mark: '82947.4' }),
  );
  assert.equal(t.size, '0.001', 'twice the size the mark would give');
  assert.equal(t.notional, '41.48');
  assert.equal(t.margin, '20.74');
  assert.equal(t.cta.label, 'Review long limit');
  const empty = evaluatePerpTicket(input({ value: '41.48', orderType: 'limit', limitPrice: '' }));
  assert.equal(empty.cta.enabled, false);
  assert.equal(empty.cta.label, 'Enter a limit price');
});
