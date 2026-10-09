import type { Logger } from '@nestjs/common';
import { KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { PERPL_COLLATERAL_DECIMALS, PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import { formatUnits, parseUnits, type Address, type Hex } from 'viem';

/** DI token for the resolved, validated starter-kit configuration. */
export const STARTER_KIT_CONFIG = Symbol('STARTER_KIT_CONFIG');

/** One token of the kit: what it is, how much, and the gas its `transfer` is sent with. */
export interface StarterKitToken {
  symbol: 'AUSD' | 'USDC';
  address: Address;
  decimals: number;
  /** Atoms per user. */
  atoms: bigint;
  /** Explicit, measured — see {@link STARTER_KIT_GAS}. */
  gasLimit: bigint;
}

export type StarterKitConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** `STARTER_DRIP_PRIVATE_KEY`. Never logged, never echoed in an error. */
      senderKey: Hex;
      /** Sent in this order, one after the other, from the one sender. */
      tokens: readonly StarterKitToken[];
      /** Users granted a kit per UTC day, failed attempts included. */
      dailyCapUsers: number;
      rpcUrl: string | undefined;
      receiptTimeoutMs: number;
    };

/**
 * Gas for one ERC-20 `transfer` to a wallet that holds none of the token yet —
 * the dear case, its balance slot going 0 -> nonzero, which is every new user.
 * Monad charges the LIMIT, even on a revert (CLAUDE.md gotcha 4), so each is a
 * measurement plus ~12% and not a round guess; the floor and the +20% ceiling
 * are pinned in `starter-kit.config.spec.ts`.
 *
 * - AUSD: 72,918 by `eth_estimateGas` to a fresh address (SEN-170, 2026-10-09;
 *   the same figure `docs/monad-testnet-assets.md` recorded on 2026-09-10).
 *   82,000 is `MONAD_GAS_LIMITS.erc20Transfer` in apps/mobile. A flat 65,000
 *   is known to run out: two AUSD transfers reverted at it on 2026-09-10.
 * - USDC: 63,976 by `eth_estimateGas` to a fresh address (SEN-170,
 *   2026-10-09). Kuru's USDC is cheaper than AUSD (46,525 between two
 *   existing holders, SEN-15), so it gets its own limit rather than AUSD's.
 */
export const STARTER_KIT_GAS = {
  AUSD: 82_000n,
  USDC: 72_000n,
} as const;

export const STARTER_KIT_DEFAULTS = {
  /** Perpl needs 100 AUSD to open an account; 250 leaves room to trade. */
  ausd: '250',
  /** Kuru's minimum notional is 10 USDC; 100 covers several orders. */
  usdc: '100',
  dailyCapUsers: 50,
  /** Monad finalises in about a second; 15 s is an RPC in trouble. Same as the gas drip. */
  receiptTimeoutMs: 15_000,
} as const;

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type Env = Record<string, string | undefined>;

/**
 * Other keys this API sends transactions from. Two senders on one key share a
 * nonce sequence that neither of them tracks, so each would replace or bounce
 * the other's transactions: boot refuses instead.
 */
const OTHER_SENDER_KEYS = [
  'GAS_DRIP_PRIVATE_KEYS',
  'ERC8004_REGISTRAR_KEY',
  'ERC8004_REVIEWER_KEY',
];

function parseAmount(
  raw: string | undefined,
  fallback: string,
  decimals: number,
  name: string,
  { allowZero = false }: { allowZero?: boolean } = {},
) {
  const value = raw?.trim() ? raw.trim() : fallback;
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a positive decimal amount, got ${JSON.stringify(value)}`);
  }
  const atoms = parseUnits(value, decimals);
  if (atoms < 0n || (atoms === 0n && !allowZero)) {
    throw new Error(`${name} must be greater than zero, got ${value}`);
  }
  return atoms;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function keysIn(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((key) => key.trim().toLowerCase())
    .filter((key) => key.length > 0);
}

/**
 * Pure env -> config (SEN-170). `STARTER_DRIP_PRIVATE_KEY` unset is a valid
 * state: the feature is off and registration is untouched. A bad value fails
 * at boot, never on a user's register.
 */
export function loadStarterKitConfig(env: Env = process.env): StarterKitConfig {
  const key = env.STARTER_DRIP_PRIVATE_KEY?.trim();
  if (!key) return { enabled: false };

  if (!PRIVATE_KEY_PATTERN.test(key)) {
    // Deliberately does not echo the value.
    throw new Error('STARTER_DRIP_PRIVATE_KEY is not a 0x-prefixed 32-byte hex private key');
  }
  for (const name of OTHER_SENDER_KEYS) {
    if (keysIn(env[name]).includes(key.toLowerCase())) {
      throw new Error(
        `STARTER_DRIP_PRIVATE_KEY is also in ${name}; two senders on one key collide on ` +
          'nonces. Give the starter kit its own key.',
      );
    }
  }

  const ausd = parseAmount(
    env.STARTER_DRIP_AUSD,
    STARTER_KIT_DEFAULTS.ausd,
    PERPL_COLLATERAL_DECIMALS,
    'STARTER_DRIP_AUSD',
  );
  // `0` leaves the Kuru leg out (SEN-185): Kuru's current USDC has no public
  // faucet, and a kit whose sender lacks a token sends nothing at all — not
  // even the AUSD Perpl needs.
  const usdc = parseAmount(
    env.STARTER_DRIP_USDC,
    STARTER_KIT_DEFAULTS.usdc,
    KURU_TESTNET_TOKENS.USDC.decimals,
    'STARTER_DRIP_USDC',
    { allowZero: true },
  );

  return {
    enabled: true,
    senderKey: key as Hex,
    tokens: [
      {
        symbol: 'AUSD',
        address: PERPL_TESTNET_CONTRACTS.collateral,
        decimals: PERPL_COLLATERAL_DECIMALS,
        atoms: ausd,
        gasLimit: STARTER_KIT_GAS.AUSD,
      },
      ...(usdc > 0n
        ? [
            {
              symbol: 'USDC' as const,
              address: KURU_TESTNET_TOKENS.USDC.address,
              decimals: KURU_TESTNET_TOKENS.USDC.decimals,
              atoms: usdc,
              gasLimit: STARTER_KIT_GAS.USDC,
            },
          ]
        : []),
    ],
    dailyCapUsers: parsePositiveInt(
      env.STARTER_DRIP_DAILY_CAP_USERS,
      STARTER_KIT_DEFAULTS.dailyCapUsers,
      'STARTER_DRIP_DAILY_CAP_USERS',
    ),
    rpcUrl: env.MONAD_TESTNET_RPC_URL?.trim() || undefined,
    receiptTimeoutMs: STARTER_KIT_DEFAULTS.receiptTimeoutMs,
  };
}

/** Boot-time summary, logged once. Never logs the key; the sender address is logged by the module. */
export function describeStarterKitConfig(config: StarterKitConfig, logger: Logger): void {
  if (!config.enabled) {
    logger.log('STARTER_DRIP_PRIVATE_KEY is unset; the starter kit is off');
    return;
  }
  const kit = config.tokens
    .map((token) => `${formatUnits(token.atoms, token.decimals)} ${token.symbol}`)
    .join(' + ');
  logger.log(
    `starter kit ${kit} per new user, dailyCap=${config.dailyCapUsers} users, ` +
      `gas ${config.tokens.map((token) => `${token.symbol}=${token.gasLimit}`).join(' ')}`,
  );
}
