import { loadAlchemyConfig } from './alchemy.config';
import {
  ALCHEMY_NOTIFY_AUTH_HEADER,
  ALCHEMY_UPDATE_ADDRESSES_PATH,
  AlchemyNotifyClient,
} from './alchemy-notify';

const WALLET = '0x1234567890AbcdEF1234567890aBcDeF12345678';
const TOKEN = 'alcht_test_auth_token';

const CONFIGURED = loadAlchemyConfig({
  ALCHEMY_NOTIFY_AUTH_TOKEN: TOKEN,
  ALCHEMY_NOTIFY_WEBHOOK_ID: 'wh_abc',
});

type Sent = { url: string; init: RequestInit };

/**
 * A stand-in for `fetch` itself, not for a hand-rolled shape: the client is typed
 * `typeof fetch`, so the fake answers with a real `Response`, which is also what
 * keeps this spec honest about `response.ok` and `response.text()`.
 */
function recorder(answer: () => Promise<Response>): { sent: Sent[]; fetch: typeof fetch } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: ((url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return answer();
    }) as typeof fetch,
  };
}

const ok = (): Promise<Response> => Promise.resolve(new Response('{}', { status: 200 }));

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe('AlchemyNotifyClient.watchAddress', () => {
  it('PATCHes update-webhook-addresses exactly as Alchemy documents it', async () => {
    const { sent, fetch } = recorder(ok);

    await expect(new AlchemyNotifyClient(CONFIGURED, fetch).watchAddress(WALLET)).resolves.toEqual({
      ok: true,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`https://dashboard.alchemy.com/api${ALCHEMY_UPDATE_ADDRESSES_PATH}`);
    expect(sent[0]?.init.method).toBe('PATCH');
    expect(headerOf(sent[0]!.init, ALCHEMY_NOTIFY_AUTH_HEADER)).toBe(TOKEN);
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      webhook_id: 'wh_abc',
      addresses_to_add: [WALLET],
      // Documented as required, "empty array if none" — not omitted.
      addresses_to_remove: [],
    });
  });

  it('refuses without sending anything when either variable is missing', async () => {
    for (const env of [
      {},
      { ALCHEMY_NOTIFY_AUTH_TOKEN: TOKEN },
      { ALCHEMY_NOTIFY_WEBHOOK_ID: 'wh_abc' },
    ]) {
      const { sent, fetch } = recorder(ok);
      await expect(
        new AlchemyNotifyClient(loadAlchemyConfig(env), fetch).watchAddress(WALLET),
      ).resolves.toMatchObject({ ok: false, reason: 'notify_unconfigured' });
      expect(sent).toHaveLength(0);
    }
  });

  it('never throws when the request fails — a hire must not fail with it', async () => {
    const { fetch } = recorder(() => Promise.reject(new Error('ECONNRESET')));

    await expect(new AlchemyNotifyClient(CONFIGURED, fetch).watchAddress(WALLET)).resolves.toEqual({
      ok: false,
      reason: 'notify_unreachable',
      message: 'ECONNRESET',
    });
  });

  it('reports a non-2xx as notify_rejected, carrying Alchemy’s reason and never the token', async () => {
    const { fetch } = recorder(() =>
      Promise.resolve(new Response('{"error":"invalid auth token"}', { status: 403 })),
    );

    const outcome = await new AlchemyNotifyClient(CONFIGURED, fetch).watchAddress(WALLET);

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.reason).toBe('notify_rejected');
    expect(outcome.message).toContain('403');
    expect(outcome.message).toContain('invalid auth token');
    expect(outcome.message).not.toContain(TOKEN);
  });

  it('survives a response whose body cannot be read', async () => {
    const unreadable = new Response(null, { status: 500 });
    jest.spyOn(unreadable, 'text').mockRejectedValue(new Error('stream closed'));
    const { fetch } = recorder(() => Promise.resolve(unreadable));

    await expect(new AlchemyNotifyClient(CONFIGURED, fetch).watchAddress(WALLET)).resolves.toEqual({
      ok: false,
      reason: 'notify_rejected',
      message: 'HTTP 500',
    });
  });

  it('always posts to the documented dashboard endpoint', async () => {
    const { sent, fetch } = recorder(ok);

    await new AlchemyNotifyClient(CONFIGURED, fetch).watchAddress(WALLET);

    // A constant, not a variable: the host is Alchemy's, not a deployment
    // choice, and a spec substitutes `fetch` rather than redirecting the URL.
    expect(sent[0]?.url).toBe('https://dashboard.alchemy.com/api/update-webhook-addresses');
  });
});
