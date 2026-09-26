/**
 * Presets only prefill the form (SEN-59).
 *
 * Two claims, both about what goes over the wire: every preset builds a
 * mandate the API's own `parseMandate` accepts, and `mandateToSend` — the path
 * the hire screen now takes — sends the same bytes the screen sent before
 * presets existed, for the same form and the same expiry chip.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMandate } from '@sente/mandate';
import { KURU_TESTNET_TOKENS } from '@sente/venues/kuru';

import { toWireMandate, type AgentMandate } from './api.ts';
import {
  buildMandate,
  defaultMandateForm,
  formFromMandate,
  KURU_MARKETS,
  type BuildResult,
  type MandateForm,
} from './mandate.ts';
import { mandateToSend, presetValues, type PresetId } from './presets.ts';

const NOW = 1_789_000_000;
const DAY = 86_400;
const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const PRESETS: readonly PresetId[] = ['cautious', 'standard', 'wide'];

function built(result: BuildResult): AgentMandate {
  if (!result.ok) assert.fail(`expected a mandate, got ${JSON.stringify(result.errors)}`);
  return result.mandate;
}

/** The request body, byte for byte. */
function wire(mandate: AgentMandate): string {
  return JSON.stringify(toWireMandate(mandate));
}

/**
 * What `new.tsx` did before SEN-59, copied verbatim from its old
 * `currentMandate`. Kept here, not imported, so a change to `mandateToSend`
 * can't quietly move both sides of the comparison.
 */
function sentBeforePresets(form: MandateForm, expiryDays: number | null, now: number) {
  const expiresAt = expiryDays === null ? form.expiresAt : now + expiryDays * DAY;
  return buildMandate({ ...form, expiresAt }, now);
}

for (const id of PRESETS) {
  test(`the ${id} preset builds a mandate the API accepts`, () => {
    const { form, expiryDays } = presetValues(id, NOW, OWNER);
    const mandate = built(mandateToSend(form, expiryDays, NOW));
    const parsed = parseMandate(JSON.parse(wire(mandate)));
    assert.equal(parsed.expiresAt, NOW + expiryDays * DAY);
    assert.equal(parsed.returnTo, OWNER);
  });

  test(`the ${id} preset sends exactly what the same form sent before presets`, () => {
    const { form, expiryDays } = presetValues(id, NOW, OWNER);
    // Later submit time: the chip counts from submitting, on both paths.
    const later = NOW + 600;
    assert.equal(
      wire(built(mandateToSend(form, expiryDays, later))),
      wire(built(sentBeforePresets(form, expiryDays, later))),
    );
  });
}

test('standard is the default form, so an untouched hire sends what it always did', () => {
  const { form, expiryDays } = presetValues('standard', NOW, OWNER);
  assert.deepEqual(form, defaultMandateForm(NOW, OWNER));
  assert.equal(expiryDays, 7);
  const monUsdc = KURU_MARKETS.find((market) => market.symbol === 'MON-USDC')?.address;
  assert.equal(
    wire(built(mandateToSend(form, expiryDays, NOW))),
    JSON.stringify({
      version: 1,
      chainId: 10143,
      expiresAt: NOW + 7 * DAY,
      venues: ['kuru'],
      kuru: {
        markets: [monUsdc],
        maxDepositAtoms: { [KURU_TESTNET_TOKENS.USDC.address]: '100000000' },
      },
      perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
      maxOrderNotional: '50',
      returnTo: OWNER,
    }),
  );
});

test('an edited or amended form goes through the same path unchanged', () => {
  const edited: MandateForm = {
    ...presetValues('wide', NOW, OWNER).form,
    maxOrderNotional: '75.5',
    maxLeverage: '3',
  };
  for (const days of [null, 1, 90]) {
    assert.equal(
      wire(built(mandateToSend(edited, days, NOW))),
      wire(built(sentBeforePresets(edited, days, NOW))),
    );
  }
  // An amend starts from the stored mandate with no chip: it keeps its expiry.
  const stored = built(mandateToSend(edited, 30, NOW));
  assert.equal(wire(built(mandateToSend(formFromMandate(stored), null, NOW + DAY))), wire(stored));
});

test('a preset refuses what buildMandate refuses: it never bypasses validation', () => {
  const { form, expiryDays } = presetValues('wide', NOW);
  const result = mandateToSend({ ...form, perplMarkets: '' }, expiryDays, NOW);
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(result.errors.perplMarkets, 'Name at least one market, e.g. BTC-PERP.');
});

test('cautious sits below standard and wide above it, on every limit a preset moves', () => {
  const [cautious, standard, wide] = PRESETS.map((id) =>
    built(mandateToSend(presetValues(id, NOW).form, presetValues(id, NOW).expiryDays, NOW)),
  ) as [AgentMandate, AgentMandate, AgentMandate];
  const usdc = (mandate: AgentMandate) => Object.values(mandate.kuru.maxDepositAtoms)[0] ?? 0n;
  const order = (mandate: AgentMandate) => Number(mandate.maxOrderNotional);

  assert.ok(order(cautious) < order(standard) && order(standard) < order(wide));
  assert.ok(usdc(cautious) < usdc(standard) && usdc(standard) < usdc(wide));
  assert.ok(cautious.expiresAt < standard.expiresAt && standard.expiresAt < wide.expiresAt);
  assert.deepEqual(standard.venues, ['kuru']);
  assert.deepEqual(wide.venues, ['kuru', 'perpl']);
  assert.equal(wide.perpl.maxLeverage, 2);
});

test('a preset keeps no returnTo it was not given', () => {
  assert.equal('returnTo' in presetValues('cautious', NOW).form, false);
});
