// Error text fit for an HTTP body or a log line (SEN-204).
//
// viem's errors carry the request URL ("URL: https://…/v2/<key>"), and every
// RPC, bundler and paymaster URL this API uses holds its API key in the path or
// the query string. A message passed through verbatim hands that key to whoever
// reads the response or the log. This keeps viem's `shortMessage` (and its
// `details`), masks every URL outright, and masks `apikey=`/`key=`-style values
// wherever they appear.
//
// Erasable syntax and no imports, so any file a script loads can use it.

/** Long enough for a revert reason, short enough for a JSON body. */
const MAX_LENGTH = 400;

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;
const SECRET_PARAM_PATTERN = /\b((?:api[-_]?key|access[-_]?token|key|token|secret)=)[^&\s"'<>`]+/gi;

/** Masks URLs and secret-looking query values in free text. */
export function redactSecrets(text: string): string {
  return text.replace(URL_PATTERN, '[url]').replace(SECRET_PARAM_PATTERN, '$1[redacted]');
}

/**
 * The one-line, secret-free description of `error`.
 *
 * A viem error is described by its `shortMessage` plus `details` (the node's
 * own words, e.g. a revert reason); anything else by its message's first
 * paragraph plus a `Details:` line if it has one. Then URLs and keys are
 * masked, and the result capped.
 */
export function redactError(error: unknown): string {
  let head: string;
  let detail: string | undefined;
  if (error instanceof Error) {
    const { shortMessage, details } = error as { shortMessage?: unknown; details?: unknown };
    if (typeof shortMessage === 'string' && shortMessage) {
      head = shortMessage;
      if (typeof details === 'string' && details && !shortMessage.includes(details)) {
        detail = details;
      }
    } else {
      head = error.message.split('\n\n')[0] ?? error.message;
      detail = / Details: (.+)/.exec(error.message)?.[1];
    }
  } else {
    head = String(error);
  }
  // Each part on its own, so a URL is masked up to its end and no further.
  const text = detail ? `${redactSecrets(head)} (${redactSecrets(detail)})` : redactSecrets(head);
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}...` : text;
}
