/**
 * Parameter validation and the small formatting helpers the renders share
 * (SEN-68, plan B-T14a).
 *
 * `resolveParams` is the one gate between what a phone submits and what a
 * preset renders: the API runs it on hire (B-T15), so a preset's `render` may
 * assume every key is present, typed and in range.
 */
import type {
  MarketParamSpec,
  ParamError,
  ParamSpec,
  ParamValue,
  Params,
  PresetDefinition,
} from './types.ts';

/**
 * Kuru's four testnet spot markets, mirrored from `KURU_TESTNET_MARKETS` in
 * `@sente/venues/kuru`. Mirrored rather than imported so this package has no
 * dependencies: the phone loads it through Metro, and the venues entry would
 * bundle viem and the Kuru adapter just to read four strings.
 */
export const KURU_SPOT_MARKETS: readonly string[] = [
  'MON-USDC',
  'WETH-USDC',
  'cbBTC-USDC',
  'XAUt-USDC',
];

/**
 * Perpl lists its markets at runtime, so only the shape is checked here; the
 * mandate still decides which ones an agent may touch.
 */
const PERPL_MARKET = /^[A-Za-z0-9]{1,16}-PERP$/;

export type ResolveResult = { ok: true; params: Params } | { ok: false; errors: ParamError[] };

export function resolveParams(
  def: Pick<PresetDefinition, 'params' | 'validate'>,
  raw: Record<string, unknown>,
): ResolveResult {
  const errors: ParamError[] = [];
  const known = new Set(def.params.map((spec) => spec.key));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push({ key, message: 'is not a parameter of this preset' });
  }

  const params: Record<string, ParamValue> = {};
  for (const spec of def.params) {
    const value = raw[spec.key];
    if (value === undefined) {
      params[spec.key] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
      continue;
    }
    const message = check(spec, value);
    if (message) errors.push({ key: spec.key, message });
    else params[spec.key] = value as ParamValue;
  }

  if (errors.length > 0) return { ok: false, errors };
  const crossErrors = def.validate?.(params) ?? [];
  return crossErrors.length > 0 ? { ok: false, errors: crossErrors } : { ok: true, params };
}

function check(spec: ParamSpec, value: unknown): string | undefined {
  switch (spec.type) {
    case 'number': {
      // Numbers only, never numeric strings: the phone sends what the slider
      // holds, and accepting "3" would make `"3" === 3` a customisation later.
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (value < spec.min || value > spec.max) {
        return `must be between ${formatNumber(spec.min)} and ${formatNumber(spec.max)}`;
      }
      if (!onStep(value, spec.min, spec.step)) {
        return `must be a multiple of ${formatNumber(spec.step)}`;
      }
      return undefined;
    }
    case 'enum':
      if (typeof value !== 'string' || !spec.options.some((o) => o.value === value)) {
        return `must be one of ${spec.options.map((o) => o.value).join(', ')}`;
      }
      return undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false';
    case 'market':
      return checkMarket(spec, value);
  }
}

function checkMarket(spec: MarketParamSpec, value: unknown): string | undefined {
  if (spec.multiple) {
    if (!Array.isArray(value) || value.length === 0) return 'must be a non-empty list of markets';
    if (new Set(value).size !== value.length) return 'must not repeat a market';
    for (const market of value) {
      const message = checkOneMarket(spec, market);
      if (message) return message;
    }
    return undefined;
  }
  return checkOneMarket(spec, value);
}

function checkOneMarket(spec: MarketParamSpec, value: unknown): string | undefined {
  if (typeof value !== 'string') return 'must be a market symbol';
  const kuru = KURU_SPOT_MARKETS.includes(value);
  const perpl = PERPL_MARKET.test(value);
  const ok = spec.venue === 'kuru' ? kuru : spec.venue === 'perpl' ? perpl : kuru || perpl;
  return ok ? undefined : `${value} is not a ${spec.venue === 'any' ? '' : `${spec.venue} `}market`;
}

/** Tolerant to binary fractions: 0.1 steps from 0.5 must accept 1.5. */
function onStep(value: number, min: number, step: number): boolean {
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/**
 * A number as the renders print it: no float noise ("0.30000000000000004"),
 * no trailing zeros, never an exponent within the ranges the specs allow.
 */
export function formatNumber(value: number): string {
  return String(Number(value.toFixed(8)));
}

/** "MON-USDC" → MON and USDC. Kuru spot symbols are always base-quote. */
export function marketAssets(market: string): { base: string; quote: string } {
  const [base = market, quote = 'USDC'] = market.split('-');
  return { base, quote };
}

// Typed reads for the renders. `resolveParams` has already guaranteed the
// type, so a mismatch here is a bug in a preset, and it throws.

export function num(p: Params, key: string): number {
  const value = p[key];
  if (typeof value !== 'number') throw new TypeError(`preset param ${key} is not a number`);
  return value;
}

export function str(p: Params, key: string): string {
  const value = p[key];
  if (typeof value !== 'string') throw new TypeError(`preset param ${key} is not a string`);
  return value;
}
