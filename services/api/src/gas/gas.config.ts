import { Logger } from '@nestjs/common';
import { parseEther, formatEther, type Hex } from 'viem';

/** DI token for the resolved, validated drip configuration. */
export const GAS_DRIP_CONFIG = Symbol('GAS_DRIP_CONFIG');

export interface GasDripRateLimitConfig {
  /** Requests allowed per IP per window. Coarse on purpose — see IpRateLimiter. */
  max: number;
  windowMs: number;
}

export interface GasDripConfig {
  /**
   * Faucet sender keys, read from `GAS_DRIP_PRIVATE_KEYS` (comma-separated).
   * NEVER hardcoded, never committed. An empty list is a valid state: the API
   * boots and `POST /gas/drip` refuses with `faucet_unconfigured`.
   */
  senderKeys: readonly Hex[];
  /** Amount handed to each new account. Default 0.1 MON. */
  amountWei: bigint;
  /** Global outflow ceiling per UTC day, checked before any send. */
  dailyCapWei: bigint;
  /**
   * Explicit gas limit for the native transfer. Monad charges on gas_limit,
   * not gas used, so this is hard-coded rather than estimated — see CLAUDE.md
   * gotcha 4 and MONAD_TX_DEFAULTS in apps/mobile/src/chain/client.ts.
   */
  gasLimit: bigint;
  /** Optional RPC override; falls back to viem's default for monadTestnet. */
  rpcUrl: string | undefined;
  rateLimit: GasDripRateLimitConfig;
  /**
   * Local/CI only. Runs every guard for real but never broadcasts, returning a
   * synthetic tx hash. Lets the refusal paths be exercised end to end without a
   * funded key. Refuses to switch on when NODE_ENV=production.
   */
  dryRun: boolean;
}

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Absolute ceiling on rotating senders — more keys is more funding surface. */
const MAX_SENDER_KEYS = 5;

export const GAS_DRIP_DEFAULTS = {
  amountMon: '0.1',
  dailyCapMon: '25',
  gasLimit: 21_000n,
  rateLimitMax: 3,
  rateLimitWindowMs: 15 * 60 * 1000,
} as const;

function parseMon(raw: string | undefined, fallback: string, name: string): bigint {
  const value = raw?.trim() ? raw.trim() : fallback;
  let wei: bigint;
  try {
    wei = parseEther(value);
  } catch {
    throw new Error(`${name} must be a decimal MON amount, got ${JSON.stringify(value)}`);
  }
  if (wei <= 0n) {
    throw new Error(`${name} must be greater than zero, got ${value}`);
  }
  return wei;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseSenderKeys(raw: string | undefined): readonly Hex[] {
  const keys = (raw ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  for (const [index, key] of keys.entries()) {
    if (!PRIVATE_KEY_PATTERN.test(key)) {
      // Deliberately does not echo the value.
      throw new Error(
        `GAS_DRIP_PRIVATE_KEYS entry ${index} is not a 0x-prefixed 32-byte hex private key`,
      );
    }
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error('GAS_DRIP_PRIVATE_KEYS contains duplicate keys; rotation would be pointless');
  }
  if (keys.length > MAX_SENDER_KEYS) {
    throw new Error(`GAS_DRIP_PRIVATE_KEYS holds ${keys.length} keys, max is ${MAX_SENDER_KEYS}`);
  }
  return keys as readonly Hex[];
}

/**
 * Pure env -> config. Kept free of Nest so it can be unit tested directly and
 * so a bad deployment fails loudly at boot rather than on the first request.
 */
export function loadGasDripConfig(env: NodeJS.ProcessEnv = process.env): GasDripConfig {
  const amountWei = parseMon(
    env.GAS_DRIP_AMOUNT_MON,
    GAS_DRIP_DEFAULTS.amountMon,
    'GAS_DRIP_AMOUNT_MON',
  );
  const dailyCapWei = parseMon(
    env.GAS_DRIP_DAILY_CAP_MON,
    GAS_DRIP_DEFAULTS.dailyCapMon,
    'GAS_DRIP_DAILY_CAP_MON',
  );
  if (dailyCapWei < amountWei) {
    throw new Error(
      `GAS_DRIP_DAILY_CAP_MON (${formatEther(dailyCapWei)}) is below GAS_DRIP_AMOUNT_MON ` +
        `(${formatEther(amountWei)}); no drip could ever succeed`,
    );
  }

  const dryRun = env.GAS_DRIP_DRY_RUN === 'true';
  if (dryRun && env.NODE_ENV === 'production') {
    throw new Error('GAS_DRIP_DRY_RUN cannot be enabled with NODE_ENV=production');
  }

  return {
    senderKeys: parseSenderKeys(env.GAS_DRIP_PRIVATE_KEYS),
    amountWei,
    dailyCapWei,
    gasLimit: BigInt(
      parsePositiveInt(
        env.GAS_DRIP_GAS_LIMIT,
        Number(GAS_DRIP_DEFAULTS.gasLimit),
        'GAS_DRIP_GAS_LIMIT',
      ),
    ),
    rpcUrl: env.MONAD_TESTNET_RPC_URL?.trim() || undefined,
    rateLimit: {
      max: parsePositiveInt(
        env.GAS_DRIP_RATE_LIMIT_MAX,
        GAS_DRIP_DEFAULTS.rateLimitMax,
        'GAS_DRIP_RATE_LIMIT_MAX',
      ),
      windowMs: parsePositiveInt(
        env.GAS_DRIP_RATE_LIMIT_WINDOW_MS,
        GAS_DRIP_DEFAULTS.rateLimitWindowMs,
        'GAS_DRIP_RATE_LIMIT_WINDOW_MS',
      ),
    },
    dryRun,
  };
}

/** Boot-time summary. Never logs keys — addresses are derived and logged by the sender pool. */
export function describeGasDripConfig(config: GasDripConfig, logger: Logger): void {
  logger.log(
    `faucet amount=${formatEther(config.amountWei)} MON ` +
      `dailyCap=${formatEther(config.dailyCapWei)} MON ` +
      `senders=${config.senderKeys.length} gasLimit=${config.gasLimit} ` +
      `rateLimit=${config.rateLimit.max}/${config.rateLimit.windowMs}ms dryRun=${config.dryRun}`,
  );
}
