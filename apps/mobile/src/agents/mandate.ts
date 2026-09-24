/**
 * The mandate as a person edits it, and as a person reads it back.
 *
 * `buildMandate` turns the hire form into the exact object the API's
 * `parseMandate` accepts; the API is still the validator, this only refuses
 * early what it would refuse anyway, next to the field that caused it.
 *
 * `describeMandate` is the review step. Every limit is labelled with WHO
 * enforces it, because the two layers are not equally strong
 * (`packages/mandate/src/mandate.ts`):
 *
 * - The ENCLAVE (Privy's policy engine) will not sign past Kuru's market
 *   allowlist, the per-deposit caps, the Perpl collateral cap or the expiry.
 *   A compromised server cannot talk its way past these.
 * - SENTE checks order size, leverage and Perpl's market list before it
 *   sends anything. Perpl orders are Ed25519-signed REST calls, and Kuru's
 *   order sizes sit inside batch calldata the policy can't read, so the enclave
 *   never sees them.
 *
 * Plain node, no React Native, so `mandate.test.ts` runs without a device.
 */
import {
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  type KuruMarketConfig,
} from '@sente/venues/kuru';
import { getAddress, isAddressEqual, type Address } from 'viem';

import { formatAtoms, normalizeDecimal, parseAmount } from './amounts.ts';
import { MANDATE_CHAIN_ID, MANDATE_VERSION, type AgentMandate, type VenueId } from './api.ts';

export type Token = {
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
};

/**
 * Perpl's collateral token, Agora AUSD. Mirrors `PERPL_TESTNET_CONTRACTS.collateral`
 * and `PERPL_COLLATERAL_DECIMALS` rather than importing them, because
 * `@sente/venues/perpl` would bundle the whole Perpl adapter into the app for
 * one address. `mandate.test.ts` pins the two equal.
 */
export const AUSD: Token = {
  symbol: 'AUSD',
  address: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
  decimals: 6,
};

/**
 * The three other Perpl constants a compiled policy names, mirrored for the
 * same reason as {@link AUSD} and pinned equal by `mandate.test.ts`.
 *
 * `approval.ts` needs them to say what a mandate's rules must look like: the
 * Exchange is the `to` of the Perpl transaction rules and the spender of its
 * approval, and the enrollment rule is pinned to a domain with no contract and
 * to this exact statement. Without them the app could only check that a Perpl
 * rule is *a* rule, which is no check at all — a typed-data rule the app cannot
 * read is a signature the agent could be asked for on anything.
 */
export const PERPL_EXCHANGE: Address = '0x1964C32f0bE608E7D29302AFF5E61268E72080cc';

/** Perpl's API-key domain names no contract; the statement is what pins the rule. */
export const PERPL_ENROLL_VERIFYING_CONTRACT: Address =
  '0x0000000000000000000000000000000000000000';

export const PERPL_ENROLL_STATEMENT =
  'I authorize the creation of Perpl API key with the specified scope and parameters';

export const KURU_MARKETS: readonly KuruMarketConfig[] = KURU_TESTNET_MARKETS;
export const KURU_TOKENS: readonly Token[] = Object.values(KURU_TESTNET_TOKENS);

export function tokenFor(address: string): Token | undefined {
  return [...KURU_TOKENS, AUSD].find((token) => isAddressEqual(token.address, address as Address));
}

export function marketFor(address: string): KuruMarketConfig | undefined {
  return KURU_MARKETS.find((market) => isAddressEqual(market.address, address as Address));
}

const DAY_SECONDS = 86_400;
export const EXPIRY_PRESETS_DAYS = [1, 7, 30, 90] as const;

export type MandateForm = {
  kuru: boolean;
  perpl: boolean;
  /** Kuru OrderBook addresses. */
  kuruMarkets: Address[];
  /** Per-deposit cap by token SYMBOL, as typed. Blank: the token can't be deposited. */
  depositCaps: Record<string, string>;
  /** AUSD, as typed. */
  perplCollateral: string;
  /** Market symbols, comma or space separated, as typed. */
  perplMarkets: string;
  maxLeverage: string;
  /** Quote units, as typed. */
  maxOrderNotional: string;
  /** Unix seconds. */
  expiresAt: number;
  /**
   * WHERE THE MONEY GOES HOME TO (SEN-17): the user's own wallet address.
   *
   * Not typed by anyone — the screens fill it from `GET /wallet` — but it is part
   * of the form because it is part of the mandate that gets compiled, and the
   * phone has to send the same address the API resolves or the two disagree and
   * the amend is refused (`approval.ts` fails closed by design).
   *
   * Absent when the wallet has not registered yet: the mandate then compiles with
   * no exit rule, which is what agents hired before SEN-17 have.
   */
  returnTo?: Address;
};

export type MandateField =
  | 'venues'
  | 'kuruMarkets'
  | 'depositCaps'
  | 'perplCollateral'
  | 'perplMarkets'
  | 'maxLeverage'
  | 'maxOrderNotional'
  | 'expiresAt';

export type MandateErrors = Partial<Record<MandateField, string>>;

export type BuildResult =
  { ok: true; mandate: AgentMandate } | { ok: false; errors: MandateErrors };

/**
 * A deliberately small starting mandate: one market, one cap, a week.
 *
 * `returnTo` is the caller's own wallet when the screen knows it — the way out
 * is not a choice the user makes, it is the account they signed in with.
 */
export function defaultMandateForm(now: number, returnTo?: Address): MandateForm {
  const monUsdc = KURU_MARKETS.find((market) => market.symbol === 'MON-USDC');
  return {
    kuru: true,
    perpl: false,
    kuruMarkets: monUsdc ? [monUsdc.address] : [],
    depositCaps: { USDC: '100' },
    perplCollateral: '',
    perplMarkets: '',
    maxLeverage: '2',
    maxOrderNotional: '50',
    expiresAt: now + 7 * DAY_SECONDS,
    ...(returnTo ? { returnTo: getAddress(returnTo) } : {}),
  };
}

/** The tokens a deposit cap makes sense for: the bases and quotes of the chosen markets. */
export function relevantDepositTokens(markets: readonly Address[]): Token[] {
  const chosen = KURU_MARKETS.filter((market) =>
    markets.some((address) => isAddressEqual(address, market.address)),
  );
  return KURU_TOKENS.filter((token) =>
    chosen.some(
      (market) =>
        isAddressEqual(market.base.address, token.address) ||
        isAddressEqual(market.quote.address, token.address),
    ),
  );
}

export function parsePerplMarkets(text: string): string[] {
  const markets: string[] = [];
  for (const symbol of text.split(/[\s,]+/)) {
    if (symbol !== '' && !markets.includes(symbol)) markets.push(symbol);
  }
  return markets;
}

export function buildMandate(form: MandateForm, now: number): BuildResult {
  const errors: MandateErrors = {};
  const venues: VenueId[] = [];
  if (form.kuru) venues.push('kuru');
  if (form.perpl) venues.push('perpl');
  if (venues.length === 0) errors.venues = 'Turn on at least one venue.';

  const kuru: AgentMandate['kuru'] = { markets: [], maxDepositAtoms: {} };
  if (form.kuru) {
    kuru.markets = form.kuruMarkets.map((market) => getAddress(market));
    if (kuru.markets.length === 0) errors.kuruMarkets = 'Pick at least one market.';

    for (const token of relevantDepositTokens(kuru.markets)) {
      const typed = form.depositCaps[token.symbol]?.trim() ?? '';
      if (typed === '') continue;
      const atoms = parseAmount(typed, token.decimals);
      if (atoms === null) {
        errors.depositCaps = `${token.symbol}: enter an amount with at most ${token.decimals} decimals.`;
        continue;
      }
      if (atoms > 0n) kuru.maxDepositAtoms[getAddress(token.address)] = atoms;
    }
    if (
      !errors.depositCaps &&
      kuru.markets.length > 0 &&
      Object.keys(kuru.maxDepositAtoms).length === 0
    ) {
      errors.depositCaps =
        'Set a cap for at least one token, or the agent can’t fund a Kuru order.';
    }
  }

  const perpl: AgentMandate['perpl'] = { maxCollateralAtoms: 0n, maxLeverage: 1, markets: [] };
  if (form.perpl) {
    const collateral = parseAmount(form.perplCollateral, AUSD.decimals);
    if (collateral === null || collateral === 0n) {
      errors.perplCollateral = 'Enter the most AUSD one transfer may move into Perpl.';
    } else {
      perpl.maxCollateralAtoms = collateral;
    }

    perpl.markets = parsePerplMarkets(form.perplMarkets);
    if (perpl.markets.length === 0)
      errors.perplMarkets = 'Name at least one market, e.g. BTC-PERP.';

    const leverage = normalizeDecimal(form.maxLeverage);
    const value = leverage === null ? Number.NaN : Number(leverage);
    if (!Number.isFinite(value) || value <= 0) {
      errors.maxLeverage = 'Enter a leverage above zero, e.g. 3.';
    } else {
      perpl.maxLeverage = value;
    }
  }

  const notional = normalizeDecimal(form.maxOrderNotional);
  if (notional === null || notional === '0') {
    errors.maxOrderNotional = 'Enter the largest single order, in quote units.';
  }

  if (!Number.isSafeInteger(form.expiresAt) || form.expiresAt <= now) {
    errors.expiresAt = 'Pick an expiry in the future.';
  }

  if (Object.keys(errors).length > 0 || notional === null) return { ok: false, errors };

  return {
    ok: true,
    mandate: {
      version: MANDATE_VERSION,
      chainId: MANDATE_CHAIN_ID,
      expiresAt: form.expiresAt,
      venues,
      kuru,
      perpl,
      maxOrderNotional: notional,
      // The API resolves this from the account anyway and refuses a mandate
      // naming anything else; sending it is what lets the phone know which rules
      // to expect back (SEN-17).
      ...(form.returnTo ? { returnTo: getAddress(form.returnTo) } : {}),
    },
  };
}

/**
 * The inverse of `buildMandate`, for amending an agent's current mandate.
 *
 * `returnTo` comes across unchanged, so an amend keeps the exit the agent already
 * has; the screen overrides it with the live wallet address when it has one.
 */
export function formFromMandate(mandate: AgentMandate): MandateForm {
  const depositCaps: Record<string, string> = {};
  for (const [address, atoms] of Object.entries(mandate.kuru.maxDepositAtoms)) {
    const token = tokenFor(address);
    if (token) depositCaps[token.symbol] = formatAtoms(atoms, token.decimals, { group: false });
  }
  const perpl = mandate.venues.includes('perpl');
  return {
    kuru: mandate.venues.includes('kuru'),
    perpl,
    kuruMarkets: [...mandate.kuru.markets],
    depositCaps,
    perplCollateral: perpl
      ? formatAtoms(mandate.perpl.maxCollateralAtoms, AUSD.decimals, { group: false })
      : '',
    perplMarkets: mandate.perpl.markets.join(', '),
    maxLeverage: perpl ? String(mandate.perpl.maxLeverage) : '2',
    maxOrderNotional: mandate.maxOrderNotional,
    expiresAt: mandate.expiresAt,
    ...(mandate.returnTo ? { returnTo: mandate.returnTo } : {}),
  };
}

export type Enforcer = 'enclave' | 'sente';

export type MandateLimit = {
  /** Stable key, e.g. `kuru.deposit.USDC`. */
  id: string;
  label: string;
  value: string;
  enforcer: Enforcer;
};

export const ENFORCERS: Record<Enforcer, { title: string; detail: string }> = {
  enclave: {
    title: 'Enforced by the enclave',
    detail:
      'Compiled into the agent wallet’s signing policy. Its key can’t sign past these, whatever ' +
      'the agent is told.',
  },
  sente: {
    title: 'Enforced by Sente',
    detail:
      'Checked by Sente before each order goes out. Perpl orders are signed API calls and Kuru ' +
      'order sizes sit inside batched calldata, so the enclave never sees them.',
  },
};

/** UTC, minute precision: the same string on every device. */
export function formatExpiry(expiresAt: number): string {
  return `${new Date(expiresAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatNotional(notional: string): string {
  const [whole = '0', fraction] = notional.split('.');
  return fraction ? `${groupDigits(whole)}.${fraction}` : groupDigits(whole);
}

function groupDigits(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The review: one row per limit, each labelled with who enforces it. */
export function describeMandate(mandate: AgentMandate): MandateLimit[] {
  const limits: MandateLimit[] = [];

  if (mandate.venues.includes('kuru')) {
    limits.push({
      id: 'kuru.markets',
      label: 'Kuru markets',
      value:
        mandate.kuru.markets.map((address) => marketFor(address)?.symbol ?? address).join(', ') ||
        'None',
      enforcer: 'enclave',
    });
    for (const [address, atoms] of Object.entries(mandate.kuru.maxDepositAtoms)) {
      const token = tokenFor(address);
      const symbol = token?.symbol ?? address;
      limits.push({
        id: `kuru.deposit.${symbol}`,
        label: `${symbol} per Kuru deposit`,
        value: `${token ? formatAtoms(atoms, token.decimals) : atoms.toString()} ${symbol}`,
        enforcer: 'enclave',
      });
    }
  }

  if (mandate.venues.includes('perpl')) {
    limits.push({
      id: 'perpl.collateral',
      label: 'AUSD per transfer into Perpl',
      value: `${formatAtoms(mandate.perpl.maxCollateralAtoms, AUSD.decimals)} AUSD`,
      enforcer: 'enclave',
    });
    limits.push({
      id: 'perpl.markets',
      label: 'Perpl markets',
      value: mandate.perpl.markets.join(', ') || 'None',
      enforcer: 'sente',
    });
    limits.push({
      id: 'perpl.leverage',
      label: 'Max leverage',
      value: `${mandate.perpl.maxLeverage}×`,
      enforcer: 'sente',
    });
  }

  limits.push({
    id: 'maxOrderNotional',
    label: 'Largest single order',
    value: `${formatNotional(mandate.maxOrderNotional)} in quote units`,
    enforcer: 'sente',
  });

  if (mandate.rollingCap) {
    const token = tokenFor(mandate.rollingCap.token);
    const symbol = token?.symbol ?? mandate.rollingCap.token;
    limits.push({
      id: 'rollingCap',
      label: `${symbol} approved per ${Math.round(mandate.rollingCap.windowSeconds / 3600)} h`,
      value: `${token ? formatAtoms(mandate.rollingCap.capAtoms, token.decimals) : mandate.rollingCap.capAtoms.toString()} ${symbol}`,
      enforcer: 'enclave',
    });
  }

  limits.push({
    id: 'expiresAt',
    label: 'Expires',
    value: formatExpiry(mandate.expiresAt),
    enforcer: 'enclave',
  });

  // The way out (SEN-17), and it belongs beside the limits rather than in some
  // footnote: it is the answer to "how do I get my money back", and it is
  // enforced the same way the caps are — the agent's key can sign a transfer to
  // this address and to nowhere else, revoked or expired.
  limits.push({
    id: 'returnTo',
    label: 'Funds can only return to',
    // The whole address, never shortened: this row is read before granting an
    // agent authority, and a truncated destination is not something to trust.
    value: mandate.returnTo ?? 'Nowhere — this agent has no way out',
    enforcer: 'enclave',
  });

  return limits;
}
