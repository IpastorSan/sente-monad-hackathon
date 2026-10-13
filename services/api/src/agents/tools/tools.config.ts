/** DI token for the resolved agent tools configuration. */
export const AGENT_TOOLS_CONFIG = Symbol('AGENT_TOOLS_CONFIG');

export interface AgentToolsConfig {
  /**
   * Run layer 1 (`checkIntent`) before every venue write. `false` only for the
   * demo that shows the Privy enclave refusing on its own; never in production.
   */
  readonly precheck: boolean;
  /**
   * `AGENT_SELL_MAX_BELOW_MARK_PCT` (SEN-204): how far below the mark a sell
   * limit price may sit before it is refused `price_far_from_mark`. Whole
   * percent, 1 to 99, default {@link DEFAULT_SELL_MAX_BELOW_MARK_PCT}.
   */
  readonly sellMaxBelowMarkPct: number;
}

export const DEFAULT_SELL_MAX_BELOW_MARK_PCT = 20;

function parseSellBand(env: NodeJS.ProcessEnv): number {
  const raw = env['AGENT_SELL_MAX_BELOW_MARK_PCT']?.trim();
  if (!raw) return DEFAULT_SELL_MAX_BELOW_MARK_PCT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 99) {
    throw new Error(
      `AGENT_SELL_MAX_BELOW_MARK_PCT must be a whole percent from 1 to 99; got "${raw}"`,
    );
  }
  return value;
}

/**
 * `AGENT_PRECHECK`: unset or `on` (the default) keeps the pre-check; `off`
 * skips it, and is refused outright when `NODE_ENV=production`. Anything else
 * is a typo, and a typo in a safety switch fails the boot rather than guessing.
 */
export function loadAgentToolsConfig(env: NodeJS.ProcessEnv = process.env): AgentToolsConfig {
  const sellMaxBelowMarkPct = parseSellBand(env);
  const raw = env['AGENT_PRECHECK']?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'on')
    return { precheck: true, sellMaxBelowMarkPct };
  if (raw !== 'off') {
    throw new Error(`AGENT_PRECHECK must be "on" or "off"; got "${raw}"`);
  }
  if (env['NODE_ENV'] === 'production') {
    throw new Error(
      'AGENT_PRECHECK=off is refused when NODE_ENV=production: it removes the mandate ' +
        'pre-check, and Perpl order size and leverage have no other check. It exists only to ' +
        'demo the enclave refusing on its own.',
    );
  }
  return { precheck: false, sellMaxBelowMarkPct };
}

/** Boot-time line. Loud when the pre-check is off. */
export function describeAgentToolsConfig(
  config: AgentToolsConfig,
  logger: { log(message: string): void; warn(message: string): void },
): void {
  if (config.precheck) {
    logger.log('agent tools: mandate pre-check on');
    return;
  }
  logger.warn(
    'agent tools: AGENT_PRECHECK=off — writes go straight to the venues, so only the Privy ' +
      'enclave bounds them. Perpl order size and leverage are NOT enforced at all. Demo only.',
  );
}
