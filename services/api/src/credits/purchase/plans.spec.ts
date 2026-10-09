import { loadCreditsPurchaseConfig } from './credits-purchase.service';
import { checkAutoTopUp, checkPurchase, creditPlans } from './plans';

describe('loadCreditsPurchaseConfig', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['yes', false],
    ['on', false],
    ['1', true],
    [' true ', true],
  ])('CREDITS_PURCHASES_ENABLED=%p is %p', (raw, expected) => {
    expect(loadCreditsPurchaseConfig({ CREDITS_PURCHASES_ENABLED: raw }).purchasesEnabled).toBe(
      expected,
    );
  });
});

describe('creditPlans', () => {
  it('carries the free tier it was given and the note only while closed', () => {
    const open = creditPlans({ purchasesEnabled: true, freeTierUsd: 12, freeTierReset: 'monthly' });
    expect(open.note).toBeNull();
    expect(open.freeTier).toEqual({ usd: 12, reset: 'monthly' });
    expect(open.plans.map((plan) => plan.id)).toEqual(['pack_10', 'pack_20', 'pack_50', 'custom']);
  });
});

describe('checkPurchase', () => {
  it.each([
    [{ plan: 'pack_10' }, { plan: 'pack_10', usd: 10 }],
    [{ plan: 'pack_50' }, { plan: 'pack_50', usd: 50 }],
    [
      { plan: 'custom', amountUsd: 5 },
      { plan: 'custom', usd: 5 },
    ],
    [
      { plan: 'custom', amountUsd: 500 },
      { plan: 'custom', usd: 500 },
    ],
  ])('accepts %j', (body, order) => {
    expect(checkPurchase(body)).toEqual({ ok: true, value: order });
  });

  it.each([
    [null],
    ['pack_10'],
    [{ plan: 'pack_15' }],
    [{ plan: 'pack_10', amountUsd: 10 }],
    [{ plan: 'custom' }],
    [{ plan: 'custom', amountUsd: 4 }],
    [{ plan: 'custom', amountUsd: 501 }],
    [{ plan: 'custom', amountUsd: 12.5 }],
    [{ plan: 'custom', amountUsd: '20' }],
  ])('refuses %j', (body) => {
    expect(checkPurchase(body).ok).toBe(false);
  });
});

describe('checkAutoTopUp', () => {
  it('turns off with nothing else', () => {
    expect(checkAutoTopUp({ enabled: false })).toEqual({
      ok: true,
      value: { enabled: false, thresholdUsd: null, amountUsd: null },
    });
  });

  it('turns on with a listed threshold and amount', () => {
    expect(checkAutoTopUp({ enabled: true, thresholdUsd: 2, amountUsd: 20 })).toEqual({
      ok: true,
      value: { enabled: true, thresholdUsd: 2, amountUsd: 20 },
    });
  });

  it.each([
    [{}],
    [{ enabled: 'yes' }],
    [{ enabled: true, thresholdUsd: 3, amountUsd: 20 }],
    [{ enabled: true, thresholdUsd: 2, amountUsd: 15 }],
    [{ enabled: true }],
  ])('refuses %j', (body) => {
    expect(checkAutoTopUp(body).ok).toBe(false);
  });
});
