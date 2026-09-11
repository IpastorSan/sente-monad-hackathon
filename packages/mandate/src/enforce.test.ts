import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkIntent, REFUSAL_CODES, type Intent, type RefusalCode } from './enforce.ts';
import {
  CBBTC_USDC,
  demoMandate,
  EXPIRES_AT,
  MON_USDC,
  NOW,
  USDC,
  WETH,
} from './mandate.fixture.ts';

const mandate = demoMandate();
const kuruOrder: Intent = { venue: 'kuru', kind: 'order', market: MON_USDC, notional: '100' };
const perplOrder: Intent = {
  venue: 'perpl',
  kind: 'order',
  market: 'BTC-PERP',
  notional: '100',
  leverage: 3,
};

const seen = new Set<RefusalCode>();
function refused(intent: Intent, code: RefusalCode, at = NOW, m = mandate): void {
  const refusal = checkIntent(m, intent, at);
  assert.equal(
    refusal?.code,
    code,
    `${JSON.stringify(intent, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))}`,
  );
  assert.ok(refusal.detail.length > 0);
  seen.add(code);
}

test('orders and deposits inside the mandate are allowed', () => {
  assert.equal(checkIntent(mandate, kuruOrder, NOW), null);
  assert.equal(checkIntent(mandate, perplOrder, NOW), null);
  assert.equal(checkIntent(mandate, { ...kuruOrder, market: MON_USDC.toLowerCase() }, NOW), null);
  assert.equal(checkIntent(mandate, { ...kuruOrder, notional: '250.5' }, NOW), null, 'at the cap');
  assert.equal(checkIntent(mandate, { ...perplOrder, leverage: 5 }, NOW), null, 'at the cap');
  assert.equal(
    checkIntent(
      mandate,
      { venue: 'kuru', kind: 'deposit', market: USDC, amountAtoms: 1_000_000_000n },
      NOW,
    ),
    null,
  );
  assert.equal(
    checkIntent(
      mandate,
      { venue: 'perpl', kind: 'deposit', market: '', amountAtoms: 500_000_000n },
      NOW,
    ),
    null,
  );
});

test('mandate_expired: valid through expiresAt, refused one second after', () => {
  assert.equal(checkIntent(mandate, kuruOrder, EXPIRES_AT), null);
  refused(kuruOrder, 'mandate_expired', EXPIRES_AT + 1);
  refused(
    { venue: 'perpl', kind: 'deposit', market: '', amountAtoms: 1n },
    'mandate_expired',
    EXPIRES_AT + 1,
  );
  refused(kuruOrder, 'mandate_expired', Number.NaN);
});

test('venue_not_allowed: an unknown venue, or a known one the mandate leaves out', () => {
  refused({ ...kuruOrder, venue: 'hyperliquid' }, 'venue_not_allowed');
  refused(perplOrder, 'venue_not_allowed', NOW, demoMandate({ venues: ['kuru'] }));
  refused(kuruOrder, 'venue_not_allowed', NOW, demoMandate({ venues: [] }));
});

test('market_not_allowed: fails closed on anything the allowlist does not name', () => {
  refused({ ...kuruOrder, market: CBBTC_USDC }, 'market_not_allowed');
  refused({ ...kuruOrder, market: 'MON-USDC' }, 'market_not_allowed', NOW); // a symbol, not an address
  refused({ ...perplOrder, market: 'SOL-PERP' }, 'market_not_allowed');
  refused({ ...perplOrder, market: 'btc-perp' }, 'market_not_allowed');
  refused({ venue: 'kuru', kind: 'deposit', market: WETH, amountAtoms: 1n }, 'market_not_allowed');
  // An empty allowlist denies every market.
  const empty = demoMandate({ kuru: { markets: [], maxDepositAtoms: {} } });
  refused(kuruOrder, 'market_not_allowed', NOW, empty);
});

test('notional_over_cap: over the cap, missing, or not a decimal', () => {
  refused({ ...kuruOrder, notional: '250.50000001' }, 'notional_over_cap');
  refused({ ...perplOrder, notional: '1000' }, 'notional_over_cap');
  refused({ venue: 'kuru', kind: 'order', market: MON_USDC }, 'notional_over_cap');
  refused({ ...kuruOrder, notional: '1e2' }, 'notional_over_cap');
  refused({ ...kuruOrder, notional: '-5' }, 'notional_over_cap');
});

test('leverage_over_cap: over the cap, or missing on a perp order', () => {
  refused({ ...perplOrder, leverage: 5.01 }, 'leverage_over_cap');
  refused(
    { venue: 'perpl', kind: 'order', market: 'BTC-PERP', notional: '1' },
    'leverage_over_cap',
  );
  refused({ ...perplOrder, leverage: 0 }, 'leverage_over_cap');
  refused({ ...perplOrder, leverage: Number.NaN }, 'leverage_over_cap');
});

test('deposit_over_cap: over the cap, missing, or not positive', () => {
  refused(
    { venue: 'kuru', kind: 'deposit', market: USDC, amountAtoms: 1_000_000_001n },
    'deposit_over_cap',
  );
  refused(
    { venue: 'perpl', kind: 'deposit', market: '', amountAtoms: 500_000_001n },
    'deposit_over_cap',
  );
  refused({ venue: 'kuru', kind: 'deposit', market: USDC }, 'deposit_over_cap');
  refused({ venue: 'perpl', kind: 'deposit', market: '', amountAtoms: 0n }, 'deposit_over_cap');
});

test('cancel, close and withdraw are always allowed on an allowed venue — reducing risk is never blocked', () => {
  const late = EXPIRES_AT + 86_400;
  for (const kind of ['cancel', 'close', 'withdraw'] as const) {
    assert.equal(checkIntent(mandate, { venue: 'kuru', kind, market: CBBTC_USDC }, late), null);
    assert.equal(checkIntent(mandate, { venue: 'perpl', kind, market: 'SOL-PERP' }, late), null);
    refused({ venue: 'hyperliquid', kind, market: 'X' }, 'venue_not_allowed');
  }
});

test('an unknown intent kind gets the full order checks, not a pass', () => {
  const odd = { ...kuruOrder, kind: 'transfer' } as unknown as Intent;
  assert.equal(checkIntent(mandate, { ...odd, notional: '1' }, NOW), null);
  refused({ ...odd, market: CBBTC_USDC }, 'market_not_allowed');
});

test('every refusal code is exercised', () => {
  assert.deepEqual([...seen].sort(), [...REFUSAL_CODES].sort());
});
