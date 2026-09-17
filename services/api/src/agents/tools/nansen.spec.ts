/**
 * SEN-29: the Nansen client against a fake fetch. What matters here is the
 * shape the free plan forces (cache, dedupe, cached failures), the honest
 * "not configured" answer with no key, and the summary the agent reads —
 * including that it never pretends mainnet data is the testnet book.
 */
import {
  NANSEN_CACHE_TTL_MS,
  NansenClient,
  fetchSmartMoneySignals,
  tokenForMarket,
  type SmartMoneySignals,
} from './nansen';

const KEY = 'test-nansen-key';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function netflowBody(overrides: Record<string, unknown> = {}) {
  return {
    data: [
      {
        token_address: '0x00000000000000000000000000000000000000cd',
        token_symbol: 'MON',
        net_flow_1h_usd: 1200,
        net_flow_24h_usd: 45_000,
        net_flow_7d_usd: 200_000,
        net_flow_30d_usd: 900_000,
        chain: 'monad',
        token_sectors: ['Layer 1'],
        trader_count: 87,
        token_age_days: 400,
        market_cap_usd: 1e9,
        ...overrides,
      },
    ],
    pagination: { page: 1, per_page: 100, is_last_page: true },
  };
}

function dexTradesBody(trades: Array<Record<string, unknown>> = []) {
  const buy = {
    chain: 'monad',
    block_timestamp: '2026-09-17T08:00:00Z',
    transaction_hash: '0xabc',
    trader_address: '0x1111111111111111111111111111111111111111',
    trader_address_label: 'smart.eth',
    token_bought_address: '0x00000000000000000000000000000000000000cd',
    token_sold_address: '0xusdc',
    token_bought_amount: 10_000,
    token_sold_amount: 3_000,
    token_bought_symbol: 'MON',
    token_sold_symbol: 'USDC',
    token_bought_age_days: 400,
    token_sold_age_days: 400,
    trade_value_usd: 3_000,
  };
  return {
    data: trades.length > 0 ? trades : [buy],
    pagination: { page: 1, per_page: 200, is_last_page: true },
  };
}

/** A stand-in for `api.nansen.ai` that counts calls per path. */
function fakeNansen(
  options: {
    netflow?: () => { status: number; body: unknown };
    trades?: () => { status: number; body: unknown };
    delayMs?: number;
  } = {},
) {
  const calls: Captured[] = [];
  const netflow = options.netflow ?? (() => ({ status: 200, body: netflowBody() }));
  const trades = options.trades ?? (() => ({ status: 200, body: dexTradesBody() }));
  const fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    const reply = path.endsWith('/netflow') ? netflow() : trades();
    const done = () =>
      Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
    return options.delayMs ? new Promise((r) => setTimeout(r, options.delayMs)).then(done) : done();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function clientWith(fake: ReturnType<typeof fakeNansen>, overrides: { apiKey?: string } = {}) {
  return new NansenClient({
    apiKey: overrides.apiKey === undefined ? KEY : overrides.apiKey,
    fetch: fake.fetch,
    now: () => 1_000,
  });
}

describe('NansenClient', () => {
  it('reports not configured with a clean signal when no key is set', async () => {
    const fake = fakeNansen();
    const client = new NansenClient({ apiKey: '   ', fetch: fake.fetch });
    const signals = await fetchSmartMoneySignals(client, 'MON-USDC');
    expect(signals.status).toBe('not_configured');
    expect(fake.calls).toEqual([]);
  });

  it('sends the apikey header and the monad chain to both endpoints', async () => {
    const fake = fakeNansen();
    const client = clientWith(fake);
    const signals = await fetchSmartMoneySignals(client, 'MON-USDC');
    expect(signals.status).toBe('ok');
    expect(fake.calls.map((c) => new URL(c.url).pathname).sort()).toEqual([
      '/api/v1/smart-money/dex-trades',
      '/api/v1/smart-money/netflow',
    ]);
    for (const call of fake.calls) {
      expect(call.headers['apikey']).toBe(KEY);
      expect(call.body['chains']).toEqual(['monad']);
    }
    expect(fake.calls[0]!.body['filters']).toMatchObject({ token_address: 'MON' });
  });

  it('answers from cache for 10 minutes and refetches after it', async () => {
    const fake = fakeNansen();
    let clock = 1_000;
    const client = new NansenClient({ apiKey: KEY, fetch: fake.fetch, now: () => clock });
    await fetchSmartMoneySignals(client, 'MON-USDC');
    await fetchSmartMoneySignals(client, 'MON-USDC');
    expect(fake.calls).toHaveLength(2); // one per endpoint, not two each
    clock += NANSEN_CACHE_TTL_MS - 1;
    await fetchSmartMoneySignals(client, 'MON-USDC');
    expect(fake.calls).toHaveLength(2);
    clock += 2;
    await fetchSmartMoneySignals(client, 'MON-USDC');
    expect(fake.calls).toHaveLength(4);
  });

  it('caches a failing call too, so a dead key stops spending credits', async () => {
    const fake = fakeNansen({
      netflow: () => ({ status: 429, body: { message: 'insufficient credits for today' } }),
      trades: () => ({ status: 429, body: { message: 'insufficient credits for today' } }),
    });
    const client = clientWith(fake);
    const first = await fetchSmartMoneySignals(client, 'MON-USDC');
    const second = await fetchSmartMoneySignals(client, 'MON-USDC');
    expect(first.status).toBe('unavailable');
    expect(second).toEqual(first);
    expect(fake.calls).toHaveLength(2); // the 429 was not re-fetched
  });

  it('dedupes concurrent calls into one request per endpoint', async () => {
    const fake = fakeNansen({ delayMs: 5 });
    const client = clientWith(fake);
    const [a, b] = await Promise.all([
      fetchSmartMoneySignals(client, 'MON-USDC'),
      fetchSmartMoneySignals(client, 'MON-USDC'),
    ]);
    expect(fake.calls).toHaveLength(2);
    expect(a).toEqual(b);
  });

  it('surfaces Nansen’s message without leaking the key', async () => {
    const fake = fakeNansen({
      netflow: () => ({ status: 401, body: { message: 'invalid apikey' } }),
    });
    const client = clientWith(fake);
    const signals = await fetchSmartMoneySignals(client, 'MON-USDC');
    expect(signals.status).toBe('unavailable');
    expect(JSON.stringify(signals)).not.toContain(KEY);
    expect((signals as { message: string }).message).toContain('invalid apikey');
  });
});

describe('fetchSmartMoneySignals', () => {
  async function signalsFor(
    options: Parameters<typeof fakeNansen>[0] = {},
  ): Promise<SmartMoneySignals> {
    const fake = fakeNansen(options);
    const client = clientWith(fake);
    return fetchSmartMoneySignals(client, 'MON-USDC');
  }

  it('summarises direction, size, wallets and buys vs sells', async () => {
    const signals = await signalsFor();
    expect(signals).toMatchObject({
      status: 'ok',
      source: 'nansen',
      market: 'MON-USDC',
      token: 'MON',
      chain: 'monad',
      network: 'mainnet',
      flow24h: {
        netUsd: 45_000,
        net1hUsd: 1200,
        direction: 'accumulating',
        smartMoneyWallets: 87,
      },
      dexTrades24h: { buys: 1, sells: 0, buyUsd: 3_000, sellUsd: 0, wallets: 1 },
    });
  });

  it('flags mainnet-as-context in every ok summary', async () => {
    const signals = await signalsFor();
    expect(JSON.stringify(signals)).toMatch(/MAINNET[\s\S]*TESTNET/i);
  });

  it('reads a negative flow as distributing', async () => {
    const signals = await signalsFor({
      netflow: () => ({ status: 200, body: netflowBody({ net_flow_24h_usd: -120_000 }) }),
      trades: () => ({ status: 200, body: { data: [], pagination: { is_last_page: true } } }),
    });
    expect(signals.status).toBe('ok');
    expect((signals as { flow24h: { direction: string } }).flow24h.direction).toBe('distributing');
  });

  it('counts buys and sells across both trade directions', async () => {
    const sell = {
      token_bought_symbol: 'USDC',
      token_sold_symbol: 'MON',
      trader_address: '0x2222222222222222222222222222222222222222',
      trade_value_usd: 500,
    };
    const signals = await signalsFor({
      trades: () => ({ status: 200, body: dexTradesBody([sell]) }),
    });
    expect((signals as { dexTrades24h: unknown }).dexTrades24h).toMatchObject({
      buys: 0,
      sells: 1,
      sellUsd: 500,
      wallets: 1,
    });
  });

  it('reports no_data when neither endpoint has the token', async () => {
    const signals = await signalsFor({
      netflow: () => ({ status: 200, body: { data: [], pagination: { is_last_page: true } } }),
      trades: () => ({ status: 200, body: { data: [], pagination: { is_last_page: true } } }),
    });
    expect(signals.status).toBe('no_data');
  });

  it('still answers from a netflow-only result when trades are unavailable', async () => {
    const signals = await signalsFor({
      trades: () => ({ status: 500, body: { message: 'internal error' } }),
    });
    expect(signals.status).toBe('unavailable');
    expect((signals as { partial: string }).partial).toBe('dex-trades');
  });

  it('marks the page truncated when Nansen says so', async () => {
    const fake = fakeNansen({
      trades: () => ({
        status: 200,
        body: { data: [], pagination: { page: 1, per_page: 200, is_last_page: false } },
      }),
    });
    const client = clientWith(fake);
    const result = await client.dexTrades();
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('never throws on a network failure', async () => {
    const client = new NansenClient({
      apiKey: KEY,
      fetch: (() => Promise.reject(new Error('socket hang up'))) as typeof globalThis.fetch,
    });
    const signals = await fetchSmartMoneySignals(client, 'MON-USDC');
    expect(signals.status).toBe('unavailable');
    expect(JSON.stringify(signals)).toContain('socket hang up');
  });
});

describe('tokenForMarket', () => {
  it('maps our market bases to their mainnet proxies', () => {
    expect(tokenForMarket('MON-USDC')).toEqual({ symbol: 'MON', native: true });
    expect(tokenForMarket('WETH-USDC')).toEqual({ symbol: 'WETH', native: false });
    expect(tokenForMarket('cbBTC-USDC')).toEqual({ symbol: 'cbBTC', native: false });
    expect(tokenForMarket('XAUt-USDC')).toEqual({ symbol: 'XAUt', native: false });
    expect(tokenForMarket('BTC-PERP')).toEqual({ symbol: 'cbBTC', native: false });
  });

  it('falls back to the base itself for unknown markets', () => {
    expect(tokenForMarket('FOO-USDC')).toEqual({ symbol: 'FOO', native: false });
  });
});
