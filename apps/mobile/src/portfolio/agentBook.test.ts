/** SEN-215: the Agents section sorted into balances, open and closed. Plain node. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentPortfolioDto, SpotHoldingDto } from '../agents/api.ts';
import { toLedgerEntries, type LedgerEvent } from '../agents/ledger.ts';
import type { TickerDto } from '../markets/api.ts';

import { agentBook, type AgentBookInput } from './agentBook.ts';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const HOUR = 3_600_000;
const LATER = NOW / 1000 + 7 * 24 * 3600;

function ticker(symbol: string, last: string | null): TickerDto {
  return {
    venue: 'kuru',
    symbol,
    quote: 'USDC',
    last,
    mark: null,
    index: null,
    bid: null,
    ask: null,
    mid: null,
    open24h: null,
    high24h: null,
    low24h: null,
    change24h: null,
    change24hPct: null,
    quoteVolume24h: null,
    funding: null,
    stale: false,
    asOf: NOW,
  };
}

const TICKERS = [ticker('WETH-USDC', '2542.20'), ticker('MON-USDC', null)];

function holding(asset: string, amount: string, covered: string, value: string | null) {
  return {
    asset,
    market: `${asset}-USDC`,
    amount,
    inWallet: amount,
    inAccount: '0',
    lockedInOrders: '0',
    markPrice: null,
    value,
    costBasis: {
      avgPrice: covered === '0' ? null : '2400',
      coveredSize: covered,
      uncoveredSize: '0',
      unrealizedPnl: covered === '0' ? null : '1.39',
      complete: true,
      source: 'event-log-fifo',
    },
  } satisfies SpotHoldingDto;
}

function portfolio(
  usdc: string,
  holdings: SpotHoldingDto[] = [],
  perp: { margin: string; pnl: string } | null = null,
): AgentPortfolioDto {
  return {
    agentId: 'x',
    address: '0x0',
    asOf: NOW,
    wallet: {
      ok: true,
      balances: [{ asset: 'USDC', available: usdc, locked: '0', total: usdc, decimals: 6 }],
    },
    kuru: { ok: true, accountId: null, balances: [], openOrders: [] },
    perpl: perp
      ? {
          ok: true,
          status: 'ok',
          accountId: '1',
          balances: [{ asset: 'AUSD', available: '0', locked: perp.margin, total: perp.margin }],
          positions: [
            {
              symbol: 'BTC-PERP',
              side: 'long',
              size: '0.0013',
              entryPrice: '61800',
              markPrice: '62100',
              liquidationPriceEst: null,
              leverage: 2,
              margin: perp.margin,
              unrealizedPnl: perp.pnl,
              realizedPnl: null,
              fundingPaid: null,
              quote: 'AUSD',
              updatedAt: NOW,
            },
          ],
          openOrders: [],
        }
      : { ok: true, status: 'no_account' },
    holdings,
    totals: { approxUsd: '0', byQuote: { USDC: '0', AUSD: '0' }, note: '' },
  } as AgentPortfolioDto;
}

function agent(
  id: string,
  name: string,
  extra: Partial<AgentBookInput['agent']> = {},
): AgentBookInput['agent'] {
  return { id, name, status: 'active', mandate: { expiresAt: LATER }, ...extra };
}

function events(...list: Omit<LedgerEvent, 'detail'>[]): ReturnType<typeof toLedgerEntries> {
  return toLedgerEntries(list as LedgerEvent[]);
}

const fill = (seq: number, at: number, symbol: string, side: string): LedgerEvent => ({
  seq,
  at,
  kind: 'fill',
  detail: { venue: 'kuru', symbol, side, filledSize: '0.01', averageFillPrice: '2400' },
});
const verdict = (seq: number, at: number, symbol: string, pnl: string, pnlAsset?: string) =>
  ({
    seq,
    at,
    kind: 'verdict',
    detail: { symbol, direction: 'long', pnl, ...(pnlAsset ? { pnlAsset } : {}) },
  }) satisfies LedgerEvent;

const INPUTS: AgentBookInput[] = [
  {
    agent: agent('night', 'Night desk'),
    portfolio: portfolio('50', [holding('MON', '0.15', '0', null)]),
    entries: [],
  },
  {
    agent: agent('trend', 'Trend desk'),
    portfolio: portfolio('10', [holding('WETH', '0.0098', '0.0098', '24.91')], {
      margin: '40',
      pnl: '0.62',
    }),
    entries: events(
      fill(1, NOW - 5 * HOUR, 'WETH-USDC', 'buy'),
      verdict(2, NOW - 3 * HOUR, 'WETH-USDC', '1.234', 'USDC'),
      verdict(3, NOW - HOUR, 'BTC-PERP', '-0.5'),
    ),
  },
  {
    agent: agent('crazy', 'Crazy', { status: 'revoked', revokedAt: '2026-10-10T00:00:00Z' }),
    portfolio: portfolio('0', [holding('MON', '0.1452', '0', null)]),
    entries: [],
  },
  {
    agent: agent('empty', 'Emptied', { status: 'revoked' }),
    portfolio: portfolio('0'),
    entries: [],
  },
  {
    agent: agent('old', 'Lapsed', { mandate: { expiresAt: NOW / 1000 - 60 } }),
    portfolio: portfolio('5'),
    entries: null,
  },
  { agent: agent('blind', 'Unread'), portfolio: null, entries: [] },
];

test('balances: one row per agent with its status and one dollar figure', () => {
  const book = agentBook(INPUTS, TICKERS, NOW);
  assert.deepEqual(
    book.balances.map((b) => [b.name, b.status, b.value?.usd ?? null, b.value?.unpriced ?? null]),
    [
      ['Night desk', 'active · idle', '50.00', ['MON']],
      // 10 USDC + 40.62 AUSD (margin + P&L) + 0.0098 WETH at 2,542.20 = 24.91.
      ['Trend desk', 'active · trading', '75.53', []],
      ['Crazy', 'revoked · ready to return', '0.00', ['MON']],
      ['Lapsed', 'expired · ready to return', '5.00', []],
      ['Unread', 'active', null, null],
    ],
    'an emptied revoked agent is not listed; an unread one is, with no figure',
  );
  assert.equal(book.balances.find((b) => b.name === 'Crazy')?.over, true);
});

test('the agents part of the total is valued at the same prices, MON listed not added', () => {
  const book = agentBook(INPUTS, TICKERS, NOW);
  assert.equal(book.total?.usd, '130.53');
  assert.deepEqual(
    book.total?.amounts.map((a) => a.asset),
    ['USDC', 'AUSD', 'MON', 'WETH'],
  );
});

test('open: every agent position, naming the agent and the entry', () => {
  const book = agentBook(INPUTS, TICKERS, NOW);
  assert.deepEqual(
    book.open.map((p) => [p.symbol, p.side, p.leverage, p.caption, p.value, p.unit]),
    [
      ['BTC-PERP', 'long', 2, 'Trend desk · entry 61800', '40.62', 'AUSD'],
      ['WETH', 'long', null, 'Trend desk · entry 2400', '24.91', 'USDC'],
    ],
  );
});

test('closed: realised round trips, newest first, P&L named in its asset', () => {
  const book = agentBook(INPUTS, TICKERS, NOW);
  assert.deepEqual(
    book.closed.map((c) => [c.title, c.pnl, c.tone, c.caption]),
    [
      ['BTC-PERP', '−0.50 AUSD', 'down', 'Trend desk · closed Oct 13'],
      ['WETH', '+1.23 USDC', 'up', 'Trend desk · closed Oct 13 · held 2h'],
    ],
  );
  assert.equal(book.closedPending, true, 'Lapsed’s log is still being read');
});
