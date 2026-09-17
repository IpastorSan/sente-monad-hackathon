/**
 * The Envio HyperIndex client (SEN-25's indexer, consumed here).
 *
 * Envio serves its schema through Hasura, so the generated `Account` root and
 * `_in` / `where` arguments are available; the query below is the one
 * `docs/indexer.md` §"GraphQL for the leaderboard" records for the top
 * accounts, narrowed to the addresses we actually have agents for.
 *
 * A `Trade` tape is deliberately NOT read: one row per match over 7 days of
 * history would be a page-per-agent, and every number the leaderboard needs is
 * already a stored rollup on `Account` (realised PnL, win/loss counts, custody
 * flows). See `docs/leaderboard.md` for why the rollup and not the tape.
 *
 * Nothing here computes a metric: this file moves rows and refuses rows it
 * cannot trust. `metrics.ts` does the arithmetic.
 */
import { Logger } from '@nestjs/common';

/** DI token for the indexer reader. */
export const INDEXER_STATS = Symbol('INDEXER_STATS');

/** One token's custody on one account. Envio maps the relation to `token`. */
export interface IndexerAccountBalance {
  /** Lowercase ERC-20 address; the zero address is native MON. */
  readonly token: string;
  readonly decimals: number;
  /** Raw token units, as decimal strings — `BigInt!` in the schema. */
  readonly deposited: string;
  readonly withdrawn: string;
  /** `deposited − withdrawn`. A FLOW, not a balance (schema.graphql §AccountBalance). */
  readonly net: string;
}

/**
 * `Account`: one venue trading account, with Envio's own cross-market rollup.
 * `address` is null until the venue's registration event is seen, which is why
 * a row can be matched to an agent only by a non-null address.
 */
export interface IndexerAccount {
  readonly id: string;
  readonly venue: string;
  readonly address: string | null;
  readonly totalTradeCount: number;
  readonly totalVolumeUsd: string;
  readonly realizedPnlUsd: string;
  readonly winningTradeCount: number;
  readonly losingTradeCount: number;
  readonly balances: readonly IndexerAccountBalance[];
}

export interface IndexerStats {
  /** Every account owned by any of `addresses`. Never rejects for "none found". */
  accountsFor(addresses: readonly string[]): Promise<IndexerAccount[]>;
}

/** The indexer is not wired up: `ENVIO_GRAPHQL_URL` is unset. */
export class IndexerUnconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexerUnconfiguredError';
  }
}

/** The indexer was asked and did not answer usefully: a transport or schema failure. */
export class IndexerQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexerQueryError';
  }
}

/**
 * The GraphQL document. `limit` is explicit because Hasura's default would
 * silently truncate a board of many agents; 500 accounts is far past anything
 * this app will own before the indexer gets a `where`-by-user filter.
 */
export const LEADERBOARD_ACCOUNTS_QUERY = `
query LeaderboardAccounts($addresses: [String!]!, $limit: Int!) {
  Account(where: { address: { _in: $addresses } }, limit: $limit) {
    id
    venue
    address
    totalTradeCount
    totalVolumeUsd
    realizedPnlUsd
    winningTradeCount
    losingTradeCount
    balances {
      token
      decimals
      deposited
      withdrawn
      net
    }
  }
}
`;

export const LEADERBOARD_ACCOUNTS_LIMIT = 500;

export interface EnvioIndexerStatsOptions {
  /** Envio's GraphQL endpoint (Hasura). */
  readonly url: string;
  /** Injectable for specs; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Seconds before the request is abandoned. A board that hangs is not a board. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class EnvioIndexerStats implements IndexerStats {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor({
    url,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: EnvioIndexerStatsOptions) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async accountsFor(addresses: readonly string[]): Promise<IndexerAccount[]> {
    if (addresses.length === 0) return [];
    // Envio keys addresses lowercase (schema.graphql), and an EIP-55 address
    // that differs only in case matches nothing.
    const lowercased = [...new Set(addresses.map((address) => address.toLowerCase()))];

    const body = JSON.stringify({
      query: LEADERBOARD_ACCOUNTS_QUERY,
      variables: { addresses: lowercased, limit: LEADERBOARD_ACCOUNTS_LIMIT },
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // `fetch`'s own failure message is the bare "fetch failed", so this
      // never leaks the endpoint (which may carry a token in its query).
      throw new IndexerQueryError(
        `the indexer could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new IndexerQueryError(`the indexer answered ${response.status}`);
    }

    const payload = parse(text);
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new IndexerQueryError(`the indexer reported: ${graphQlMessage(payload.errors[0])}`);
    }
    const rows = payload.data?.Account;
    if (!Array.isArray(rows)) {
      throw new IndexerQueryError('the indexer answered without an Account list');
    }
    return rows.map(toAccount);
  }
}

/**
 * Bound when `ENVIO_GRAPHQL_URL` is unset, so the API still boots — the same
 * call `agent-wallet.provider.ts` makes for Privy. Every read refuses with a
 * typed error rather than answering empty, because an empty board and an
 * unconfigured one mean different things to a reader.
 */
export class UnconfiguredIndexerStats implements IndexerStats {
  accountsFor(): Promise<IndexerAccount[]> {
    return Promise.reject(
      new IndexerUnconfiguredError(
        'ENVIO_GRAPHQL_URL is not set, so no fills are indexed and there is nothing to rank',
      ),
    );
  }
}

/** Boot-time summary. The URL is never printed: an Envio endpoint may carry a token. */
export function describeIndexerConfig(url: string | undefined, logger: Logger): void {
  if (url === undefined) {
    logger.warn(
      'ENVIO_GRAPHQL_URL is not set: GET /leaderboard will answer unconfigured and rank nothing. ' +
        'See docs/leaderboard.md.',
    );
    return;
  }
  logger.log('indexer=envio (url set) for the leaderboard');
}

// ---------------------------------------------------------------------------
// Response parsing. A malformed row is refused, never coerced: a missing
// `realizedPnlUsd` read as 0 would put a number we cannot stand behind on a
// board whose entire point is that its numbers are real.

interface GraphQlResponse {
  readonly data?: { readonly Account?: unknown };
  readonly errors?: readonly unknown[];
}

function graphQlMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message !== '' ? message : 'an error with no message';
}

function parse(text: string): GraphQlResponse {
  try {
    return JSON.parse(text) as GraphQlResponse;
  } catch {
    throw new IndexerQueryError('the indexer answered with something that is not JSON');
  }
}

function toAccount(row: unknown): IndexerAccount {
  const record = asRecord(row);
  return {
    id: text(record, 'id'),
    venue: text(record, 'venue'),
    address: optionalText(record, 'address')?.toLowerCase() ?? null,
    totalTradeCount: count(record, 'totalTradeCount'),
    totalVolumeUsd: decimal(record, 'totalVolumeUsd'),
    realizedPnlUsd: decimal(record, 'realizedPnlUsd'),
    winningTradeCount: count(record, 'winningTradeCount'),
    losingTradeCount: count(record, 'losingTradeCount'),
    balances: balances(record['balances']),
  };
}

function balances(value: unknown): IndexerAccountBalance[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new IndexerQueryError('an Account balance list is not a list');
  return value.map((entry) => {
    const record = asRecord(entry);
    return {
      token: text(record, 'token'),
      decimals: count(record, 'decimals'),
      deposited: integer(record, 'deposited'),
      withdrawn: integer(record, 'withdrawn'),
      net: integer(record, 'net'),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new IndexerQueryError('an Account row is not an object');
  }
  return value as Record<string, unknown>;
}

function text(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new IndexerQueryError(`an Account row has no ${key}`);
  }
  return value;
}

function optionalText(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function count(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new IndexerQueryError(`an Account row has no usable ${key}`);
  }
  return value;
}

/** `Int!`. */
function integer(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  throw new IndexerQueryError(`an Account balance has no usable ${key}`);
}

/** `BigDecimal!`, which Hasura serialises as a string. */
function decimal(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return value;
  throw new IndexerQueryError(`an Account row has no usable ${key}`);
}
