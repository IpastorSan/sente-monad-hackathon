/**
 * The Envio client (SEN-26), against a recording `fetch`. No indexer, no
 * network.
 *
 * What this pins is the contract with SEN-25's schema: the operation and the
 * variables the query needs, that addresses are looked up lowercase (Envio
 * keys them that way, so an EIP-55 spelling matches nothing), and that a row
 * the client cannot trust is refused rather than read as zero.
 */
import {
  EnvioIndexerStats,
  IndexerQueryError,
  IndexerUnconfiguredError,
  LEADERBOARD_ACCOUNTS_QUERY,
  UnconfiguredIndexerStats,
} from './indexer';

const URL = 'http://indexer.test/v1/graphql';
const AGENT = '0x1111111111111111111111111111111111111111';

/** A row exactly as Hasura would serialise it: `Int!` as a number, `BigInt!` as a string. */
const ACCOUNT_ROW = {
  id: 'kuru-62',
  venue: 'KURU',
  address: AGENT,
  totalTradeCount: 12,
  totalVolumeUsd: '1043.2188',
  realizedPnlUsd: '-12.4',
  winningTradeCount: 5,
  losingTradeCount: 7,
  balances: [
    {
      token: '0xee0722ead54f1b4fe97be399be43bc0226a6f97e',
      decimals: 6,
      deposited: '150000000',
      withdrawn: '30000000',
      net: '120000000',
    },
  ],
};

type Reply = { status?: number; body?: unknown; text?: string };
type Recorded = { url: string; method: string; body: { query: string; variables: unknown } };

function recordingFetch(replies: Reply[]) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: JSON.parse(String(init?.body)) as Recorded['body'],
    });
    // The last reply is reused, so a spec can call the client twice against
    // the same answer without queueing it twice.
    const reply =
      replies.length > 1 ? replies.shift()! : (replies[0] ?? { body: { data: { Account: [] } } });
    const text = reply.text ?? JSON.stringify(reply.body ?? {});
    return new Response(text, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, client: new EnvioIndexerStats({ url: URL, fetchImpl }) };
}

describe('EnvioIndexerStats', () => {
  it('asks for the leaderboard accounts, lowercased and deduplicated', async () => {
    const { calls, client } = recordingFetch([{ body: { data: { Account: [ACCOUNT_ROW] } } }]);

    const accounts = await client.accountsFor([
      '0xAbC0000000000000000000000000000000000001',
      '0xabc0000000000000000000000000000000000001',
      '0xAbC0000000000000000000000000000000000002',
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body.query).toBe(LEADERBOARD_ACCOUNTS_QUERY);
    expect(calls[0]!.body.query).toContain('Account(where: { address: { _in: $addresses } }');
    expect(calls[0]!.body.variables).toEqual({
      addresses: [
        '0xabc0000000000000000000000000000000000001',
        '0xabc0000000000000000000000000000000000002',
      ],
      limit: 500,
    });
    expect(accounts).toHaveLength(1);
  });

  it('returns the rollups the metrics need, with every number as a string it can sum', async () => {
    const { client } = recordingFetch([{ body: { data: { Account: [ACCOUNT_ROW] } } }]);

    const [account] = await client.accountsFor([AGENT]);

    expect(account).toEqual({
      id: 'kuru-62',
      venue: 'KURU',
      address: AGENT,
      totalTradeCount: 12,
      totalVolumeUsd: '1043.2188',
      realizedPnlUsd: '-12.4',
      winningTradeCount: 5,
      losingTradeCount: 7,
      balances: [
        {
          token: '0xee0722ead54f1b4fe97be399be43bc0226a6f97e',
          decimals: 6,
          deposited: '150000000',
          withdrawn: '30000000',
          net: '120000000',
        },
      ],
    });
  });

  it('does not call the indexer at all when there are no agents to look up', async () => {
    const { calls, client } = recordingFetch([]);

    await expect(client.accountsFor([])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('accepts an account whose registration event has not been seen yet', async () => {
    const { client } = recordingFetch([
      { body: { data: { Account: [{ ...ACCOUNT_ROW, address: null, balances: [] }] } } },
    ]);

    const [account] = await client.accountsFor([AGENT]);

    expect(account).toMatchObject({ address: null, balances: [] });
  });

  it.each([
    ['a non-2xx answer', { status: 503, text: 'upstream is down' }, /answered 503/],
    [
      'a GraphQL error',
      { body: { errors: [{ message: 'field "Account" not found in type: "query_root"' }] } },
      /the indexer reported: field "Account" not found/,
    ],
    ['something that is not JSON', { text: '<html>502</html>' }, /not JSON/],
    ['an answer with no Account list', { body: { data: {} } }, /without an Account list/],
    [
      'a row with no realised PnL',
      { body: { data: { Account: [{ ...ACCOUNT_ROW, realizedPnlUsd: null }] } } },
      /no usable realizedPnlUsd/,
    ],
    [
      'a row with a non-numeric win count',
      { body: { data: { Account: [{ ...ACCOUNT_ROW, winningTradeCount: 'five' }] } } },
      /no usable winningTradeCount/,
    ],
    [
      'a balance whose net is not a number',
      {
        body: {
          data: {
            Account: [{ ...ACCOUNT_ROW, balances: [{ ...ACCOUNT_ROW.balances[0], net: 'many' }] }],
          },
        },
      },
      /no usable net/,
    ],
  ])('refuses %s', async (_label: string, reply: Reply, expected: RegExp) => {
    const { client } = recordingFetch([reply]);

    await expect(client.accountsFor([AGENT])).rejects.toThrow(expected);
    await expect(client.accountsFor([AGENT])).rejects.toBeInstanceOf(IndexerQueryError);
  });

  it('reports an unreachable indexer without echoing its URL', async () => {
    const client = new EnvioIndexerStats({
      url: 'http://indexer.test/v1/graphql?token=super-secret',
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch,
    });

    await expect(client.accountsFor([AGENT])).rejects.toThrow(/could not be reached: fetch failed/);
    await expect(client.accountsFor([AGENT])).rejects.not.toThrow(/super-secret/);
  });
});

describe('UnconfiguredIndexerStats', () => {
  it('refuses with a typed error rather than answering an empty board', async () => {
    await expect(new UnconfiguredIndexerStats().accountsFor()).rejects.toBeInstanceOf(
      IndexerUnconfiguredError,
    );
    await expect(new UnconfiguredIndexerStats().accountsFor()).rejects.toThrow(
      /ENVIO_GRAPHQL_URL is not set/,
    );
  });
});
