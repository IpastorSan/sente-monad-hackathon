/**
 * SEN-68 (plan B-T14a): every preset validates, renders within the API's
 * limits at its defaults and at its extremes, and says honestly which levels
 * are watched rather than placed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getPreset,
  listPresets,
  renderPreset,
  resolveParams,
  type ParamSpec,
  type Params,
  type PresetDefinition,
  type SuggestedMandate,
} from './index.ts';

/** `AGENT_STRATEGY_MAX_LENGTH` / `AGENT_SYSTEM_PROMPT_MAX_LENGTH` in services/api. */
const STRATEGY_MAX = 2_000;
const SYSTEM_PROMPT_MAX = 8_000;

/** The wire contract's PresetDto, pasted: the catalog must fill it without mapping. */
interface PresetDto {
  id: string;
  version: number;
  name: string;
  tagline: string;
  description: string;
  venues: ('kuru' | 'perpl')[];
  params: ParamSpec[];
  tools: string[];
  defaults: {
    params: Record<string, unknown>;
    strategy: string;
    systemPrompt: string;
    suggestedMandate: SuggestedMandate;
    suggestedCadenceSeconds: number;
  };
}

function toDto(def: PresetDefinition): PresetDto {
  const resolved = resolveParams(def, {});
  assert.ok(resolved.ok);
  const { params } = resolved;
  return {
    id: def.id,
    version: def.version,
    name: def.name,
    tagline: def.tagline,
    description: def.description,
    venues: [...def.venues],
    params: [...def.params],
    tools: [...def.tools],
    defaults: {
      params,
      ...def.render(params),
      suggestedMandate: def.suggestedMandate(params),
      suggestedCadenceSeconds: def.suggestedCadenceSeconds(params),
    },
  };
}

/** Every combination of each param's lowest and highest value, capped for size. */
function extremes(def: PresetDefinition): Record<string, unknown>[] {
  const choices = def.params.map((spec): unknown[] => {
    switch (spec.type) {
      case 'number':
        return [spec.min, spec.max];
      case 'enum':
        return spec.options.map((o) => o.value);
      case 'boolean':
        return [false, true];
      case 'market':
        // The longest Kuru symbol stretches the text the most; a market param
        // open to both venues also renders its other branch.
        return {
          kuru: [spec.default, 'cbBTC-USDC'],
          perpl: [spec.default, 'ETH-PERP'],
          any: [spec.default, 'cbBTC-USDC', 'BTC-PERP'],
        }[spec.venue];
    }
  });
  let combos: Record<string, unknown>[] = [{}];
  def.params.forEach((spec, i) => {
    combos = combos.flatMap((combo) =>
      (choices[i] ?? []).map((value) => ({ ...combo, [spec.key]: value })),
    );
  });
  return combos;
}

const MANDATE_DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

describe('the catalog', () => {
  it('has unique ids, and getPreset finds each one', () => {
    const ids = listPresets().map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.equal(getPreset(id)?.id, id);
    assert.equal(getPreset('nope'), undefined);
  });

  it('has unique param keys per preset, and every default passes its own spec', () => {
    for (const def of listPresets()) {
      const keys = def.params.map((s) => s.key);
      assert.equal(new Set(keys).size, keys.length, def.id);
      assert.ok(resolveParams(def, {}).ok, def.id);
    }
  });
});

for (const def of listPresets()) {
  describe(def.name, () => {
    it('fills the wire PresetDto at its defaults', () => {
      const dto = toDto(def);
      assert.ok(dto.defaults.suggestedCadenceSeconds >= 60);
      const mandate = dto.defaults.suggestedMandate;
      assert.match(mandate.maxOrderNotional, MANDATE_DECIMAL);
      for (const cap of mandate.depositCaps) assert.match(cap.amount, MANDATE_DECIMAL);
      // The mandate allows the market the strategy trades, on its own venue.
      const market = dto.defaults.params['market'];
      assert.ok(
        mandate.kuruMarkets.includes(market as string) ||
          mandate.perplMarkets.includes(market as string),
        def.id,
      );
      for (const venue of mandate.venues) assert.ok(def.venues.includes(venue), def.id);
      if (mandate.perplMarkets.length > 0) assert.ok(mandate.maxLeverage !== null, def.id);
    });

    it('renders defaults and every extreme within the API limits', () => {
      const combos = extremes(def);
      let rendered = 0;
      for (const raw of combos) {
        const result = renderPreset(def.id, raw);
        // Some extremes break a cross-field rule (Guardian's lines the wrong way
        // round, a DCA budget under one buy); those must be refused.
        if (!result.ok) continue;
        rendered += 1;
        assert.ok(
          result.strategy.length <= STRATEGY_MAX,
          `${def.id} strategy ${result.strategy.length}`,
        );
        assert.ok(result.systemPrompt.length <= SYSTEM_PROMPT_MAX, def.id);
        assert.doesNotMatch(result.strategy, /e[+-]\d|NaN|undefined/, def.id);
        const mandate = def.suggestedMandate(result.params);
        assert.match(mandate.maxOrderNotional, MANDATE_DECIMAL);
        for (const cap of mandate.depositCaps) assert.match(cap.amount, MANDATE_DECIMAL);
      }
      assert.ok(rendered > 0, def.id);
    });

    it('is deterministic', () => {
      assert.deepEqual(renderPreset(def.id, {}), renderPreset(def.id, {}));
    });

    it('says which of its levels are venue orders and which are only watched', () => {
      const result = renderPreset(def.id, {});
      assert.ok(result.ok);
      for (const pattern of HONESTY[def.id]) assert.match(result.strategy, pattern, def.id);
    });

    it('promises no returns', () => {
      for (const raw of extremes(def)) {
        const result = renderPreset(def.id, raw);
        if (!result.ok) continue;
        const text = `${def.tagline} ${def.description} ${result.strategy} ${result.systemPrompt}`;
        assert.doesNotMatch(text, /guarantee|risk-free|can(no|')t lose|will (profit|earn)/i);
      }
    });

    it('does not name a tool the agent does not have yet', () => {
      // get_klines and quote land in B-T11; until then a render must not rely on them.
      const result = renderPreset(def.id, {});
      assert.ok(result.ok);
      assert.doesNotMatch(result.strategy + result.systemPrompt, /get_klines|\bquote\b/);
      assert.ok(!def.tools.includes('get_klines'));
    });
  });
}

/**
 * What each preset must say about its levels (SEN-72). A stop that only the
 * agent watches says so; a target resting on the venue says that instead.
 */
const WATCHED = /checked every run, not (a venue order|venue orders)/;
const HONESTY: Record<PresetDefinition['id'], RegExp[]> = {
  guardian: [WATCHED],
  'range-trader': [WATCHED, /target rests on Kuru as a limit order/],
  'trend-rider': [WATCHED, /isolated margin/],
  'funding-harvester': [WATCHED, /isolated margin/, /hedge is your rule, not the mandate/],
  'dca-stacker': [/no stop and no target/],
  'mean-reverter': [WATCHED, /target rests on Kuru as a limit order/],
};

describe('resolveParams', () => {
  const def = getPreset('range-trader');
  assert.ok(def);

  it('fills defaults for absent keys and keeps the ones given', () => {
    const result = resolveParams(def, { target: 5 });
    assert.ok(result.ok);
    assert.equal(result.params['target'], 5);
    assert.equal(result.params['stop'], 3);
    assert.deepEqual(
      Object.keys(result.params),
      def.params.map((s) => s.key),
    );
  });

  it('rejects unknown keys', () => {
    assert.deepEqual(resolveParams(def, { leverage: 3 }), {
      ok: false,
      errors: [{ key: 'leverage', message: 'is not a parameter of this preset' }],
    });
  });

  it('rejects out-of-range, off-step and mistyped values, one error per key', () => {
    const result = resolveParams(def, {
      entryBand: 3.5,
      target: 2.25,
      stop: '3',
      lookback: '2d',
      market: 'DOGE-USDC',
    });
    assert.ok(!result.ok);
    assert.deepEqual(
      result.errors.map((e) => e.key),
      ['market', 'lookback', 'entryBand', 'target', 'stop'],
    );
    assert.equal(result.errors[2]?.message, 'must be between 0.5 and 3');
    assert.equal(result.errors[3]?.message, 'must be a multiple of 0.5');
  });

  it('accepts decimal steps that binary floats cannot hold exactly', () => {
    assert.ok(resolveParams(def, { entryBand: 0.7, target: 1.5 }).ok);
  });

  // SEN-116 found fine steps refusing plain prices: with a 0.000001 step, 4000
  // is 4e9 steps and float division drifts past any fixed tolerance.
  it('keeps fine steps exact at large magnitudes (Guardian on WETH / cbBTC)', () => {
    const guardian = getPreset('guardian');
    assert.ok(guardian);
    const fine = guardian.params.find((p) => p.type === 'number' && p.step < 0.001);
    assert.ok(fine && fine.type === 'number', 'guardian has a fine-step number param');
    for (const value of [12.5, 4000, 2701, 2750, 2799, 64210.123456]) {
      if (value < fine.min || value > fine.max) continue;
      const result = resolveParams(guardian, { [fine.key]: value });
      const keyErrors = result.ok ? [] : result.errors.filter((e) => e.key === fine.key);
      assert.deepEqual(keyErrors, [], `${value} should be on a ${fine.step} step`);
    }
  });

  it('runs a preset’s cross-field rule after the per-key checks', () => {
    assert.deepEqual(renderPreset('guardian', { sellAbove: 0.01, sellBelow: 0.02 }), {
      ok: false,
      errors: [{ key: 'sellBelow', message: 'must be below the sell-above line' }],
    });
  });
});

describe('SEN-72 presets', () => {
  const render = (id: string, raw: Record<string, unknown>): string => {
    const result = renderPreset(id, raw);
    assert.ok(result.ok, JSON.stringify(result));
    return result.strategy;
  };

  it('refuses a Funding Harvester hedge on a perp Kuru does not list', () => {
    assert.deepEqual(renderPreset('funding-harvester', { market: 'SOL-PERP' }), {
      ok: false,
      errors: [{ key: 'market', message: 'has no Kuru spot market to hedge on' }],
    });
    const unhedged = render('funding-harvester', { market: 'SOL-PERP', hedge: false });
    assert.match(unhedged, /unhedged/);
    assert.doesNotMatch(unhedged, /Kuru/);
  });

  it('hedges each perp on the Kuru market holding the same coin', () => {
    const def = getPreset('funding-harvester');
    assert.ok(def);
    for (const [market, spot] of [
      ['BTC-PERP', 'cbBTC-USDC'],
      ['ETH-PERP', 'WETH-USDC'],
      ['MON-PERP', 'MON-USDC'],
    ] as const) {
      const r = resolveParams(def, { market });
      assert.ok(r.ok);
      assert.deepEqual(def.suggestedMandate(r.params).kuruMarkets, [spot]);
    }
  });

  it('says what Funding Harvester does when funding flips, per the toggle', () => {
    assert.match(render('funding-harvester', {}), /funding is below zero/);
    assert.match(
      render('funding-harvester', { exitOnFlip: false, minFunding: 0.02 }),
      /funding is at or below -0.02% \/ 8h/,
    );
  });

  it('keeps Trend Rider long-only unless both directions are chosen', () => {
    assert.doesNotMatch(render('trend-rider', {}), /short/i);
    assert.match(render('trend-rider', { direction: 'both' }), /or a short below the low/);
  });

  it('refuses a DCA budget smaller than one buy', () => {
    assert.deepEqual(renderPreset('dca-stacker', { amount: 50, budget: 40 }), {
      ok: false,
      errors: [{ key: 'budget', message: 'must be at least one buy' }],
    });
  });

  it('doubles the DCA buy on a dip only when asked, and falls back without candles', () => {
    assert.doesNotMatch(render('dca-stacker', {}), /candles/);
    assert.match(
      render('dca-stacker', { doubleOnDip: true }),
      /this buy is double: 20 USDC\. If no tool gives you candles, buy the normal amount/,
    );
  });

  it('fades only drops on Kuru, and both ways at 1x with a reduce-only target on Perpl', () => {
    const spot = render('mean-reverter', {});
    assert.match(spot, /Never short/);
    assert.match(spot, /at 1.5% above your fill price \(50% of the 3% stretch\)/);
    const perp = render('mean-reverter', { market: 'ETH-PERP' });
    assert.match(perp, /short above it/);
    assert.match(perp, /at 1x leverage/);
    assert.match(perp, /reduce-only limit/);
    assert.match(perp, /target rests on Perpl as a limit order/);
    const def = getPreset('mean-reverter');
    assert.ok(def);
    const r = resolveParams(def, { market: 'ETH-PERP' });
    assert.ok(r.ok);
    const mandate = def.suggestedMandate(r.params);
    assert.deepEqual(mandate.venues, ['perpl']);
    assert.deepEqual(mandate.perplMarkets, ['ETH-PERP']);
    assert.equal(mandate.maxLeverage, 1);
  });

  it('asks for leverage within its own cap, and names the market maximum', () => {
    const def = getPreset('trend-rider');
    assert.ok(def);
    const r = resolveParams(def, { leverage: 5 });
    assert.ok(r.ok);
    assert.equal(def.suggestedMandate(r.params).maxLeverage, 5);
    assert.match(render('trend-rider', { leverage: 5 }), /5x leverage \(the market's maximum/);
    assert.ok(!resolveParams(def, { leverage: 6 }).ok);
  });
});

describe('renderPreset', () => {
  it('refuses an unknown preset', () => {
    assert.deepEqual(renderPreset('moon-bot', {}), {
      ok: false,
      errors: [{ key: 'id', message: 'unknown preset moon-bot' }],
    });
  });

  it('returns the id, version and resolved params with the text', () => {
    const result = renderPreset('guardian', { amount: 250 });
    assert.ok(result.ok);
    assert.equal(result.id, 'guardian');
    assert.equal(result.version, 1);
    assert.equal(result.params['amount'], 250);
  });

  it('suggests a cadence from the chosen interval', () => {
    const def = getPreset('range-trader');
    assert.ok(def);
    const params = (raw: Record<string, unknown>): Params => {
      const r = resolveParams(def, raw);
      assert.ok(r.ok);
      return r.params;
    };
    assert.equal(def.suggestedCadenceSeconds(params({})), 900);
    assert.equal(def.suggestedCadenceSeconds(params({ cadence: '1h' })), 3600);
  });
});

// Snapshots: a change here changes what hired agents are told, so it needs a
// version bump on the preset in the same commit.
describe('render snapshots', () => {
  it('Range Trader at its defaults', () => {
    const result = renderPreset('range-trader', {});
    assert.ok(result.ok);
    assert.equal(result.strategy, RANGE_TRADER_STRATEGY);
  });

  it('Guardian at its defaults', () => {
    const result = renderPreset('guardian', {});
    assert.ok(result.ok);
    assert.equal(result.strategy, GUARDIAN_STRATEGY);
  });

  for (const [id, expected] of [
    ['trend-rider', () => TREND_RIDER_STRATEGY],
    ['funding-harvester', () => FUNDING_HARVESTER_STRATEGY],
    ['dca-stacker', () => DCA_STACKER_STRATEGY],
    ['mean-reverter', () => MEAN_REVERTER_STRATEGY],
  ] as const) {
    it(`${id} at its defaults`, () => {
      const result = renderPreset(id, {});
      assert.ok(result.ok);
      assert.equal(result.strategy, expected());
    });
  }

  it('SEN-72 suggested mandates at their defaults', () => {
    const mandate = (id: string): SuggestedMandate => {
      const def = getPreset(id);
      assert.ok(def);
      const r = resolveParams(def, {});
      assert.ok(r.ok);
      return def.suggestedMandate(r.params);
    };
    assert.deepEqual(mandate('trend-rider'), {
      tier: 'wide',
      venues: ['perpl'],
      kuruMarkets: [],
      perplMarkets: ['BTC-PERP'],
      maxOrderNotional: '250',
      maxLeverage: 2,
      depositCaps: [],
      perplCollateral: '250',
      expiryDays: 30,
      softRules: ['one position at a time', 'long only'],
    });
    assert.deepEqual(mandate('funding-harvester'), {
      tier: 'cautious',
      venues: ['perpl', 'kuru'],
      kuruMarkets: ['cbBTC-USDC'],
      perplMarkets: ['BTC-PERP'],
      maxOrderNotional: '51',
      maxLeverage: 2,
      depositCaps: [{ asset: 'USDC', amount: '51' }],
      perplCollateral: '50',
      expiryDays: 30,
      softRules: ['short only', 'Kuru leg matches the short'],
    });
    assert.deepEqual(mandate('dca-stacker'), {
      tier: 'cautious',
      venues: ['kuru'],
      kuruMarkets: ['MON-USDC'],
      perplMarkets: [],
      maxOrderNotional: '11',
      maxLeverage: null,
      depositCaps: [{ asset: 'USDC', amount: '100' }],
      perplCollateral: null,
      expiryDays: 11,
      softRules: ['buy-only', 'one buy per run'],
    });
    assert.deepEqual(mandate('mean-reverter'), {
      tier: 'standard',
      venues: ['kuru'],
      kuruMarkets: ['MON-USDC'],
      perplMarkets: [],
      maxOrderNotional: '50',
      maxLeverage: null,
      depositCaps: [{ asset: 'USDC', amount: '100' }],
      perplCollateral: null,
      expiryDays: 7,
      softRules: ['one position at a time'],
    });
  });

  it('suggested mandates at their defaults', () => {
    const range = getPreset('range-trader');
    const guard = getPreset('guardian');
    assert.ok(range && guard);
    const defaults = (def: PresetDefinition): Params => {
      const r = resolveParams(def, {});
      assert.ok(r.ok);
      return r.params;
    };
    assert.deepEqual(range.suggestedMandate(defaults(range)), {
      tier: 'standard',
      venues: ['kuru'],
      kuruMarkets: ['MON-USDC'],
      perplMarkets: [],
      maxOrderNotional: '50',
      maxLeverage: null,
      depositCaps: [{ asset: 'USDC', amount: '100' }],
      perplCollateral: null,
      expiryDays: 7,
      softRules: ['one position at a time'],
    });
    assert.deepEqual(guard.suggestedMandate(defaults(guard)), {
      tier: 'cautious',
      venues: ['kuru'],
      kuruMarkets: ['MON-USDC'],
      perplMarkets: [],
      maxOrderNotional: '10',
      maxLeverage: null,
      depositCaps: [{ asset: 'MON', amount: '100' }],
      perplCollateral: null,
      expiryDays: 30,
      softRules: ['sell-only'],
    });
  });
});

const RANGE_TRADER_STRATEGY = [
  'Trade MON-USDC on Kuru spot only. Buy near the bottom of the recent range; sell at a target or a stop.',
  '',
  'Every run:',
  '1. Read the 3-day high and low of MON-USDC from 30-minute candles. If no tool gives you candles, or the range is under 2% wide, do not buy this run and say why.',
  '2. If you hold no MON (dust under 1 USDC does not count) and have no open orders, and the mid price is within 1.5% of the range low: record a thesis, then buy at market with at most 40% of your USDC, slippage limit 0.5% above the best ask.',
  '3. Right after a buy, place a GTC limit sell of the MON you bought at 3% above your fill price. That order is the target, and its price tells later runs the entry: entry = its price ÷ 1.03.',
  '4. If you hold MON: the stop is 3% below the entry. If the best bid is at or below it, cancel the resting sell and sell all your MON at market. If you hold MON but no resting sell, you cannot know the entry: sell it at market.',
  '5. Otherwise do nothing.',
  '',
  'The target rests on Kuru as a limit order. The stop is checked every run, not a venue order: between runs price can pass through it, and the sale fills at the price when it is seen.',
].join('\n');
const GUARDIAN_STRATEGY = [
  'Guard up to 100 MON on MON-USDC, Kuru spot. You only ever sell; never buy.',
  '',
  'Every run:',
  '1. If you hold no MON, your job is done: say so in one sentence and end the run.',
  '2. Read the best bid for MON-USDC.',
  '3. If the best bid is at or above 0.05 USDC, or at or below 0.01 USDC: record a thesis naming the line that was crossed and the bid you saw, then sell up to 100 MON (all you hold, if less) at market, slippage limit 2% below the best bid.',
  '4. Otherwise do nothing and end the run in one sentence.',
  '',
  'Both lines are checked every run, not venue orders: between runs price can pass through a line, and the sale fills at the market price when it is seen, which can be past the line.',
].join('\n');
const TREND_RIDER_STRATEGY = [
  'Trade BTC-PERP on Perpl perps only, long only. Join a breakout and trail a stop behind it.',
  '',
  'Every run:',
  '1. Read your BTC-PERP position. If you have one, go to step 4.',
  '2. Read the 1-day high and low of BTC-PERP from 15-minute candles, leaving out the candle still open. If no tool gives you candles, do not open a position this run and say why.',
  "3. If the mid price is above that high: record a thesis, then open a long at market with 25% of your AUSD collateral as margin at 2x leverage (the market's maximum from list_markets, if lower), size = margin x leverage / price, slippage limit 0.5% past the best price. Otherwise do nothing.",
  '4. Long: the stop is 4% below the higher of your entry price and the 1-day high. With no candles, use your entry price alone. If the price has crossed the stop, close the whole position with close_position. Otherwise hold.',
  '',
  'The trailing stop is checked every run, not a venue order: between runs price can pass through it, and the close fills at the price when it is seen. The position is isolated margin: it can lose at most its margin, and a fast move can liquidate it before a run sees the stop.',
].join('\n');
const FUNDING_HARVESTER_STRATEGY = [
  'Earn funding on BTC-PERP, Perpl perps, hedged with cbBTC held on cbBTC-USDC, Kuru spot. You only ever short the perp; never go long it.',
  '',
  'Every run:',
  '1. Read the funding rate of BTC-PERP as a % per 8 hours (convert if the venue reports another interval). If no tool gives you the funding rate, open nothing this run and say why; keep any position you hold.',
  '2. If you have no BTC-PERP short and funding is at or above +0.01% / 8h (shorts are paid): record a thesis, then short at market with 50% of your AUSD collateral as margin at 2x leverage, size = margin x leverage / price, slippage limit 0.5% below the best bid. Then buy the same size of cbBTC on cbBTC-USDC at market with USDC, slippage limit 0.5% above the best ask.',
  '3. If you hold the short and funding is below zero (shorts now pay): close it with close_position and sell the cbBTC you hold on cbBTC-USDC at market, slippage limit 0.5% below the best bid.',
  '4. If you hold the short and the mark price is within 10% of its liquidation price: close it with close_position and sell the cbBTC you hold on cbBTC-USDC at market, slippage limit 0.5% below the best bid.',
  '5. If the cbBTC you hold on Kuru and the short differ in size by more than 5%, buy or sell cbBTC on cbBTC-USDC until they match.',
  '6. Otherwise do nothing.',
  '',
  'The liquidation guard is checked every run, not a venue order: a fast move between runs can liquidate the short first, and it is isolated margin, so that loses its margin. Funding can flip at any time. The hedge is your rule, not the mandate’s: nothing ties the two legs together, so check both every run.',
].join('\n');
const DCA_STACKER_STRATEGY = [
  'Buy MON on MON-USDC, Kuru spot, a fixed amount each run, whatever the price. You only ever buy; never sell.',
  '',
  'Every run (you are run once a day):',
  '1. Read the USDC in your Kuru account and your wallet. If you hold less than 10 USDC in all, your 100 USDC budget is spent: say so and end the run.',
  '2. The buy is the same size every run.',
  '3. Record a thesis, then buy 10 USDC of MON at market, all you hold if less, slippage limit 1% above the best ask. Buy once per run, never more.',
  '',
  'There is no stop and no target: you never sell, and each buy fills at the market price of that run. Buying once per run means that if you are run more often than once a day, you buy more often; the budget is what stops you.',
].join('\n');
const MEAN_REVERTER_STRATEGY = [
  'Trade MON-USDC on Kuru spot only. Fade sharp moves away from the average, betting on a snap back.',
  '',
  'Every run:',
  '1. Read the 1-day average of MON-USDC: the mean close of its 15-minute candles. If no tool gives you candles, open nothing this run and say why; still manage what you hold.',
  '2. If you hold no MON (dust under 1 USDC does not count), have no open orders, and the mid price is 3% or more below the average: record a thesis, then buy at market with at most 40% of your USDC, slippage limit 0.5% above the best ask.',
  '3. Right after a buy, place a GTC limit sell of the MON you bought at 1.5% above your fill price (50% of the 3% stretch). Its price tells later runs the entry: entry = its price / 1.015.',
  '4. If you hold MON: the stop is 3% below the entry. If the best bid is at or below it, cancel the resting sell and sell all your MON at market. If you hold MON but no resting sell, you cannot know the entry: sell it at market.',
  '5. Otherwise do nothing. Never short: Kuru spot only fades drops.',
  '',
  'The target rests on Kuru as a limit order. The stop is checked every run, not a venue order: between runs price can pass through it, and the sale fills at the price when it is seen. A move that keeps going is exactly where this strategy loses.',
].join('\n');
