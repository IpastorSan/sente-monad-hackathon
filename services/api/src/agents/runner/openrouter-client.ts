/**
 * The Anthropic SDK pointed at OpenRouter with ONE user's key, and the error
 * classification the runner needs. Everything that could print the key is
 * funnelled through `redactSecrets`.
 */
import Anthropic, { APIError, APIUserAbortError, type ClientOptions } from '@anthropic-ai/sdk';

/** The SDK appends `/v1/messages`. */
export const OPENROUTER_ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';

/** Builds the per-run client from the owner's key. The seam specs replace. */
export type AnthropicClientFactory = (userKey: string, options: { timeoutMs: number }) => Anthropic;

/** DI token for the `AnthropicClientFactory`. */
export const ANTHROPIC_CLIENT_FACTORY = Symbol('ANTHROPIC_CLIENT_FACTORY');

/**
 * `authToken` → `Authorization: Bearer <key>`, which is what OpenRouter reads.
 * `apiKey: null` is LOAD-BEARING (SEN-4): left undefined, the SDK falls back to
 * `process.env.ANTHROPIC_API_KEY` and would send a real Anthropic key to
 * OpenRouter in `X-Api-Key`.
 *
 * `maxRetries: 1`: the SDK retries 408/409/429/5xx, never a 402, and the
 * run's own timeout bounds the total anyway.
 */
export function createOpenRouterClient(
  userKey: string,
  options: { timeoutMs: number; fetch?: ClientOptions['fetch']; baseURL?: string },
): Anthropic {
  return new Anthropic({
    baseURL: options.baseURL ?? OPENROUTER_ANTHROPIC_BASE_URL,
    authToken: userKey,
    apiKey: null,
    timeout: options.timeoutMs,
    maxRetries: 1,
    // The SDK's own logger never sees a header, but keep it quiet regardless.
    logLevel: 'off',
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export const defaultAnthropicClientFactory: AnthropicClientFactory = (userKey, { timeoutMs }) =>
  createOpenRouterClient(userKey, { timeoutMs });

export type ModelFailure = 'credits_exhausted' | 'model_error' | 'aborted';

/**
 * - `credits_exhausted`: OpenRouter's 402 (insufficient credits), or a 403 that
 *   says the KEY's limit is spent (OpenRouter's wording for a per-key cap).
 * - `aborted`: our own AbortController (timeout or revoke), not an API fault.
 * - `model_error`: everything else — bad request, 5xx, network, a provider down.
 */
export function classifyModelError(error: unknown): ModelFailure {
  if (error instanceof APIUserAbortError) return 'aborted';
  if (error instanceof APIError) {
    if (error.status === 402) return 'credits_exhausted';
    if (error.status === 403 && /limit|credit/i.test(error.message)) return 'credits_exhausted';
  }
  return 'model_error';
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/sk-or-[A-Za-z0-9_-]+/g, 'sk-or-[redacted]'],
  [/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[redacted]'],
  [/Bearer\s+\S+/gi, 'Bearer [redacted]'],
];

const MAX_ERROR_TEXT = 300;

/**
 * One line of error text safe for a log or an event: the exact key removed
 * wherever it appears, then anything shaped like a key, then truncated.
 */
export function redactSecrets(text: string, key?: string): string {
  let out = key ? text.split(key).join('[redacted]') : text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  out = out.split('\n')[0]?.trim() ?? '';
  return out.length > MAX_ERROR_TEXT ? `${out.slice(0, MAX_ERROR_TEXT)}…` : out;
}

export function errorText(error: unknown, key?: string): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecrets(raw, key);
}
