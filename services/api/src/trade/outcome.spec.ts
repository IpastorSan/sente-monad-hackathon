import type { AuthorizationPayload } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, type KuruLog, type KuruMarketParams } from '@sente/venues/kuru';
import { getAddress } from 'viem';

import { fundsAfter, placeResult, revertedPlaceResult, TradeOutcomes } from './outcome';
import type { KuruPlaceContext, StepKind, StepStatus, Trade, TradeStep } from './trade-store';

// Real Monad testnet receipts (account 62 on MON/USDC), shared with the venue
// package's own decoder tests. Loaded by path at runtime: the file lives
// outside this package's `rootDir`, so a static import would not typecheck.
const { RECEIPT_ACCOUNT_ID, RECEIPTS } = jest.requireActual<{
  RECEIPT_ACCOUNT_ID: bigint;
  RECEIPTS: Record<'placeLimit' | 'cancel' | 'placeMarket', { logs: readonly KuruLog[] }>;
}>('../../../../packages/venues/src/kuru/receipts.fixture.ts');

const MON_USDC = KURU_TESTNET_MARKETS.find((m) => m.symbol === 'MON-USDC')!;

/** The market's params when the fixtures were recorded (as in `receipts.test.ts`). */
const PARAMS: KuruMarketParams = {
  pricePrecision: 1_000_000n,
  sizePrecision: 100_000_000n,
  tickSize: 1n,
  minQuoteNotional: 10_000_000n,
  maxQuoteNotional: 5_000_000_000_000n,
  takerFeePps: 7000n,
  makerFeePps: 4000n,
};

function context(patch: Partial<KuruPlaceContext> = {}): KuruPlaceContext {
  return {
    market: MON_USDC.address,
    symbol: MON_USDC.symbol,
    side: 'buy',
    orderType: 'market',
    timeInForce: 'IOC',
    // `placeMarket` asked for 388 MON at a 2% bound.
    quantity: 388n * 10n ** 8n,
    price: '0.031593',
    params: PARAMS,
    quoteDecimals: 6,
    funding: { symbol: 'USDC', decimals: 6, deposit: 12_500_000n },
    ...patch,
  };
}

/** `placeLimit`: a 500 MON GTC bid at 0.02 that rested whole. */
const GTC = context({
  orderType: 'limit',
  timeInForce: 'GTC',
  quantity: 500n * 10n ** 8n,
  price: '0.02',
});

describe('placeResult', () => {
  it('reads the IOC partial fill as partially_filled with the remainder cancelled', () => {
    const result = placeResult(RECEIPTS.placeMarket.logs, RECEIPT_ACCOUNT_ID, context());
    expect(result).toMatchObject({
      status: 'partially_filled',
      requestedSize: '388',
      filledSize: '317.73742494',
      unfilledCancelled: '70.26257506',
      avgPrice: '0.030974',
      // 7000 pps of a 9.841599 USDC fill, floored at the atom (SEN-20).
      fee: '0.006889',
      feeAsset: 'USDC',
    });
    expect(result.orderId).toBeUndefined();
    expect(result.fills.length).toBeGreaterThan(0);
    expect(result.fills.every((f) => f.price === '0.030974' && /^\d+$/.test(f.tradeId))).toBe(true);
  });

  it('reads a GTC that rested as resting with its orderId', () => {
    expect(placeResult(RECEIPTS.placeLimit.logs, RECEIPT_ACCOUNT_ID, GTC)).toEqual({
      status: 'resting',
      orderId: '0:3680',
      requestedSize: '500',
      filledSize: '0',
      fee: '0',
      feeAsset: 'USDC',
      fills: [],
    });
  });

  it('calls an IOC that took nothing cancelled, the whole size discarded', () => {
    expect(placeResult([], RECEIPT_ACCOUNT_ID, context())).toMatchObject({
      status: 'cancelled',
      filledSize: '0',
      unfilledCancelled: '388',
      fills: [],
    });
  });

  it('calls a POST_ONLY that neither filled nor rested rejected', () => {
    const postOnly = { ...GTC, timeInForce: 'POST_ONLY' } as const;
    expect(placeResult([], RECEIPT_ACCOUNT_ID, postOnly).status).toBe('rejected');
  });

  it('reads nothing into another account', () => {
    const result = placeResult(RECEIPTS.placeMarket.logs, RECEIPT_ACCOUNT_ID + 1n, context());
    expect(result).toMatchObject({ status: 'cancelled', filledSize: '0' });
  });

  it('reports a reverted place as rejected with nothing filled', () => {
    expect(revertedPlaceResult(context())).toEqual({
      status: 'rejected',
      requestedSize: '388',
      filledSize: '0',
      fee: '0',
      feeAsset: 'USDC',
      fills: [],
    });
  });
});

const WALLET = getAddress(`0x${'a1'.repeat(20)}`);

function step(index: number, kind: StepKind, status: StepStatus): TradeStep {
  return {
    index,
    kind,
    title: kind,
    request: {} as TradeStep['request'],
    payload: {} as AuthorizationPayload,
    status,
  };
}

function trade(steps: [StepKind, StepStatus][], patch: Partial<Trade> = {}): Trade {
  const t0 = new Date('2026-09-27T12:00:00Z');
  return {
    id: 't',
    userId: 'u',
    clientTradeId: 'c',
    intentHash: 'h',
    kind: 'kuru.place',
    walletId: 'w',
    address: WALLET,
    steps: steps.map(([kind, status], i) => step(i, kind, status)),
    status: 'failed',
    createdAt: t0,
    updatedAt: t0,
    expiresAt: t0,
    place: context(),
    ...patch,
  };
}

describe('fundsAfter', () => {
  const KURU = [{ where: 'kuru', symbol: 'USDC', amount: '12.5' }];
  const WALLET_FUNDS = [{ where: 'wallet', symbol: 'USDC', amount: '12.5' }];

  it('deposited but the order reverted: in the Kuru account', () => {
    const t = trade([
      ['approve', 'included'],
      ['deposit', 'included'],
      ['place', 'reverted'],
    ]);
    expect(fundsAfter(t)).toEqual(KURU);
  });

  it('deposited but the place was never sent: in the Kuru account', () => {
    const t = trade([
      ['deposit', 'included'],
      ['place', 'not_sent'],
    ]);
    expect(fundsAfter(t)).toEqual(KURU);
  });

  it('approved only, or an atomic batch reverted: still in the wallet', () => {
    expect(
      fundsAfter(
        trade([
          ['approve', 'included'],
          ['deposit', 'reverted'],
          ['place', 'not_sent'],
        ]),
      ),
    ).toEqual(WALLET_FUNDS);
    expect(fundsAfter(trade([['batch', 'reverted']]))).toEqual(WALLET_FUNDS);
  });

  it('the order ran but took nothing: the deposit is free in the Kuru account', () => {
    const cancelled = placeResult([], RECEIPT_ACCOUNT_ID, context());
    const t = trade([['batch', 'included']], { status: 'completed', result: cancelled });
    expect(fundsAfter(t)).toEqual(KURU);
  });

  it('says nothing when the result already tells it, or when anything is unsettled', () => {
    const filled = placeResult(RECEIPTS.placeMarket.logs, RECEIPT_ACCOUNT_ID, context());
    expect(fundsAfter(trade([['batch', 'included']], { result: filled }))).toBeUndefined();
    const unsure = trade([
      ['deposit', 'included'],
      ['place', 'unknown'],
    ]);
    expect(fundsAfter(unsure)).toBeUndefined();
  });

  it('says nothing for a trade that deposited nothing, or that is not a place', () => {
    const noDeposit = context({ funding: { symbol: 'USDC', decimals: 6, deposit: 0n } });
    expect(fundsAfter(trade([['place', 'reverted']], { place: noDeposit }))).toBeUndefined();
    const { place: _none, ...cancel } = trade([['cancel', 'reverted']]);
    expect(fundsAfter(cancel)).toBeUndefined();
  });
});

describe('TradeOutcomes', () => {
  const accountId = jest.fn<Promise<bigint>, [string]>(() => Promise.resolve(RECEIPT_ACCOUNT_ID));
  const outcomes = new TradeOutcomes({ accountId });
  const logs = RECEIPTS.placeMarket.logs;

  it("decodes an included place against the wallet's own Kuru account", async () => {
    const t = trade([['place', 'included']]);
    const result = await outcomes.placeResult(t, t.steps[0], logs);
    expect(accountId).toHaveBeenCalledWith(WALLET);
    expect(result?.status).toBe('partially_filled');
  });

  it('decodes a packed batch the same way', async () => {
    const t = trade([['batch', 'included']]);
    expect((await outcomes.placeResult(t, t.steps[0], logs))?.filledSize).toBe('317.73742494');
  });

  it('gives a reverted place a rejected result without reading the chain', async () => {
    accountId.mockClear();
    const t = trade([['place', 'reverted']]);
    expect((await outcomes.placeResult(t, t.steps[0], logs))?.status).toBe('rejected');
    expect(accountId).not.toHaveBeenCalled();
  });

  it('has nothing to say about a deposit, or a trade without a place', async () => {
    const t = trade([['deposit', 'included']]);
    expect(await outcomes.placeResult(t, t.steps[0], logs)).toBeUndefined();
    const { place: _none, ...cancel } = trade([['place', 'included']]);
    expect(await outcomes.placeResult(cancel, cancel.steps[0], logs)).toBeUndefined();
  });

  it('refuses to decode against account 0 rather than report nothing filled', async () => {
    const none = new TradeOutcomes({ accountId: () => Promise.resolve(0n) });
    const t = trade([['place', 'included']]);
    await expect(none.placeResult(t, t.steps[0], logs)).rejects.toThrow(/no Kuru account/);
  });
});
