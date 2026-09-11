import { createHash, randomBytes } from 'node:crypto';

/**
 * An agent's MCP bearer token: `Authorization: Bearer sente_mcp_…` scopes an
 * MCP session to exactly one agent (SEN-7).
 *
 * The prefix makes a leaked token recognisable to secret scanners and in logs.
 * The token carries 256 random bits, so it is stored as a plain sha256: there
 * is nothing to brute-force, which is what a salt or a slow hash would defend
 * against. Hashing before the lookup also means the lookup's timing depends on
 * the hash, never on how much of a guessed token was right.
 */
export const MCP_TOKEN_PREFIX = 'sente_mcp_';

export function generateMcpToken(): string {
  return MCP_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** sha256, lowercase hex. The only form of the token that is ever stored. */
export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
