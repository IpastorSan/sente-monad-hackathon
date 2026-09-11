/**
 * A stand-in for OpenRouter's `/api/v1/messages`, served through a fake
 * `fetch` handed to the REAL Anthropic client, so specs exercise the SDK's own
 * BetaToolRunner: its tool execution, `max_iterations`, stop reasons, errors
 * and abort handling. Every request is recorded, headers included.
 */

export interface RecordedRequest {
  readonly url: string;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

export interface CannedResponse {
  readonly status?: number;
  readonly body: unknown;
}

/** `'hang'` never answers; it rejects when the request is aborted. */
export type Canned = CannedResponse | 'hang';

export type Responder = Canned | ((request: RecordedRequest) => Canned | Promise<Canned>);

let messageSeq = 0;

export function assistant(
  content: unknown[],
  stopReason: string | null,
  options: { costUsd?: number } = {},
): CannedResponse {
  return {
    body: {
      id: `msg_${++messageSeq}`,
      type: 'message',
      role: 'assistant',
      model: 'fake-model',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        ...(options.costUsd !== undefined ? { cost: options.costUsd } : {}),
      },
    },
  };
}

export const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

export const text = (value: string) => ({ type: 'text', text: value });

/** An error body in OpenRouter's Anthropic-compatible shape. */
export function apiError(status: number, message: string): CannedResponse {
  return { status, body: { type: 'error', error: { type: 'api_error', message, code: status } } };
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function fakeMessagesApi(responders: readonly Responder[]) {
  const requests: RecordedRequest[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const request: RecordedRequest = { url, headers, body };
    requests.push(request);

    const responder = responders[requests.length - 1];
    const canned: Canned =
      responder === undefined
        ? apiError(400, `fake: no canned response for request ${requests.length}`)
        : typeof responder === 'function'
          ? await responder(request)
          : responder;

    if (canned === 'hang') {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    return new Response(JSON.stringify(canned.body), {
      status: canned.status ?? 200,
      headers: { 'content-type': 'application/json', 'request-id': `req_${requests.length}` },
    });
  };

  /** The `messages` the model was sent on request `index`. */
  const messagesOf = (index: number) =>
    (requests[index]?.body['messages'] ?? []) as { role: string; content: unknown }[];

  return { fetch, requests, messagesOf };
}
