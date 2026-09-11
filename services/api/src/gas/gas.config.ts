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
   * Explicit gas limit for a native transfer to an address WITHOUT code (an
   * EOA, or a counterfactual Kernel account not deployed yet). Monad charges on
   * gas_limit, not gas used, so this is hard-coded rather than estimated — see
   * CLAUDE.md gotcha 4 and MONAD_GAS_LIMITS in apps/mobile/src/chain/client.ts.
   */
  gasLimit: bigint;
  /**
   * Explicit gas limit for a native transfer to an address WITH code, e.g. a
   * deployed Kernel smart account, whose `receive()` runs on the send. 21k
   * reverts there. Chosen per recipient from `eth_getCode`, so EOAs never pay it.
   */
  gasLimitContract: bigint;
  /** Optional RPC override; falls back to viem's default for monadTestnet. */
  rpcUrl: string | undefined;
  rateLimit: GasDripRateLimitConfig;
  /** The agent drip (SEN-14): MON for a hired agent's own EOA. */
  agent: GasDripAgentConfig;
  /**
   * Local/CI only. Runs every guard for real but never broadcasts, returning a
   * synthetic tx hash. Lets the refusal paths be exercised end to end without a
   * funded key. Refuses to switch on when NODE_ENV=production.
   */
  dryRun: boolean;
}

export interface GasDripAgentConfig {
  /**
   * MON sent to each hired agent's EOA. Default 0.15: SEN-6 measured 0.138 MON
   * of gas for one agent's first seven transactions (Kuru approve/deposit/
   * order/cancel and Perpl's three onboarding txs — 1,355,412 gas at 102 gwei,
   * charged at the limit). Floor and ceiling pinned in gas.config.spec.ts.
   */
  amountWei: bigint;
  /**
   * Agents one user may have funded per UTC day. Separate from the user's own
   * one-drip-ever rule, which an agent drip never consumes.
   */
  maxPerUserPerDay: number;
  /**
   * Minimum gap between two drip sends from the same faucet key, user and
   * agent drips alike (SEN-16), measured from the previous send's receipt.
   * Keeps each send its key's first transaction in the reserve-balance window
   * — see `sender/reserve-aware-dispatcher.ts` and CLAUDE.md gotcha 12. It
   * lives under `agent` because SEN-14 introduced it there.
   */
  senderSpacingMs: number;
  /**
   * How long to wait for a drip's receipt, user or agent, before calling it
   * unconfirmed.
   */
  receiptTimeoutMs: number;
}

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Absolute ceiling on rotating senders — more keys is more funding surface. */
const MAX_SENDER_KEYS = 5;

export const GAS_DRIP_DEFAULTS = {
  amountMon: '0.1',
  dailyCapMon: '25',
  /** MON -> EOA: 21,000, and it cannot vary. */
  gasLimit: 21_000n,
  /**
   * MON -> deployed Kernel v0.3.1 account: 40,995 measured on Monad testnet
   * (MONAD_GAS_LIMITS.nativeTransferToSmartAccount in apps/mobile). The floor
   * and the +20% ceiling are pinned in gas.config.spec.ts.
   */
  gasLimitContract: 46_000n,
  rateLimitMax: 3,
  rateLimitWindowMs: 15 * 60 * 1000,
  /** 0.138252 MON measured per agent in SEN-6, +8%. */
  agentAmountMon: '0.15',
  agentMaxPerUserPerDay: 3,
  /**
   * Monad's reserve-balance window, measured on testnet in SEN-16: a second
   * MON transfer from an under-reserve key included 0 or 2 blocks after the
   * first reverted; 3 or more blocks after, it landed (docs/monad-testnet-
   * assets.md, "Reserve balance window"; CLAUDE.md gotcha 12). 3 blocks is
   * about 1.2 s at ~400 ms a block. Counted from the previous receipt, which
   * arrives no earlier than that send's block, 2 s is about 5 blocks: the
   * window plus a margin. It was a guessed 5 s before the measurement.
   */
  senderSpacingMs: 2_000,
  /** Monad finalises in about a second; 15 s is an RPC in trouble. */
  agentReceiptTimeoutMs: 15_000,
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

  const agentAmountWei = parseMon(
    env.GAS_DRIP_AGENT_AMOUNT_MON,
    GAS_DRIP_DEFAULTS.agentAmountMon,
    'GAS_DRIP_AGENT_AMOUNT_MON',
  );
  if (dailyCapWei < agentAmountWei) {
    throw new Error(
      `GAS_DRIP_DAILY_CAP_MON (${formatEther(dailyCapWei)}) is below GAS_DRIP_AGENT_AMOUNT_MON ` +
        `(${formatEther(agentAmountWei)}); no agent drip could ever succeed`,
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
    gasLimitContract: BigInt(
      parsePositiveInt(
        env.GAS_DRIP_GAS_LIMIT_CONTRACT,
        Number(GAS_DRIP_DEFAULTS.gasLimitContract),
        'GAS_DRIP_GAS_LIMIT_CONTRACT',
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
    agent: {
      amountWei: agentAmountWei,
      maxPerUserPerDay: parsePositiveInt(
        env.GAS_DRIP_AGENT_MAX_PER_USER_PER_DAY,
        GAS_DRIP_DEFAULTS.agentMaxPerUserPerDay,
        'GAS_DRIP_AGENT_MAX_PER_USER_PER_DAY',
      ),
      senderSpacingMs: parsePositiveInt(
        env.GAS_DRIP_SENDER_SPACING_MS,
        GAS_DRIP_DEFAULTS.senderSpacingMs,
        'GAS_DRIP_SENDER_SPACING_MS',
      ),
      receiptTimeoutMs: parsePositiveInt(
        env.GAS_DRIP_AGENT_RECEIPT_TIMEOUT_MS,
        GAS_DRIP_DEFAULTS.agentReceiptTimeoutMs,
        'GAS_DRIP_AGENT_RECEIPT_TIMEOUT_MS',
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
      `gasLimitContract=${config.gasLimitContract} ` +
      `rateLimit=${config.rateLimit.max}/${config.rateLimit.windowMs}ms dryRun=${config.dryRun}`,
  );
  logger.log(
    `agent drip amount=${formatEther(config.agent.amountWei)} MON ` +
      `maxPerUserPerDay=${config.agent.maxPerUserPerDay} ` +
      `senderSpacing=${config.agent.senderSpacingMs}ms ` +
      `receiptTimeout=${config.agent.receiptTimeoutMs}ms`,
  );
}
