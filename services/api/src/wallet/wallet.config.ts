import { Logger } from '@nestjs/common';

/** DI token for the resolved, validated wallet configuration. */
export const WALLET_CONFIG = Symbol('WALLET_CONFIG');

/**
 * Which ERC-7677 paymaster service sponsors gas.
 *
 * The two implemented providers speak the same wire protocol and differ only in
 * endpoint and in the shape of the `context` object, so swapping them is a
 * config change rather than a rewrite (see `paymaster/erc7677-sponsorship.ts`).
 * `none` builds every UserOperation exactly as usual but self-funded, which is
 * the honest state when no key is configured.
 */
export const PAYMASTER_PROVIDERS = ['pimlico', 'alchemy', 'none'] as const;
export type PaymasterProvider = (typeof PAYMASTER_PROVIDERS)[number];

export interface PaymasterConfig {
  provider: PaymasterProvider;
  /** ERC-7677 endpoint. Undefined when `provider === 'none'`. */
  url: string | undefined;
  /**
   * Sponsorship policy identifier, sent in the ERC-7677 `context`. Pimlico
   * calls it `sponsorshipPolicyId`, Alchemy calls it `policyId`; both are
   * required by their respective services, which is why `none` is a real state
   * rather than a fallback.
   */
  policyId: string | undefined;
}

export interface WalletConfig {
  /** ERC-4337 bundler endpoint. Always set — see BUNDLER_URL_DEFAULT. */
  bundlerUrl: string;
  paymaster: PaymasterConfig;
  /** Optional Monad RPC override; falls back to viem's default for monadTestnet. */
  rpcUrl: string | undefined;
  /**
   * Confirmation poll interval. Defaults to 300ms — Monad's block time. Base's
   * 200ms flash-block cadence is the wrong number here and just burns requests.
   */
  confirmationPollMs: number;
  /** How long to chase a UserOperation before reporting it still pending. */
  confirmationTimeoutMs: number;
  /** How long a prepared operation stays signable. Short: fees go stale. */
  prepareTtlMs: number;
}

export const WALLET_DEFAULTS = {
  /**
   * Pimlico's KEYLESS public endpoint for Monad testnet.
   *
   * Verified 2026-09-09: `eth_chainId` -> 0x279f, `eth_supportedEntryPoints`
   * lists EntryPoint v0.7, `pimlico_getUserOperationGasPrice` answers, and
   * `eth_estimateUserOperationGas` really simulates (it returned a genuine
   * `AA20 account not deployed`). So the BUNDLER half works with no key.
   *
   * The PAYMASTER half does not: `pm_getPaymasterStubData` and
   * `pm_sponsorUserOperation` both answer
   * `Sponsorship policy ID is required for this API key`. Sponsorship therefore
   * needs a real Pimlico key plus a policy — set PIMLICO_BUNDLER_URL and
   * PIMLICO_SPONSORSHIP_POLICY_ID.
   */
  bundlerUrl: 'https://public.pimlico.io/v2/10143/rpc',
  confirmationPollMs: 300,
  confirmationTimeoutMs: 90_000,
  prepareTtlMs: 120_000,
} as const;

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

function parseUrl(raw: string | undefined, name: string): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Deliberately does not echo the value: a keyed Pimlico URL is a secret.
    throw new Error(`${name} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return value;
}

function parseProvider(raw: string | undefined, fallback: PaymasterProvider): PaymasterProvider {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (!(PAYMASTER_PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(
      `WALLET_PAYMASTER_PROVIDER must be one of ${PAYMASTER_PROVIDERS.join(', ')}, got ${JSON.stringify(raw)}`,
    );
  }
  return value as PaymasterProvider;
}

function resolvePaymaster(env: NodeJS.ProcessEnv, bundlerUrl: string): PaymasterConfig {
  const pimlicoUrl = parseUrl(env.PIMLICO_BUNDLER_URL, 'PIMLICO_BUNDLER_URL');
  const alchemyUrl = parseUrl(env.ALCHEMY_RPC_URL, 'ALCHEMY_RPC_URL');
  const pimlicoPolicy = env.PIMLICO_SPONSORSHIP_POLICY_ID?.trim() || undefined;
  const alchemyPolicy = env.ALCHEMY_GAS_POLICY_ID?.trim() || undefined;

  // Infer the provider from whichever credentials are present, so the common
  // case needs one variable rather than three. An explicit setting always wins.
  const inferred: PaymasterProvider = alchemyPolicy
    ? 'alchemy'
    : pimlicoPolicy
      ? 'pimlico'
      : 'none';
  const provider = parseProvider(env.WALLET_PAYMASTER_PROVIDER, inferred);

  if (provider === 'none') {
    return { provider, url: undefined, policyId: undefined };
  }
  if (provider === 'alchemy') {
    return { provider, url: alchemyUrl ?? bundlerUrl, policyId: alchemyPolicy };
  }
  // Pimlico serves the bundler and the paymaster on the same endpoint, so the
  // keyed PIMLICO_BUNDLER_URL doubles as the paymaster URL.
  return { provider, url: pimlicoUrl ?? bundlerUrl, policyId: pimlicoPolicy };
}

/**
 * Pure env -> config, so a bad deployment fails at boot rather than on the
 * first UserOperation, and so it can be unit tested without Nest.
 */
export function loadWalletConfig(env: NodeJS.ProcessEnv = process.env): WalletConfig {
  const bundlerUrl =
    parseUrl(env.WALLET_BUNDLER_URL, 'WALLET_BUNDLER_URL') ??
    parseUrl(env.PIMLICO_BUNDLER_URL, 'PIMLICO_BUNDLER_URL') ??
    WALLET_DEFAULTS.bundlerUrl;

  return {
    bundlerUrl,
    paymaster: resolvePaymaster(env, bundlerUrl),
    rpcUrl: env.MONAD_TESTNET_RPC_URL?.trim() || undefined,
    confirmationPollMs: parsePositiveInt(
      env.WALLET_CONFIRMATION_POLL_MS,
      WALLET_DEFAULTS.confirmationPollMs,
      'WALLET_CONFIRMATION_POLL_MS',
    ),
    confirmationTimeoutMs: parsePositiveInt(
      env.WALLET_CONFIRMATION_TIMEOUT_MS,
      WALLET_DEFAULTS.confirmationTimeoutMs,
      'WALLET_CONFIRMATION_TIMEOUT_MS',
    ),
    prepareTtlMs: parsePositiveInt(
      env.WALLET_PREPARE_TTL_MS,
      WALLET_DEFAULTS.prepareTtlMs,
      'WALLET_PREPARE_TTL_MS',
    ),
  };
}

/** Boot-time summary. Never logs the bundler URL: it carries the API key. */
export function describeWalletConfig(config: WalletConfig, logger: Logger): void {
  const host = new URL(config.bundlerUrl).host;
  logger.log(
    `bundler=${host} paymaster=${config.paymaster.provider}` +
      `${config.paymaster.policyId ? ' (policy set)' : ''} ` +
      `poll=${config.confirmationPollMs}ms timeout=${config.confirmationTimeoutMs}ms ` +
      `prepareTtl=${config.prepareTtlMs}ms`,
  );
  if (config.paymaster.provider === 'none') {
    logger.warn(
      'No paymaster configured: UserOperations will be built and signed but NOT sponsored, ' +
        'so the smart account must hold MON. Set PIMLICO_BUNDLER_URL (keyed) and ' +
        'PIMLICO_SPONSORSHIP_POLICY_ID to turn sponsorship on.',
    );
  } else if (!config.paymaster.policyId) {
    logger.warn(
      `WALLET_PAYMASTER_PROVIDER=${config.paymaster.provider} but no sponsorship policy id is ` +
        'set; the paymaster will reject every request.',
    );
  }
}
