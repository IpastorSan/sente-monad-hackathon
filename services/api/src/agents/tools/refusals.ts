/**
 * Refusals and failures as the MODEL reads them. Everything here ends up in a
 * tool result, so it is written to be acted on, and it never carries a stack,
 * a key or a token.
 */
import type { RefusalCode } from '@sente/mandate';

import { EnclaveRefusedError } from '../agents.errors';

export const SENTE_REFUSAL_PREFIX = 'Refused by Sente mandate: ';
export const ENCLAVE_REFUSAL_MESSAGE =
  'Refused by the Privy enclave (policy_violation): the signing key would not sign this';

/** Layer-1 codes: `checkIntent`'s, plus the gate's own. */
export type SenteRefusalCode =
  | RefusalCode
  /** A write before `record_thesis` for its market in this run. */
  | 'thesis_required'
  /** The arguments failed the schema, or name something that does not fit together. */
  | 'invalid_input'
  /** The agent was revoked while the run was open. */
  | 'agent_inactive'
  /**
   * Venue pre-flight (SEN-19): the wallet or Kuru AccountCore holds less than the
   * write needs. Refused before signing, because on Monad a revert still pays
   * the whole gas limit.
   */
  | 'insufficient_balance'
  /** Venue pre-flight (SEN-19): below Kuru's minimum order notional for the market. */
  | 'below_min_notional';

/** A refusal by Sente's own gate. The message is model-facing. */
export class SenteRefusal extends Error {
  readonly code: SenteRefusalCode;
  readonly detail: string;

  constructor(code: SenteRefusalCode, detail: string) {
    super(`${SENTE_REFUSAL_PREFIX}${code}. ${detail}`);
    this.name = 'SenteRefusal';
    this.code = code;
    this.detail = detail;
  }
}

export function invalidInput(detail: string): SenteRefusal {
  return new SenteRefusal('invalid_input', detail);
}

/** The enclave's refusal, even when a venue or sender wrapped it as a `cause`. */
export function findEnclaveRefusal(error: unknown): EnclaveRefusedError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof EnclaveRefusedError) return current;
    current = current.cause;
  }
  return undefined;
}

const MAX_MESSAGE = 300;
const REDACTIONS: readonly [RegExp, string][] = [
  [/sente_mcp_[A-Za-z0-9_-]+/g, 'sente_mcp_[redacted]'],
  [/Bearer\s+\S+/gi, 'Bearer [redacted]'],
  [/wallet-auth:\S+/g, 'wallet-auth:[redacted]'],
  // base64 PKCS#8 / SPKI DER, the shape of every authorization key.
  [/\bMI[GI][A-Za-z0-9+/=]{20,}/g, '[redacted key]'],
];

/**
 * Any other failure, as one line the model can use: the error's own message
 * (venue errors name their reason), first line only, redacted, truncated.
 */
export function modelSafeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  let line = raw.split('\n')[0]?.trim() || 'unknown error';
  for (const [pattern, replacement] of REDACTIONS) line = line.replace(pattern, replacement);
  if (line.length > MAX_MESSAGE) line = `${line.slice(0, MAX_MESSAGE)}…`;
  return `Venue error: ${line}`;
}
