/**
 * Configuring a preset (SEN-116): controls from specs, validation that is
 * `resolveParams`'s own, honest labels for every level, the read-back, and a
 * mandate prefill that still goes out through `mandateToSend`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMandate } from '@sente/mandate';
import { getPreset, listPresets, resolveParams, type PresetDefinition } from '@sente/presets';

import { toWireMandate } from '../agents/api.ts';
import { buildMandate } from '../agents/mandate.ts';
import { mandateToSend } from '../agents/presets.ts';
import {
  cadencePhrase,
  cantDo,
  checkParams,
  controlFor,
  decisionSteps,
  fundingAssets,
  guardianLines,
  initialDraft,
  levelKind,
  marketOptions,
  presetHireRequest,
  rawParams,
  readBackParams,
  runsLabel,
  scheduleFor,
  snapToStep,
  suggestedFunding,
  suggestedValues,
  tierValues,
} from './params.ts';

const NOW = 1_789_000_000;
const DAY = 86_400;
const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function preset(id: string): PresetDefinition {
  const def = getPreset(id);
  assert.ok(def, id);
  return def;
}

function defaults(def: PresetDefinition) {
  const resolved = resolveParams(def, {});
  assert.ok(resolved.ok);
  return resolved.params;
}

test('controls: number → slider, segmented or amount; enum → segmented; boolean → toggle', () => {
  const range = preset('range-trader');
  const kinds = Object.fromEntries(
    range.params.map((spec) => [spec.key, controlFor(spec, range.id).kind]),
  );
  assert.deepEqual(kinds, {
    market: 'market',
    lookback: 'segmented',
    entryBand: 'slider',
    target: 'slider',
    stop: 'slider',
    sizePct: 'slider',
    cadence: 'segmented',
  });

  const trend = preset('trend-rider');
  const leverage = trend.params.find((spec) => spec.key === 'leverage');
  assert.ok(leverage);
  const control = controlFor(leverage, trend.id);
  assert.equal(control.kind, 'segmented');
  if (control.kind === 'segmented') {
    assert.deepEqual(
      control.options.map((o) => o.label),
      ['1x', '2x', '3x', '4x', '5x'],
    );
  }

  // Six decimal places over a million: nobody lands that with a thumb.
  const guardian = preset('guardian');
  for (const key of ['amount', 'sellAbove', 'sellBelow']) {
    const spec = guardian.params.find((p) => p.key === key);
    assert.ok(spec);
    assert.equal(controlFor(spec, guardian.id).kind, 'amount', key);
  }

  const funding = preset('funding-harvester');
  const hedge = funding.params.find((spec) => spec.key === 'hedge');
  assert.ok(hedge);
  assert.equal(controlFor(hedge, funding.id).kind, 'toggle');
});

test('market options: Kuru is fixed, Perpl comes from /markets, the default is always there', () => {
  const range = preset('range-trader').params.find((spec) => spec.type === 'market');
  const trend = preset('trend-rider').params.find((spec) => spec.type === 'market');
  const mean = preset('mean-reverter').params.find((spec) => spec.type === 'market');
  assert.ok(range?.type === 'market' && trend?.type === 'market' && mean?.type === 'market');
  assert.deepEqual(marketOptions(range), ['MON-USDC', 'WETH-USDC', 'cbBTC-USDC', 'XAUt-USDC']);
  assert.deepEqual(marketOptions(trend), ['BTC-PERP', 'ETH-PERP']);
  assert.deepEqual(marketOptions(trend, ['SOL-PERP', 'MON-USDC']), ['SOL-PERP', 'BTC-PERP']);
  assert.ok(marketOptions(mean).includes('MON-USDC') && marketOptions(mean).includes('BTC-PERP'));
});

test('honesty: which levels rest on the venue and which the agent only watches', () => {
  assert.equal(levelKind('range-trader', 'target'), 'resting');
  assert.equal(levelKind('range-trader', 'stop'), 'watched');
  assert.equal(levelKind('guardian', 'sellAbove'), 'watched');
  assert.equal(levelKind('guardian', 'sellBelow'), 'watched');
  assert.equal(levelKind('trend-rider', 'trailingStop'), 'watched');
  assert.equal(levelKind('mean-reverter', 'takeBack'), 'resting');
  assert.equal(levelKind('mean-reverter', 'stop'), 'watched');
  assert.equal(levelKind('funding-harvester', 'exitOnFlip'), 'watched');
  for (const spec of preset('dca-stacker').params) {
    assert.equal(levelKind('dca-stacker', spec.key), undefined, spec.key);
  }
  // Every preset admits it can't leave its mandate; Funding Harvester admits it can't open yet.
  for (const def of listPresets()) {
    assert.ok(
      cantDo(def.id).some((line) => line.includes('mandate')),
      def.id,
    );
  }
  assert.ok(cantDo('funding-harvester').some((line) => line.startsWith('Open anything yet')));
});

test('validation is resolveParams: defaults pass, and every failure names its control', () => {
  for (const def of listPresets()) {
    const check = checkParams(def, initialDraft(def));
    assert.ok(check.ok, def.id);
    assert.deepEqual(check.params, defaults(def), def.id);
  }

  const range = preset('range-trader');
  const out = checkParams(range, { ...initialDraft(range), target: 11 });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.errors['target'], 'Target must be between 1 and 10.');

  const offStep = checkParams(range, { ...initialDraft(range), entryBand: 1.55 });
  assert.equal(offStep.ok, false);

  // A cross-parameter rule the spec alone can't state.
  const guardian = preset('guardian');
  const crossed = checkParams(guardian, { ...initialDraft(guardian), sellAbove: '0.01' });
  assert.equal(crossed.ok, false);
  if (!crossed.ok) {
    assert.equal(crossed.errors['sellBelow'], 'Sell below must be below the sell-above line.');
  }
});

test('typed amounts: plain decimals become numbers, anything else is refused as the API would', () => {
  const guardian = preset('guardian');
  const draft = { ...initialDraft(guardian), amount: '12.5' };
  assert.equal(rawParams(guardian, draft)['amount'], 12.5);
  const bad = checkParams(guardian, { ...draft, amount: '1e3' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.errors['amount'], 'Amount to hand over must be a number.');
  assert.equal(checkParams(guardian, { ...draft, amount: '' }).ok, false);
});

test('slider snapping lands where resolveParams counts steps', () => {
  assert.equal(snapToStep(1.53, 0.5, 3, 0.1), 1.5);
  assert.equal(snapToStep(99, 1, 10, 0.5), 10);
  assert.equal(snapToStep(0.0123, 0.005, 0.1, 0.005), 0.01);
  const range = preset('range-trader');
  const snapped = snapToStep(2.2999999, 0.5, 3, 0.1);
  assert.ok(checkParams(range, { ...initialDraft(range), entryBand: snapped }).ok);
});

test('read-back: the study’s Range Trader sentence, with the target resting and the stop watched', () => {
  const range = preset('range-trader');
  assert.equal(
    readBackParams(range, defaults(range)),
    'Every 15 minutes I’ll look at MON’s 3-day range. Within 1.5% of the low I’ll buy with up to ' +
      '40% of my budget, then sell 3% higher with a limit order resting on Kuru, or 3% lower when I ' +
      'see it on a run.',
  );
});

test('read-back: every preset, never a stop order, and each says what kind of level it has', () => {
  const sentences = Object.fromEntries(
    listPresets().map((def) => [def.id, readBackParams(def, defaults(def))]),
  );
  for (const [id, sentence] of Object.entries(sentences)) {
    assert.doesNotMatch(sentence, /stop[- ]loss|stop order|SL\/TP/i, id);
  }
  assert.match(sentences['guardian'] ?? '', /neither is an order on Kuru/);
  assert.match(sentences['trend-rider'] ?? '', /watch rather than place on Perpl/);
  assert.match(sentences['mean-reverter'] ?? '', /resting limit/);
  assert.match(sentences['dca-stacker'] ?? '', /I set no stops/);
  assert.match(sentences['funding-harvester'] ?? '', /I open nothing/);
  assert.equal(
    sentences['guardian'],
    'Every minute I’ll check MON-USDC’s best bid. At or above 0.05 USDC, or at or below 0.01, ' +
      'I’ll sell up to 100 MON at market. I watch both lines; neither is an order on Kuru.',
  );
});

test('decision steps are the rendered strategy’s own numbered lines', () => {
  const range = preset('range-trader');
  const steps = decisionSteps(range.render(defaults(range)).strategy);
  assert.equal(steps.length, 5);
  assert.match(steps[0] ?? '', /^Read the 3-day high and low of MON-USDC/);
  assert.equal(steps[4], 'Otherwise do nothing.');
});

test('mandate prefill: every preset’s suggestion builds a mandate the API accepts', () => {
  for (const def of listPresets()) {
    const suggested = def.suggestedMandate(defaults(def));
    const values = suggestedValues(suggested, NOW, OWNER);
    const result = mandateToSend(values.form, values.expiryDays, NOW);
    if (!result.ok) assert.fail(`${def.id}: ${JSON.stringify(result.errors)}`);
    // The API's own validator, on the bytes the hire sends.
    assert.doesNotThrow(
      () => parseMandate(JSON.parse(JSON.stringify(toWireMandate(result.mandate)))),
      def.id,
    );
    assert.equal(result.mandate.expiresAt, NOW + suggested.expiryDays * DAY, def.id);
    assert.equal(result.mandate.returnTo, OWNER, def.id);
    assert.deepEqual([...result.mandate.venues].sort(), [...suggested.venues].sort(), def.id);
  }
});

test('mandate prefill goes through mandateToSend: the same bytes as buildMandate on that form', () => {
  const range = preset('range-trader');
  const values = suggestedValues(range.suggestedMandate(defaults(range)), NOW, OWNER);
  const sent = mandateToSend(values.form, values.expiryDays, NOW);
  const direct = buildMandate({ ...values.form, expiresAt: NOW + 7 * DAY }, NOW);
  assert.ok(sent.ok && direct.ok);
  assert.equal(
    JSON.stringify(toWireMandate(sent.mandate)),
    JSON.stringify(toWireMandate(direct.mandate)),
  );
});

test('another tier chip keeps the preset’s market and moves only the limits', () => {
  const range = preset('range-trader');
  const suggested = range.suggestedMandate(defaults(range));
  const suggestion = suggestedValues(suggested, NOW, OWNER);
  assert.deepEqual(tierValues('standard', suggested, NOW, OWNER), suggestion);

  const cautious = tierValues('cautious', suggested, NOW, OWNER);
  assert.deepEqual(cautious.form.kuruMarkets, suggestion.form.kuruMarkets);
  assert.equal(cautious.form.perpl, false);
  assert.equal(cautious.form.maxOrderNotional, '10');
  assert.deepEqual(cautious.form.depositCaps, { USDC: '25' });
  assert.equal(cautious.expiryDays, 1);

  // Guardian's cap is in MON: no tier has a MON cap, so it stays the amount guarded.
  const guardian = preset('guardian');
  const wide = tierValues('wide', guardian.suggestedMandate(defaults(guardian)), NOW, OWNER);
  assert.deepEqual(wide.form.depositCaps, { MON: '100' });
  assert.equal(wide.form.perpl, false);
  assert.ok(mandateToSend(wide.form, wide.expiryDays, NOW).ok);
});

test('schedule: within the API’s bounds, or none rather than a clamped cadence', () => {
  assert.deepEqual(scheduleFor(900), { everySeconds: 900 });
  assert.deepEqual(scheduleFor(DAY), { everySeconds: DAY });
  // A week is the API's ceiling since SEN-158; past it, none rather than clamped.
  assert.deepEqual(scheduleFor(7 * DAY), { everySeconds: 7 * DAY });
  assert.equal(scheduleFor(7 * DAY + 1), null);
  assert.equal(scheduleFor(30), null);
  assert.equal(runsLabel(900), '96 runs a day');
  assert.equal(runsLabel(DAY), '1 run a day');
  assert.equal(runsLabel(7 * DAY), '1 run a week');
  assert.equal(cadencePhrase(900), 'Every 15 minutes');
  assert.equal(cadencePhrase(60), 'Every minute');
});

test('funding: what each preset trades with, and a starting amount', () => {
  const amounts = Object.fromEntries(
    listPresets().map((def) => {
      const params = defaults(def);
      const suggested = def.suggestedMandate(params);
      return [
        def.id,
        `${suggestedFunding(def.id, params, suggested)} ${fundingAssets(suggested).join('+')}`,
      ];
    }),
  );
  assert.deepEqual(amounts, {
    guardian: '100 MON',
    'range-trader': '100 USDC',
    'trend-rider': '250 AUSD',
    'funding-harvester': '50 AUSD+USDC',
    'dca-stacker': '100 USDC',
    'mean-reverter': '100 USDC',
  });
});

test('Guardian lines start 10% either side of the live price, and pass resolveParams', () => {
  assert.deepEqual(guardianLines('0.0325'), { sellAbove: 0.03575, sellBelow: 0.02925 });
  assert.deepEqual(guardianLines(2.5), { sellAbove: 2.75, sellBelow: 2.25 });
  assert.equal(guardianLines(null), null);
  assert.equal(guardianLines('0'), null);
  assert.equal(guardianLines('nope'), null);
  // Too small for the 0.000001 grid: both lines would round to the same value.
  assert.equal(guardianLines('0.000004'), null);

  const guardian = preset('guardian');
  for (const price of ['0.0325', '0.051', '1.2', '11.36', '0.00005']) {
    const lines = guardianLines(price);
    assert.ok(lines, price);
    const check = checkParams(guardian, { ...initialDraft(guardian), ...lines });
    assert.ok(check.ok, `${price}: ${JSON.stringify(check)}`);
  }

  // Above a few thousand the package's step check refuses nearly every value
  // (2764: "must be a multiple of 0.000001"), so the lines stay put, within a
  // figure of ±10%, and the field shows that refusal rather than hiding it.
  const high = guardianLines(2512.34);
  assert.ok(high);
  assert.ok(Math.abs(high.sellAbove / 2763.574 - 1) < 0.005);
  assert.ok(Math.abs(high.sellBelow / 2261.106 - 1) < 0.005);
});

test('hire: a weekly DCA Stacker is hired with a weekly schedule (SEN-158)', () => {
  const dca = preset('dca-stacker');
  const draft = { ...initialDraft(dca), every: 'week' };
  const checked = checkParams(dca, draft);
  assert.ok(checked.ok);
  const suggested = suggestedValues(dca.suggestedMandate(checked.params), NOW, OWNER);
  const mandate = mandateToSend(suggested.form, suggested.expiryDays, NOW);
  assert.ok(mandate.ok);

  const request = presetHireRequest(dca, draft, checked.params, {
    name: '  Steady Stack ',
    model: 'anthropic/claude-sonnet-5',
    mandate: mandate.mandate,
  });
  assert.deepEqual(request.schedule, { everySeconds: 604_800 });
  assert.equal(request.name, 'Steady Stack');
  assert.equal(request.preset?.id, 'dca-stacker');
  assert.equal(request.preset?.params['every'], 'week');
  assert.equal(request.strategy, undefined);

  const daily = { ...draft, every: 'day' };
  const dailyParams = checkParams(dca, daily);
  assert.ok(dailyParams.ok);
  assert.deepEqual(
    presetHireRequest(dca, daily, dailyParams.params, {
      name: 'x',
      model: 'm',
      mandate: mandate.mandate,
    }).schedule,
    { everySeconds: 86_400 },
  );
});
