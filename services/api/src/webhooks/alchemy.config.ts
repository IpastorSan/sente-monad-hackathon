/**
 * Alchemy configuration — SEN-30.
 *
 * Three variables, each doing one thing, all optional: with none of them the API
 * boots exactly as before, `POST /webhooks/alchemy` refuses every call
 * (`webhook_unconfigured`, never "accepted unverified"), and a hire registers no
 * address. That is the same shape `ERC8004_*` has — a missing integration
 * degrades to a missing feature, never to a missing guarantee.
 *
 * The RPC endpoint is deliberately NOT here. Every HTTP chain read in this API
 * already resolves through `MONAD_TESTNET_RPC_URL` (`wallet.config.ts`,
 * `gas.config.ts`, `agents/venues/agent-venues.providers.ts`,
 * `agents/reputation/erc8004.ts`), so pointing the API at Alchemy is that one
 * variable and no code. See `docs/alchemy.md`.
 */

/** DI token for the Alchemy configuration. */
export const ALCHEMY_CONFIG = Symbol('ALCHEMY_CONFIG');

/**
 * Alchemy's Notify REST base. A constant rather than a variable: it is the
 * dashboard's own API host, not a per-deployment choice, and a typo in it would
 * silently stop every registration.
 *
 * Source: Alchemy docs, "Update webhook addresses" —
 * `PATCH https://dashboard.alchemy.com/api/update-webhook-addresses`
 * (https://www.alchemy.com/docs/data/webhooks/webhooks-api-endpoints/notify-api-endpoints/update-webhook-addresses).
 */
export const ALCHEMY_NOTIFY_BASE_URL = 'https://dashboard.alchemy.com/api';

export interface AlchemyConfig {
  /**
   * The per-webhook signing key Alchemy HMACs each delivery with. Unset, the
   * route refuses: verifying nothing is worse than serving nothing, because an
   * unverified caller could append fabricated deposits to any agent's Ledger.
   */
  readonly webhookSigningKey?: string;
  /** The Notify auth token, which is per-app and NOT the signing key. */
  readonly notifyAuthToken?: string;
  /** Which webhook's address list a hire adds to (`wh_...`). */
  readonly notifyWebhookId?: string;
  /** How long a Notify call may take before it is abandoned. Never fails a hire. */
  readonly notifyTimeoutMs: number;
}

export const ALCHEMY_DEFAULTS = {
  notifyTimeoutMs: 5_000,
} as const;

export interface AlchemyLogger {
  log?(message: string): void;
  warn(message: string): void;
}

/**
 * Pure env -> config. Nothing here can throw: every field is optional and a
 * blank one simply disables its half, so a half-filled `.env` is a warned
 * degradation rather than a boot failure. (`ERC8004_*` throws on a MALFORMED
 * private key; there is no analogous shape to validate here — a signing key is
 * an opaque string, and guessing at its format would reject a rotated one.)
 */
export function loadAlchemyConfig(env: NodeJS.ProcessEnv = process.env): AlchemyConfig {
  return {
    webhookSigningKey: env['ALCHEMY_WEBHOOK_SIGNING_KEY']?.trim() || undefined,
    notifyAuthToken: env['ALCHEMY_NOTIFY_AUTH_TOKEN']?.trim() || undefined,
    notifyWebhookId: env['ALCHEMY_NOTIFY_WEBHOOK_ID']?.trim() || undefined,
    notifyTimeoutMs: positiveInt(
      env['ALCHEMY_NOTIFY_TIMEOUT_MS'],
      ALCHEMY_DEFAULTS.notifyTimeoutMs,
    ),
  };
}

/** Boot-time summary. Names variables, never their values. */
export function describeAlchemyConfig(config: AlchemyConfig, logger: AlchemyLogger): void {
  if (config.webhookSigningKey) {
    logger.log?.(
      'Alchemy webhook enabled: POST /webhooks/alchemy verifies X-Alchemy-Signature ' +
        'against ALCHEMY_WEBHOOK_SIGNING_KEY and appends deposit events.',
    );
  } else {
    logger.warn(
      'Alchemy webhook disabled: ALCHEMY_WEBHOOK_SIGNING_KEY is unset, so ' +
        'POST /webhooks/alchemy refuses every call. It is a PUBLIC route by design — ' +
        'Alchemy is the caller and carries no session — so the signature is the only ' +
        'thing authenticating it, and an unverified body is never accepted.',
    );
  }
  if (config.notifyAuthToken && config.notifyWebhookId) {
    logger.log?.(
      `Alchemy Notify enabled: each hired agent wallet is added to webhook ` +
        `${config.notifyWebhookId} (best effort; a failure never fails a hire).`,
    );
    return;
  }
  logger.warn(
    'Alchemy Notify registration disabled: ' +
      [
        ...(config.notifyAuthToken ? [] : ['ALCHEMY_NOTIFY_AUTH_TOKEN']),
        ...(config.notifyWebhookId ? [] : ['ALCHEMY_NOTIFY_WEBHOOK_ID']),
      ].join(' and ') +
      ' unset. Hired agent wallets must be added to the webhook by hand in the dashboard ' +
      'or no deposit to them is ever delivered.',
  );
}

function positiveInt(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
