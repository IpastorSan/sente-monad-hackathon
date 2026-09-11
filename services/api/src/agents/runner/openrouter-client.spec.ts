import { APIError, APIUserAbortError } from '@anthropic-ai/sdk';

import {
  classifyModelError,
  createOpenRouterClient,
  errorText,
  redactSecrets,
} from './openrouter-client';
import { assistant, fakeMessagesApi, text } from './testing/fake-messages';

const KEY = 'sk-or-v1-user-key-0123456789';

describe('createOpenRouterClient', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('sends the user key as a Bearer token to OpenRouter, and never an ambient Anthropic key', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-AMBIENT-must-not-leak';
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'ambient-token-must-not-leak';
    const api = fakeMessagesApi([assistant([text('hi')], 'end_turn')]);
    const client = createOpenRouterClient(KEY, { timeoutMs: 5_000, fetch: api.fetch });

    await client.messages.create({
      model: 'anthropic/claude-sonnet-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const [request] = api.requests;
    expect(request!.url).toMatch(/^https:\/\/openrouter\.ai\/api\/v1\/messages/);
    expect(request!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(request!.headers).not.toHaveProperty('x-api-key');
    expect(JSON.stringify(request!.headers)).not.toMatch(/AMBIENT|ambient-token/);
  });
});

describe('classifyModelError', () => {
  const apiError = (status: number, message: string) =>
    APIError.generate(status, { error: { message } }, undefined, new Headers());

  it('maps OpenRouter 402, and a 403 about the key limit, to credits_exhausted', () => {
    expect(classifyModelError(apiError(402, 'Insufficient credits'))).toBe('credits_exhausted');
    expect(classifyModelError(apiError(403, 'Key limit exceeded'))).toBe('credits_exhausted');
  });

  it('maps every other failure to model_error, and our own abort to aborted', () => {
    expect(classifyModelError(apiError(403, 'Input flagged by moderation'))).toBe('model_error');
    expect(classifyModelError(apiError(400, 'bad request'))).toBe('model_error');
    expect(classifyModelError(apiError(503, 'no provider'))).toBe('model_error');
    expect(classifyModelError(new Error('socket hang up'))).toBe('model_error');
    expect(classifyModelError(new APIUserAbortError())).toBe('aborted');
  });
});

describe('redactSecrets', () => {
  it('removes the exact key, anything key-shaped and bearer tokens', () => {
    const out = redactSecrets(
      `401 bad key ${KEY} (also sk-or-v1-other, sk-ant-api03-x) Authorization: Bearer abc.def`,
      KEY,
    );
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/sk-or-v1-other|sk-ant-api03-x|abc\.def/);
    expect(out).toContain('[redacted]');
  });

  it('keeps one line, truncated', () => {
    expect(redactSecrets('first\nsecond')).toBe('first');
    expect(redactSecrets('x'.repeat(1_000))).toHaveLength(301);
  });

  it('errorText names the error class', () => {
    expect(errorText(new TypeError(`fetch failed for ${KEY}`), KEY)).toBe(
      'TypeError: fetch failed for [redacted]',
    );
  });
});
