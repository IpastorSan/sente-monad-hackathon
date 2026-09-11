import type { Logger } from '@nestjs/common';

import { loadAuthorizationKey, type AuthorizationKey } from './privy/authorization-key.ts';

/** DI token for the resolved, validated agents configuration. */
export const AGENTS_CONFIG = Symbol('AGENTS_CONFIG');

/**
 * Privy credentials plus the TWO authorization keys, and why they are two.
 *
 * - `agentAuthKey` owns every agent WALLET. The server uses it on every
 *   `eth_signTransaction`, so it is the hot key.
 * - `mandateOwnerKey` owns every POLICY. Only it can change what a wallet may
 *   sign.
 *
 * One key doing both would let the trading path raise its own limit, which is
 * the single thing the mandate exists to prevent. Phase 3 moves the
 * mandate-owner key onto the user's device; until then both sit in `.env`,
 * which is honest for testnet and wrong for production.
 */
export interface PrivyAgentsConfig {
  appId: string;
  appSecret: string;
  agentAuthKey: AuthorizationKey;
  mandateOwnerKey: AuthorizationKey;
  /**
   * Existing single-key quorums to reuse. Unset, the provider creates them on
   * first use and logs their ids — pin them here, or every restart registers
   * new ones (Privy cannot list quorums: `GET /v1/key_quorums` is 405).
   */
  agentQuorumId: string | undefined;
  mandateQuorumId: string | undefined;
}

export interface AgentsConfig {
  /** `undefined` when Privy is not configured at all — agent wallets refuse. */
  privy: PrivyAgentsConfig | undefined;
}

const REQUIRED = [
  'PRIVY_APP_ID',
  'PRIVY_APP_SECRET',
  'PRIVY_AGENT_AUTH_KEY',
  'PRIVY_MANDATE_OWNER_KEY',
] as const;

function parseKey(raw: string, name: string): AuthorizationKey {
  try {
    return loadAuthorizationKey(raw);
  } catch {
    // Never echo the value, nor node's decoder error (it can quote input).
    throw new Error(
      `${name} is not a valid P-256 authorization key (base64 PKCS#8, optionally "wallet-auth:"-prefixed)`,
    );
  }
}

/**
 * Pure env -> config, so a half-configured deployment fails at boot rather
 * than on the first hire, and so it is unit testable without Nest. No error
 * message ever contains a value, only variable names.
 */
export function loadAgentsConfig(env: NodeJS.ProcessEnv = process.env): AgentsConfig {
  const value = (name: string): string | undefined => env[name]?.trim() || undefined;
  const present = REQUIRED.filter((name) => value(name) !== undefined);
  if (present.length === 0) return { privy: undefined };

  const missing = REQUIRED.filter((name) => value(name) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Privy agent wallets are half-configured: set ${missing.join(', ')}. Generate the two ` +
        'authorization keys with `pnpm --filter @sente/api run privy:keys`.',
    );
  }

  const agentAuthKey = parseKey(value('PRIVY_AGENT_AUTH_KEY')!, 'PRIVY_AGENT_AUTH_KEY');
  const mandateOwnerKey = parseKey(value('PRIVY_MANDATE_OWNER_KEY')!, 'PRIVY_MANDATE_OWNER_KEY');
  if (agentAuthKey.publicKey === mandateOwnerKey.publicKey) {
    throw new Error(
      'PRIVY_AGENT_AUTH_KEY and PRIVY_MANDATE_OWNER_KEY must be different keys: the key that ' +
        'signs trades must never be able to change the policy that bounds them',
    );
  }

  return {
    privy: {
      appId: value('PRIVY_APP_ID')!,
      appSecret: value('PRIVY_APP_SECRET')!,
      agentAuthKey,
      mandateOwnerKey,
      agentQuorumId: value('PRIVY_AGENT_QUORUM_ID'),
      mandateQuorumId: value('PRIVY_MANDATE_QUORUM_ID'),
    },
  };
}

/** Boot-time summary. The app id is public; nothing else is printed. */
export function describeAgentsConfig(config: AgentsConfig, logger: Logger): void {
  if (!config.privy) {
    logger.warn(
      'Privy not configured: agent wallets will refuse with agent_wallets_unconfigured. ' +
        'Set PRIVY_APP_ID, PRIVY_APP_SECRET and run `pnpm --filter @sente/api run privy:keys`.',
    );
    return;
  }
  const { appId, agentQuorumId, mandateQuorumId } = config.privy;
  logger.log(
    `agent wallets=privy app=${appId} ` +
      `agentQuorum=${agentQuorumId ?? '(created on first use)'} ` +
      `mandateQuorum=${mandateQuorumId ?? '(created on first use)'}`,
  );
}
