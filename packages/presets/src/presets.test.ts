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
        // The longest Kuru symbol stretches the text the most.
        return [spec.default, 'cbBTC-USDC'];
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
      assert.equal(dto.defaults.params['market'], 'MON-USDC');
      assert.ok(dto.defaults.suggestedCadenceSeconds >= 60);
      const mandate = dto.defaults.suggestedMandate;
      assert.match(mandate.maxOrderNotional, MANDATE_DECIMAL);
      for (const cap of mandate.depositCaps) assert.match(cap.amount, MANDATE_DECIMAL);
      assert.deepEqual(mandate.kuruMarkets, ['MON-USDC']);
    });

    it('renders defaults and every extreme within the API limits', () => {
      const combos = extremes(def);
      let rendered = 0;
      for (const raw of combos) {
        const result = renderPreset(def.id, raw);
        // Guardian's extremes include lines the wrong way round; those must be refused.
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

    it('says the stop is checked every run, not a venue order', () => {
      const result = renderPreset(def.id, {});
      assert.ok(result.ok);
      assert.match(result.strategy, /checked every run, not (a venue order|venue orders)/);
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

  it('runs a preset’s cross-field rule after the per-key checks', () => {
    assert.deepEqual(renderPreset('guardian', { sellAbove: 0.01, sellBelow: 0.02 }), {
      ok: false,
      errors: [{ key: 'sellBelow', message: 'must be below the sell-above line' }],
    });
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
