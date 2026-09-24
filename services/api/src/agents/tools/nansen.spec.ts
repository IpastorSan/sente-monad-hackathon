/**
 * SEN-29: the Nansen client against a fake fetch. What matters here is the
 * shape the free plan forces (cache, dedupe, cached failures), the honest
 * "not configured" answer with no key, and the summary the agent reads —
 * including that it never pretends mainnet data is the testnet book.
 *
 * SEN-49 added the assertions that would have caught the live 422: the wire
 * body must never put a SYMBOL where Nansen validates an address, and rows are
 * tied to the token by its mainnet contract address.
 */
import {
  NANSEN_CACHE_TTL_MS,
  NansenClient,
  fetchSmartMoneySignals,
  tokenForMarket,
  type SmartMoneySignals,
} from './nansen';

const KEY = 'test-nansen-key';

/** Monad mainnet, from monad-crypto/token-list `tokenlist-mainnet.json`. */
const MON_NATIVE = '0x0000000000000000000000000000000000000000';
const WMON = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a';
const WETH = '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242';
const CBBTC = '0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b';
const XAUT0 = '0x01bff41798a0bcf287b996046ca68b395dbc1071';
const USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function netflowBody(overrides: Record<string, unknown> = {}) {
  return {
    data: [
      {
        token_address: MON_NATIVE,
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
    token_bought_address: WMON,
    token_sold_address: USDC,
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
  });

  // SEN-49. This is the spec the original work did not have: the live API
  // validates `filters.token_address` as an ADDRESS (a symbol is a 422
  // `Invalid address format`) and then matches nothing even for an address it
  // returned itself, so the request must carry no token filter at all — and
  // above all must never carry a symbol in that field.
  it('never sends a symbol where Nansen validates an address', async () => {
    const fake = fakeNansen();
    const client = clientWith(fake);
    await fetchSmartMoneySignals(client, 'MON-USDC');
    const netflow = fake.calls.find((c) => new URL(c.url).pathname.endsWith('/netflow'))!;
    const filters = netflow.body['filters'] as Record<string, unknown>;
    expect(filters).toEqual({ include_native_tokens: true, include_stablecoins: true });
    for (const call of fake.calls) {
      for (const [name, value] of Object.entries(call.body['filters'] ?? {})) {
        if (!name.endsWith('_address')) continue;
        for (const one of Array.isArray(value) ? value : [value]) {
          expect(String(one)).toMatch(/^0x[0-9a-f]{40}$/);
        }
      }
    }
  });

  it('sends the same netflow body for every market, so one credit serves them all', async () => {
    const fake = fakeNansen();
    const client = clientWith(fake);
    await fetchSmartMoneySignals(client, 'MON-USDC');
    await fetchSmartMoneySignals(client, 'cbBTC-USDC');
    // Same body means the same cache key: two markets, still two requests.
    expect(fake.calls).toHaveLength(2);
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
      trades: () => ({ status: 401, body: { message: 'invalid apikey' } }),
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
      token_bought_address: USDC,
      token_sold_address: WMON,
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
    // SEN-49: a good netflow read is worth more than nothing, clearly marked.
    expect(signals).toMatchObject({
      status: 'ok',
      matchedBy: 'address',
      dexTrades24h: null,
      degraded: { endpoint: 'dex-trades' },
      flow24h: { direction: 'accumulating' },
    });
    expect((signals as { degraded: { message: string } }).degraded.message).toContain(
      'internal error',
    );
  });

  it('answers from trades alone when netflow is unavailable', async () => {
    const signals = await signalsFor({
      netflow: () => ({ status: 500, body: { message: 'internal error' } }),
    });
    expect(signals).toMatchObject({
      status: 'ok',
      flow24h: null,
      degraded: { endpoint: 'netflow' },
      dexTrades24h: { buys: 1 },
    });
  });

  it('reports unavailable when the half that answered carries no signal', async () => {
    // Guessing "no data" here would be a claim about the endpoint that never
    // answered, so the failure is the honest answer.
    const signals = await signalsFor({
      netflow: () => ({ status: 500, body: { message: 'internal error' } }),
      trades: () => ({ status: 200, body: { data: [], pagination: { is_last_page: true } } }),
    });
    expect(signals).toMatchObject({ status: 'unavailable', partial: 'netflow' });
  });

  it('ignores a same-named impostor token at another address', async () => {
    const signals = await signalsFor({
      netflow: () => ({
        status: 200,
        body: netflowBody({ token_address: '0xdead00000000000000000000000000000000beef' }),
      }),
      trades: () => ({ status: 200, body: { data: [], pagination: { is_last_page: true } } }),
    });
    // token_symbol still says MON; the address does not, so it is not our token.
    expect(signals.status).toBe('no_data');
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
  it('maps our market bases to their verified mainnet addresses', () => {
    expect(tokenForMarket('MON-USDC')).toEqual({
      symbol: 'MON',
      addresses: [MON_NATIVE, WMON],
      native: true,
    });
    expect(tokenForMarket('WETH-USDC')).toEqual({
      symbol: 'WETH',
      addresses: [WETH],
      native: false,
    });
    expect(tokenForMarket('cbBTC-USDC')).toEqual({
      symbol: 'cbBTC',
      addresses: [CBBTC],
      native: false,
    });
    // Monad's gold token is XAUt0, not plain XAUt.
    expect(tokenForMarket('XAUt-USDC')).toEqual({
      symbol: 'XAUt0',
      addresses: [XAUT0],
      native: false,
    });
    expect(tokenForMarket('BTC-PERP')).toEqual({
      symbol: 'cbBTC',
      addresses: [CBBTC],
      native: false,
    });
  });

  it('carries a lowercase 0x address for every mapped base', () => {
    for (const market of ['MON-USDC', 'WMON-USDC', 'ETH-PERP', 'BTC-PERP', 'PAXG-USDC']) {
      const token = tokenForMarket(market);
      expect(token.addresses.length).toBeGreaterThan(0);
      for (const address of token.addresses) {
        // Nansen returns addresses lowercase and its filter is format-checked:
        // a symbol here is the SEN-49 bug.
        expect(address).toMatch(/^0x[0-9a-f]{40}$/);
      }
    }
  });

  it('falls back to the base itself, addressless, for unknown markets', () => {
    expect(tokenForMarket('FOO-USDC')).toEqual({ symbol: 'FOO', addresses: [], native: false });
  });

  it('says so when a match could only be made by symbol', async () => {
    const fake = fakeNansen({
      netflow: () => ({ status: 200, body: netflowBody({ token_symbol: 'FOO' }) }),
      trades: () => ({ status: 200, body: { data: [], pagination: { is_last_page: true } } }),
    });
    const signals = await fetchSmartMoneySignals(clientWith(fake), 'FOO-USDC');
    expect(signals).toMatchObject({ status: 'ok', token: 'FOO', matchedBy: 'symbol' });
  });
});
