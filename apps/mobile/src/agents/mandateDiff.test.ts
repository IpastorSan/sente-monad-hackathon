/** The approval sheet's diff of two mandates (SEN-59). Plain node. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentMandate } from './api.ts';
import {
  buildMandate,
  defaultMandateForm,
  describeMandate,
  formatExpiry,
  KURU_MARKETS,
  type MandateForm,
} from './mandate.ts';
import { diffMandates } from './mandateDiff.ts';

const NOW = 1_789_000_000;
const DAY = 86_400;

function market(symbol: string) {
  const found = KURU_MARKETS.find((m) => m.symbol === symbol);
  if (!found) throw new Error(`no market ${symbol}`);
  return found.address;
}

function mandate(patch: Partial<MandateForm> = {}): AgentMandate {
  const result = buildMandate({ ...defaultMandateForm(NOW), ...patch }, NOW);
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.mandate;
}

test('an unchanged mandate has no changes', () => {
  assert.deepEqual(diffMandates(mandate(), mandate()), []);
});

test('a raised limit shows old and new, labelled as describeMandate labels it', () => {
  const changes = diffMandates(
    mandate(),
    mandate({ maxOrderNotional: '500', expiresAt: NOW + 30 * DAY }),
  );
  const label = (id: string) => describeMandate(mandate()).find((limit) => limit.id === id)?.label;
  assert.deepEqual(changes, [
    {
      id: 'maxOrderNotional',
      label: label('maxOrderNotional'),
      enforcer: 'sente',
      kind: 'value',
      before: '50 USDC',
      after: '500 USDC',
    },
    {
      id: 'expiresAt',
      label: label('expiresAt'),
      enforcer: 'enclave',
      kind: 'value',
      before: formatExpiry(NOW + 7 * DAY),
      after: formatExpiry(NOW + 30 * DAY),
    },
  ]);
});

test('an added market is an addition to the set, not a new list', () => {
  const [change] = diffMandates(
    mandate(),
    mandate({ kuruMarkets: [market('MON-USDC'), market('WETH-USDC')] }),
  );
  assert.deepEqual(change, {
    id: 'kuru.markets',
    label: 'Kuru markets',
    enforcer: 'enclave',
    kind: 'list',
    kept: ['MON-USDC'],
    added: ['WETH-USDC'],
    removed: [],
  });
});

test('turning a venue on adds its limits; turning it off removes them', () => {
  const perpl: Partial<MandateForm> = {
    perpl: true,
    perplCollateral: '250',
    perplMarkets: 'BTC-PERP',
    maxLeverage: '2',
  };
  // The order cap now covers Perpl orders too, so its unit widens (SEN-177).
  const on = diffMandates(mandate(), mandate(perpl));
  assert.deepEqual(
    on.map((change) => change.id),
    ['venues', 'perpl.collateral', 'perpl.markets', 'perpl.leverage', 'maxOrderNotional'],
  );
  assert.deepEqual(on[4], {
    id: 'maxOrderNotional',
    label: 'Largest single order',
    enforcer: 'sente',
    kind: 'value',
    before: '50 USDC',
    after: '50 USDC or AUSD',
  });
  assert.deepEqual(on[0], {
    id: 'venues',
    label: 'Venues',
    enforcer: 'enclave',
    kind: 'list',
    kept: ['Kuru'],
    added: ['Perpl'],
    removed: [],
  });
  assert.deepEqual(on[1], {
    id: 'perpl.collateral',
    label: 'AUSD per transfer into Perpl',
    enforcer: 'enclave',
    kind: 'value',
    before: null,
    after: '250 AUSD',
  });
  assert.deepEqual(on[2], {
    id: 'perpl.markets',
    label: 'Perpl markets',
    enforcer: 'sente',
    kind: 'list',
    kept: [],
    added: ['BTC-PERP'],
    removed: [],
  });

  const off = diffMandates(mandate(perpl), mandate());
  assert.deepEqual(
    off.map((change) => change.id),
    ['venues', 'maxOrderNotional', 'perpl.collateral', 'perpl.markets', 'perpl.leverage'],
  );
  assert.deepEqual(off[4], {
    id: 'perpl.leverage',
    label: 'Max leverage',
    enforcer: 'sente',
    kind: 'value',
    before: '2×',
    after: null,
  });
});

test('a changed deposit cap is one row per token', () => {
  const changes = diffMandates(mandate(), mandate({ depositCaps: { USDC: '250', MON: '5' } }));
  assert.deepEqual(
    changes.map((change) => [
      change.id,
      change.kind === 'value' ? [change.before, change.after] : null,
    ]),
    [
      ['kuru.deposit.MON', [null, '5 MON']],
      ['kuru.deposit.USDC', ['100 USDC', '250 USDC']],
    ],
  );
});
