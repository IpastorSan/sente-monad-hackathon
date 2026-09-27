/**
 * The shapes a preset is made of (SEN-68, plan B-T14a).
 *
 * `ParamSpec` and `SuggestedMandate` are the wire contract's `ParamSpec` and
 * `SuggestedMandateDto` (docs/design/trading/plan-backend.md, "Wire contract"),
 * field for field and with mutable arrays, so `GET /presets` (B-T16b) can hand
 * them out as they are instead of mapping a second, drifting copy.
 */

export type VenueId = 'kuru' | 'perpl';

/** An exact decimal string ("12.5"), never a float — as everywhere on the wire. */
export type Decimal = string;

export type PresetId =
  | 'range-trader'
  | 'guardian'
  | 'trend-rider'
  | 'funding-harvester'
  | 'dca-stacker'
  | 'mean-reverter';

export type ParamValue = string | number | boolean | readonly string[];

/** Resolved parameters: every key of the preset's specs, filled and validated. */
export type Params = Readonly<Record<string, ParamValue>>;

export type NumberParamSpec = {
  key: string;
  label: string;
  type: 'number';
  min: number;
  max: number;
  step: number;
  unit?: '%' | 'x' | 'USDC' | 'AUSD' | 'min' | 'h';
  default: number;
  help?: string;
};

export type EnumParamSpec = {
  key: string;
  label: string;
  type: 'enum';
  options: { value: string; label: string }[];
  default: string;
  help?: string;
};

export type BooleanParamSpec = {
  key: string;
  label: string;
  type: 'boolean';
  default: boolean;
  help?: string;
};

export type MarketParamSpec = {
  key: string;
  label: string;
  type: 'market';
  venue: VenueId | 'any';
  multiple: boolean;
  default: string | string[];
  help?: string;
};

export type ParamSpec = NumberParamSpec | EnumParamSpec | BooleanParamSpec | MarketParamSpec;

export interface SuggestedMandate {
  /** Maps onto the app's mandate presets (apps/mobile/src/agents/presets.ts). */
  tier: 'cautious' | 'standard' | 'wide';
  venues: VenueId[];
  kuruMarkets: string[];
  perplMarkets: string[];
  maxOrderNotional: Decimal;
  maxLeverage: number | null;
  depositCaps: { asset: string; amount: Decimal }[];
  perplCollateral: Decimal | null;
  expiryDays: number;
  /** Rules the strategy follows that the mandate cannot enforce, e.g. 'sell-only'. */
  softRules: string[];
}

export interface ParamError {
  key: string;
  message: string;
}

export interface Rendered {
  strategy: string;
  systemPrompt: string;
}

export interface PresetDefinition {
  id: PresetId;
  /** Bumped whenever `render` changes what an agent is told for the same params. */
  version: number;
  name: string;
  tagline: string;
  description: string;
  venues: readonly VenueId[];
  params: readonly ParamSpec[];
  /** The agent tools the rendered text relies on. */
  tools: readonly string[];
  suggestedCadenceSeconds(p: Params): number;
  suggestedMandate(p: Params): SuggestedMandate;
  render(p: Params): Rendered;
  /**
   * Rules across parameters that one spec cannot express (Guardian's "sell
   * above" must sit above its "sell below"). Runs only on params that already
   * passed every per-key check.
   */
  validate?(p: Params): ParamError[];
}
