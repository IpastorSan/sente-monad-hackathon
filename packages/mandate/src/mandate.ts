/**
 * The trading mandate: what a user has authorized one agent to do.
 *
 * Every field is a refusal the agent will hit, not a preference it may weigh,
 * and the mandate is enforced in two layers that must say the same thing:
 *
 * | Layer | What it bounds | Enforced by |
 * | --- | --- | --- |
 * | 1 — `checkIntent` (`enforce.ts`) | every field, per intent, before signing | our code |
 * | 2 — Privy policy (`policy.ts`) | what the enclave will sign: funding caps, contracts, expiry | Privy's enclave |
 *
 * Layer 2 is the one a compromised server cannot talk its way past, and it is
 * narrower than layer 1, said plainly:
 *
 * - **Perpl order size and leverage are layer 1 only.** Perpl orders are
 *   Ed25519-signed REST calls the exchange forwards and pays gas for; no
 *   transaction of ours carries them. The enclave bounds the *capital* that
 *   reaches Perpl, not what is done with it there.
 * - **Kuru order size is layer 1 only.** `OrderBook.batch` takes tuple arrays,
 *   and nobody has verified that Privy calldata conditions reach inside them. So
 *   the enclave caps the funding step (approve + deposit) and allowlists which
 *   OrderBooks may be called at all.
 * - **Deposit caps are per transaction.** Privy compares each request on its
 *   own; repeating a capped deposit is not refused by the per-transaction rules.
 *   `rollingCap` is the cumulative bound, and it is only proven once the live
 *   probe (MOV-278) has exercised Privy's aggregations.
 *
 * Amounts are bigint atoms, never floats. Every field is required; an optional
 * cap is a cap someone forgets to set. An **empty allowlist allows nothing**.
 */
import type { Decimal } from '@sente/venues';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS, NATIVE_TOKEN } from '@sente/venues/kuru';
import { PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';

import { isDecimal } from './decimal.ts';

export const MANDATE_VERSION = 1;
/** Monad testnet. Both venues are testnet-only deployments today. */
export const MANDATE_CHAIN_ID = 10143;
/** Privy's bounds on a rolling aggregation window: 1 h to 72 h. */
export const ROLLING_WINDOW_MIN_SECONDS = 3_600;
export const ROLLING_WINDOW_MAX_SECONDS = 259_200;

export const VENUE_IDS = ['kuru', 'perpl'] as const;
export type VenueId = (typeof VENUE_IDS)[number];

export interface KuruMandate {
  /** OrderBook proxy addresses the agent may call `batch` on. Empty: no Kuru trading. */
  readonly markets: readonly Address[];
  /**
   * Per-transaction ceiling on moving each token into AccountCore — the
   * `approve` and the `deposit` — in token atoms. A token not listed cannot be
   * deposited. The zero address is native MON, deposited with `value`.
   */
  readonly maxDepositAtoms: Readonly<Record<Address, bigint>>;
}

export interface PerplMandate {
  /** Per-transaction ceiling on AUSD reaching the Exchange, in atoms (6 dp). Enclave-enforced. */
  readonly maxCollateralAtoms: bigint;
  /** Layer 1 only — see the module comment. */
  readonly maxLeverage: number;
  /** Market symbols, e.g. `BTC-PERP`. Layer 1 only. Empty: no Perpl trading. */
  readonly markets: readonly string[];
}

/**
 * A cumulative ceiling on `approve.amount` for one ERC-20 over a rolling window.
 *
 * `token` is not in the issue's sketch of this type: a sum of atoms across
 * tokens of different decimals means nothing, so the window has to name the
 * token it sums.
 */
export interface RollingCap {
  readonly windowSeconds: number;
  readonly capAtoms: bigint;
  readonly token: Address;
}

export interface Mandate {
  readonly version: typeof MANDATE_VERSION;
  readonly chainId: typeof MANDATE_CHAIN_ID;
  /** Unix SECONDS. Valid up to and including this second. */
  readonly expiresAt: number;
  readonly venues: readonly VenueId[];
  readonly kuru: KuruMandate;
  readonly perpl: PerplMandate;
  /** Largest single order, in quote units. Layer 1 only. */
  readonly maxOrderNotional: Decimal;
  readonly rollingCap?: RollingCap;
}

/** A mandate that does not parse. `reason` says which field and why. */
export class MandateError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`invalid mandate: ${reason}`);
    this.name = 'MandateError';
    this.reason = reason;
  }
}

function fail(reason: string): never {
  throw new MandateError(reason);
}

/** An object with no keys outside `keys` (when given). A misspelt cap must not vanish silently. */
function object(value: unknown, where: string, keys?: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (keys) {
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) fail(`${where}.${key} is not a mandate field`);
    }
  }
  return record;
}

function array(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value;
}

/** Atoms arrive as a bigint, or over JSON as a decimal integer string. Never a JS number. */
function atoms(value: unknown, where: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) fail(`${where} is negative`);
    return value;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  return fail(
    `${where} must be a non-negative integer of atoms, as a bigint or a decimal string — never a JS number`,
  );
}

/** Strict: a mixed-case address must carry a correct EIP-55 checksum. */
function address(value: unknown, where: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    fail(`${where} is not a valid address (mixed case must be a correct EIP-55 checksum)`);
  }
  return getAddress(value);
}

function unixSeconds(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${where} must be a positive integer of unix seconds`);
  }
  // 1e11 s is the year 5138; anything above it is a millisecond timestamp,
  // which read as seconds would make a mandate that never expires.
  if (value >= 100_000_000_000) fail(`${where} looks like milliseconds; it must be unix seconds`);
  return value;
}

function parseVenues(value: unknown): VenueId[] {
  const venues: VenueId[] = [];
  for (const [i, raw] of array(value, 'venues').entries()) {
    if (!VENUE_IDS.includes(raw as VenueId)) fail(`venues[${i}] ${String(raw)} is not a venue`);
    if (venues.includes(raw as VenueId)) fail(`venues lists ${String(raw)} twice`);
    venues.push(raw as VenueId);
  }
  return venues;
}

function parseKuru(value: unknown): KuruMandate {
  const kuru = object(value, 'kuru', ['markets', 'maxDepositAtoms']);

  const markets: Address[] = [];
  for (const [i, raw] of array(kuru.markets, 'kuru.markets').entries()) {
    const market = address(raw, `kuru.markets[${i}]`);
    if (!KURU_TESTNET_MARKETS.some((m) => isAddressEqual(m.address, market))) {
      fail(`kuru.markets[${i}] ${market} is not a Kuru testnet market`);
    }
    if (markets.includes(market)) fail(`kuru.markets lists ${market} twice`);
    markets.push(market);
  }

  const tokens = Object.values(KURU_TESTNET_TOKENS);
  const maxDepositAtoms: Record<Address, bigint> = {};
  for (const [raw, cap] of Object.entries(object(kuru.maxDepositAtoms, 'kuru.maxDepositAtoms'))) {
    const token = address(raw, `kuru.maxDepositAtoms key ${raw}`);
    if (!tokens.some((t) => isAddressEqual(t.address, token))) {
      fail(`kuru.maxDepositAtoms names ${token}, which is not a Kuru testnet token`);
    }
    if (token in maxDepositAtoms) fail(`kuru.maxDepositAtoms lists ${token} twice`);
    maxDepositAtoms[token] = atoms(cap, `kuru.maxDepositAtoms[${token}]`);
  }

  return { markets, maxDepositAtoms };
}

function parsePerpl(value: unknown): PerplMandate {
  const perpl = object(value, 'perpl', ['maxCollateralAtoms', 'maxLeverage', 'markets']);
  const maxCollateralAtoms = atoms(perpl.maxCollateralAtoms, 'perpl.maxCollateralAtoms');

  const maxLeverage = perpl.maxLeverage;
  if (typeof maxLeverage !== 'number' || !Number.isFinite(maxLeverage) || maxLeverage <= 0) {
    fail('perpl.maxLeverage must be a positive finite number');
  }

  const markets: string[] = [];
  for (const [i, raw] of array(perpl.markets, 'perpl.markets').entries()) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.trim() !== raw) {
      fail(`perpl.markets[${i}] must be a market symbol`);
    }
    if (markets.includes(raw)) fail(`perpl.markets lists ${raw} twice`);
    markets.push(raw);
  }

  return { maxCollateralAtoms, maxLeverage, markets };
}

function parseRollingCap(value: unknown, kuru: KuruMandate): RollingCap {
  const cap = object(value, 'rollingCap', ['windowSeconds', 'capAtoms', 'token']);
  const windowSeconds = cap.windowSeconds;
  if (
    typeof windowSeconds !== 'number' ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < ROLLING_WINDOW_MIN_SECONDS ||
    windowSeconds > ROLLING_WINDOW_MAX_SECONDS
  ) {
    fail(
      `rollingCap.windowSeconds must be an integer from ${ROLLING_WINDOW_MIN_SECONDS} to ` +
        `${ROLLING_WINDOW_MAX_SECONDS}`,
    );
  }
  const capAtoms = atoms(cap.capAtoms, 'rollingCap.capAtoms');
  if (capAtoms === 0n) fail('rollingCap.capAtoms must be positive');

  // The window sums `approve.amount`, so it can only bound an ERC-20 this
  // mandate funds: a Kuru deposit token other than native MON, or Perpl's AUSD.
  const token = address(cap.token, 'rollingCap.token');
  const fundable = [
    ...Object.keys(kuru.maxDepositAtoms).filter((t) => !isAddressEqual(t as Address, NATIVE_TOKEN)),
    PERPL_TESTNET_CONTRACTS.collateral,
  ];
  if (!fundable.some((t) => isAddressEqual(t as Address, token))) {
    fail(`rollingCap.token ${token} is not an ERC-20 this mandate funds`);
  }

  return { windowSeconds, capAtoms, token };
}

const MANDATE_KEYS = [
  'version',
  'chainId',
  'expiresAt',
  'venues',
  'kuru',
  'perpl',
  'maxOrderNotional',
  'rollingCap',
] as const;

/**
 * Validate an untrusted mandate — from JSON, from a client, from anywhere.
 *
 * Fails closed with a {@link MandateError} naming the field: unknown keys,
 * JS-number amounts, addresses with a broken checksum, contracts that are not
 * known Kuru testnet markets or tokens, and millisecond timestamps are all
 * refused rather than coerced. Addresses come back checksummed.
 */
export function parseMandate(input: unknown): Mandate {
  const m = object(input, 'mandate', MANDATE_KEYS);
  if (m.version !== MANDATE_VERSION) fail(`version must be ${MANDATE_VERSION}`);
  if (m.chainId !== MANDATE_CHAIN_ID) fail(`chainId must be ${MANDATE_CHAIN_ID}`);

  const expiresAt = unixSeconds(m.expiresAt, 'expiresAt');
  const venues = parseVenues(m.venues);
  const kuru = parseKuru(m.kuru);
  const perpl = parsePerpl(m.perpl);
  if (!isDecimal(m.maxOrderNotional)) {
    fail('maxOrderNotional must be a non-negative decimal string, e.g. "250.5"');
  }
  const rollingCap = m.rollingCap === undefined ? undefined : parseRollingCap(m.rollingCap, kuru);

  return {
    version: MANDATE_VERSION,
    chainId: MANDATE_CHAIN_ID,
    expiresAt,
    venues,
    kuru,
    perpl,
    maxOrderNotional: m.maxOrderNotional,
    ...(rollingCap ? { rollingCap } : {}),
  };
}
