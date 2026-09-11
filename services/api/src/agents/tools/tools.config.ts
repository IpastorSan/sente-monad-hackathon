/** DI token for the resolved agent tools configuration. */
export const AGENT_TOOLS_CONFIG = Symbol('AGENT_TOOLS_CONFIG');

export interface AgentToolsConfig {
  /**
   * Run layer 1 (`checkIntent`) before every venue write. `false` only for the
   * demo that shows the Privy enclave refusing on its own; never in production.
   */
  readonly precheck: boolean;
}

/**
 * `AGENT_PRECHECK`: unset or `on` (the default) keeps the pre-check; `off`
 * skips it, and is refused outright when `NODE_ENV=production`. Anything else
 * is a typo, and a typo in a safety switch fails the boot rather than guessing.
 */
export function loadAgentToolsConfig(env: NodeJS.ProcessEnv = process.env): AgentToolsConfig {
  const raw = env['AGENT_PRECHECK']?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'on') return { precheck: true };
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
  return { precheck: false };
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
