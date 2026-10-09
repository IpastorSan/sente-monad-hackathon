import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HttpException, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ContractFunctionRevertedError,
  getAddress,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem';
import type { UserOperationReceipt } from 'viem/account-abstraction';

import { PrivyClient } from '../agents/privy/privy.client';
import type { Bundler } from '../wallet/bundler/bundler';
import type { UserWalletBinding } from '../wallet/store/user-wallet-registry';
import { PrivyUserWalletProvider } from '../wallet/user-wallet.provider';
import { WalletRefusedError } from '../wallet/wallet.errors';
import { CommitTradeDto, TradeIntentDto } from './dto/trade.dto';
import { KuruPlanRefusedError, planKuru, type KuruPlan } from './kuru-planner';
import type { TradeOutcomes } from './outcome';
import {
  PerplPlanRefusedError,
  planPerplOnboard,
  type PerplPlan,
  type PerplPlanRefusalReason,
} from './perpl-planner';
import type { StepExecutor } from './step-executor';
import { TRADE_CHAIN_ID, type TradeConfig } from './trade.config';
import { TradingEnabledGuard } from './trade.controller';
import {
  SEND_UNVERIFIABLE,
  TradeService,
  UNVERIFIABLE_AFTER_MS,
  tradeIdempotencyKey,
  tradeRefusalToHttpException,
  TradeRefusedError,
} from './trade.service';
import { TradeStore, type KuruPlaceResult, type Trade, type TradeStep } from './trade-store';
import { InMemoryUserVenueSecretStore } from './user-venue-secrets';

// Only the planner is faked: it reads the chain. Its refusal class stays real,
// so the reason mapping is tested against the type the planner really throws.
jest.mock('./kuru-planner', () => {
  const actual: Record<string, unknown> = jest.requireActual('./kuru-planner');
  return { ...actual, planKuru: jest.fn() };
});
const planKuruMock = planKuru as jest.MockedFunction<typeof planKuru>;
jest.mock('./perpl-planner', () => {
  const actual: Record<string, unknown> = jest.requireActual('./perpl-planner');
  return { ...actual, planPerplOnboard: jest.fn() };
});
const planPerplMock = planPerplOnboard as jest.MockedFunction<typeof planPerplOnboard>;

const EXCHANGE = '0x1964C32f0bE608E7D29302AFF5E61268E72080cc';
const AUSD = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC';
/** The slice of the live testnet `/pub/context` onboarding reads. */
const PERPL_CONTEXT_FIXTURE = {
  chain: { chain_id: 10143 },
  instances: [
    {
      id: 12,
      address: EXCHANGE.toLowerCase(),
      collateral_token_id: 1,
      min_account_open_amount: '100000000',
      min_deposit_amount: '10000000',
      min_withdraw_amount: '10000',
    },
  ],
  tokens: [
    { id: 1, address: AUSD, symbol: 'AUSD', name: 'AUSD', decimals: 6, display_precision: 2 },
  ],
  markets: [],
};

const PERPL_THREE_STEPS: PerplPlan = {
  steps: (['perpl.approve', 'perpl.createAccount', 'perpl.allowForwarding'] as const).map(
    (kind) => ({ kind, title: kind, calls: [], transaction: { to: EXCHANGE, data: '0x01' } }),
  ),
  summary: { venue: 'perpl' },
};

beforeAll(() => Logger.overrideLogger(false));

const T0 = new Date('2026-09-27T12:00:00Z');
const ALICE = { userId: '0xa11ce' };
const BOB = { userId: '0xb0b' };
const WALLET_ID = 'wallet-alice';
const ADDRESS = getAddress(`0x${'a1'.repeat(20)}`);
const MARKET = getAddress(`0x${'4d'.repeat(20)}`);
const TOKEN = getAddress(`0x${'70'.repeat(20)}`);
const CLIENT_ID = '0b7a5c4e-2f1d-4c3b-9a8e-7d6c5b4a3f21';
const SIG = 'MEUCIQDsig==';

const BINDING: UserWalletBinding = {
  userId: ALICE.userId,
  walletId: WALLET_ID,
  address: ADDRESS,
  ownerQuorumId: 'quorum',
  devicePublicKey: 'key',
  createdAt: T0,
};

const PLACE = {
  kind: 'kuru.place',
  clientTradeId: CLIENT_ID,
  market: MARKET.toLowerCase(),
  side: 'buy',
  orderType: 'limit',
  sizeAtoms: '1000',
  priceUnits: '250',
  maxDepositAtoms: '500000',
} as const;

/** approve -> deposit -> place, with one lowercase `to` and a native-value step. */
const THREE_STEPS: KuruPlan = {
  steps: [
    {
      kind: 'approve',
      title: 'Approve USDC',
      calls: [],
      transaction: { to: TOKEN.toLowerCase() as Hex, data: '0x095ea7b3' },
    },
    {
      kind: 'deposit',
      title: 'Deposit USDC',
      calls: [],
      transaction: { to: MARKET, data: '0x47e7ef24', value: 0n },
    },
    {
      kind: 'place',
      title: 'Buy',
      calls: [],
      transaction: { to: MARKET, data: '0xb0b0', value: 5n },
    },
  ],
  summary: { market: 'MON/USDC', side: 'buy' },
};

function intent(fields: Record<string, unknown> = {}): TradeIntentDto {
  return plainToInstance(TradeIntentDto, { ...PLACE, ...fields });
}

function onboardIntent(fields: Record<string, unknown> = {}): TradeIntentDto {
  return plainToInstance(TradeIntentDto, {
    kind: 'perpl.onboard',
    clientTradeId: CLIENT_ID,
    amountAtoms: '100000000',
    ...fields,
  });
}

function hash(n: number): Hash {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

class FixedClockTradeService extends TradeService {
  at = T0;
  protected override now(): Date {
    return this.at;
  }
}

function harness(config: Partial<TradeConfig> = {}) {
  const store = new TradeStore();
  const execute = jest.fn<Promise<void>, [Trade, readonly string[]]>(() => Promise.resolve());
  const receipt = jest.fn<Promise<UserOperationReceipt | null>, [Hash]>(() =>
    Promise.resolve(null),
  );
  const placeResult = jest.fn<
    Promise<KuruPlaceResult | undefined>,
    [Trade, TradeStep, readonly unknown[]]
  >(() => Promise.resolve(undefined));
  const txReceipt = jest.fn<Promise<unknown>, [{ hash: Hash }]>(() =>
    Promise.reject(new Error('not found')),
  );
  // `getAccountByAddr`: the account tuple, or a revert for none (the default).
  const readContract = jest.fn<Promise<unknown>, [unknown]>(() =>
    Promise.reject(
      new ContractFunctionRevertedError({ abi: [], functionName: 'getAccountByAddr' }),
    ),
  );
  const bindings = new Map([[ALICE.userId, BINDING]]);
  const secrets = new InMemoryUserVenueSecretStore();
  const service = new FixedClockTradeService(
    { enabled: true, atomicBatch: false, perpl: false, chainId: TRADE_CHAIN_ID, ...config },
    store,
    { execute } as unknown as StepExecutor,
    // The real provider over a real client: its prepareSend reaches nothing,
    // and these specs are about the exact payload it builds.
    new PrivyUserWalletProvider(new PrivyClient({ appId: 'app-id', appSecret: 'secret' })),
    { find: (userId: string) => Promise.resolve(bindings.get(userId)) },
    { receipt } as Pick<Bundler, 'receipt'>,
    { getTransactionReceipt: txReceipt, readContract } as unknown as PublicClient,
    { placeResult } as unknown as TradeOutcomes,
    () => Promise.resolve(PERPL_CONTEXT_FIXTURE),
    secrets,
  );
  return { service, store, execute, receipt, placeResult, txReceipt, readContract, secrets };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TradeRefusedError || error instanceof WalletRefusedError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  planKuruMock.mockReset();
  planKuruMock.mockResolvedValue(THREE_STEPS);
  planPerplMock.mockReset();
  planPerplMock.mockResolvedValue(PERPL_THREE_STEPS);
});

describe('TradeService.prepare', () => {
  it('composes one sponsored send per step, keyed exactly as the phone expects', async () => {
    const { service } = harness();
    const prepared = await service.prepare(ALICE, intent());

    expect(planKuruMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'kuru.place', market: MARKET, postOnly: false }),
      expect.objectContaining({ wallet: ADDRESS, atomicBatch: false }),
    );
    expect(prepared).toMatchObject({
      clientTradeId: CLIENT_ID,
      expiresAt: '2026-09-27T12:05:00.000Z',
      wallet: { walletId: WALLET_ID, address: ADDRESS },
      summary: { market: 'MON/USDC', side: 'buy' },
    });
    expect(prepared.steps.map((s) => [s.index, s.kind])).toEqual([
      [0, 'approve'],
      [1, 'deposit'],
      [2, 'place'],
    ]);

    for (const step of prepared.steps) {
      expect(step.payload).toEqual({
        version: 1,
        method: 'POST',
        url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
        headers: {
          'privy-app-id': 'app-id',
          'privy-idempotency-key': `sente-trade:${CLIENT_ID}:${step.index}`,
        },
        body: {
          method: 'eth_sendTransaction',
          caip2: 'eip155:10143',
          sponsor: true,
          params: { transaction: expect.any(Object) },
        },
      });
    }
    const transactions = prepared.steps.map(
      (s) => (s.payload.body as { params: { transaction: unknown } }).params.transaction,
    );
    // Checksummed `to`; `value` absent when zero and canonical hex otherwise.
    expect(transactions).toEqual([
      { to: TOKEN, data: '0x095ea7b3', chain_id: 10143 },
      { to: MARKET, data: '0x47e7ef24', chain_id: 10143 },
      { to: MARKET, data: '0xb0b0', value: '0x5', chain_id: 10143 },
    ]);
  });

  it('keys steps with the same template as the phone', () => {
    // The phone's source is the contract; a drift there must fail here too.
    const phone = readFileSync(
      join(__dirname, '../../../../apps/mobile/src/trade/envelope.ts'),
      'utf8',
    );
    expect(phone).toContain('return `sente-trade:${clientTradeId}:${stepIndex}`;');
    expect(tradeIdempotencyKey('abc', 2)).toBe('sente-trade:abc:2');
  });

  it('returns the same trade for a retry with the same intent, without re-planning', async () => {
    const { service } = harness();
    const first = await service.prepare(ALICE, intent());
    // Address casing and an explicit postOnly: false spell the same intent.
    const again = await service.prepare(ALICE, intent({ market: MARKET, postOnly: false }));
    expect(again).toEqual(first);
    expect(planKuruMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a different intent under the same clientTradeId with trade_id_conflict', async () => {
    const { service } = harness();
    await service.prepare(ALICE, intent());
    expect(await refusal(service.prepare(ALICE, intent({ sizeAtoms: '2000' })))).toBe(
      'trade_id_conflict',
    );
  });

  it('prepares afresh once the earlier prepare expired uncommitted', async () => {
    const { service } = harness();
    const first = await service.prepare(ALICE, intent());
    service.at = new Date(T0.getTime() + 5 * 60 * 1000);
    const second = await service.prepare(ALICE, intent({ sizeAtoms: '2000' }));
    expect(second.tradeId).not.toBe(first.tradeId);
  });

  it('refuses a user with no wallet with account_not_registered', async () => {
    const { service } = harness();
    expect(await refusal(service.prepare(BOB, intent()))).toBe('account_not_registered');
  });

  it('plans perpl.onboard with the live context, forwarding unknown', async () => {
    const { service } = harness();
    const prepared = await service.prepare(ALICE, onboardIntent());
    expect(planKuruMock).not.toHaveBeenCalled();
    expect(planPerplMock).toHaveBeenCalledWith(
      { kind: 'perpl.onboard', clientTradeId: CLIENT_ID, amountAtoms: '100000000' },
      expect.objectContaining({
        wallet: ADDRESS,
        atomicBatch: false,
        context: PERPL_CONTEXT_FIXTURE,
        forwarding: null,
      }),
    );
    expect(prepared.steps.map((s) => [s.index, s.kind])).toEqual([
      [0, 'perpl.approve'],
      [1, 'perpl.createAccount'],
      [2, 'perpl.allowForwarding'],
    ]);
    expect(prepared.steps[2]!.payload.headers['privy-idempotency-key']).toBe(
      tradeIdempotencyKey(CLIENT_ID, 2),
    );
  });

  it('plans with forwarding on once an onboarding of its own completed', async () => {
    const { service, store } = harness();
    const first = await service.prepare(ALICE, onboardIntent());
    store.claimForCommit(ALICE.userId, first.tradeId, T0);
    store.update(first.tradeId, { status: 'completed' });
    await service.prepare(ALICE, onboardIntent({ clientTradeId: CLIENT_ID.replace('0b', '1c') }));
    expect(planPerplMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ forwarding: true }),
    );
  });

  it.each([
    ['below_min_account_open', 422],
    ['perpl_already_onboarded', 409],
    ['insufficient_balance', 422],
  ] as const)(
    'maps the Perpl planner refusal %s to HTTP %i',
    async (reason: PerplPlanRefusalReason, status) => {
      const { service } = harness();
      planPerplMock.mockRejectedValue(new PerplPlanRefusedError(reason, 'no'));
      const error = await service.prepare(ALICE, onboardIntent()).catch((e: unknown) => e);
      const http = tradeRefusalToHttpException(error) as HttpException;
      expect(http.getStatus()).toBe(status);
      expect(http.getResponse()).toMatchObject({ reason });
    },
  );

  it.each([
    ['below_min_notional', 422],
    ['reserve_balance', 422],
    ['deposit_cap_exceeded', 422],
    ['insufficient_balance', 422],
    ['already_terminal', 409],
    ['market_not_allowed', 400],
    ['invalid_intent', 400],
  ] as const)('maps the planner refusal %s to %i with that reason', async (reason, status) => {
    const { service } = harness();
    planKuruMock.mockRejectedValue(new KuruPlanRefusedError(reason, 'no'));
    const error = await service.prepare(ALICE, intent()).catch((e: unknown) => e);
    const http = tradeRefusalToHttpException(error) as HttpException;
    expect(http.getStatus()).toBe(status);
    expect(http.getResponse()).toMatchObject({ reason });
  });
});

describe('TradeService.commit', () => {
  it('claims once and runs the executor in the background', async () => {
    const { service, execute } = harness();
    const { tradeId } = await service.prepare(ALICE, intent());

    const view = await service.commit(ALICE, tradeId, [SIG, SIG, SIG]);
    expect(view.status).toBe('executing');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toEqual([SIG, SIG, SIG]);
    // The stored request carries the key it was signed with, for commitSend.
    expect(execute.mock.calls[0][0].steps[2].request).toMatchObject({
      idempotencyKey: `sente-trade:${CLIENT_ID}:2`,
    });
  });

  it('answers a second commit with the current view and resends nothing', async () => {
    const { service, execute } = harness();
    const { tradeId } = await service.prepare(ALICE, intent());
    await service.commit(ALICE, tradeId, [SIG, SIG, SIG]);
    const again = await service.commit(ALICE, tradeId, [SIG]);
    expect(again.tradeId).toBe(tradeId);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a miscounted commit and leaves the trade committable', async () => {
    const { service, execute } = harness();
    const { tradeId } = await service.prepare(ALICE, intent());
    expect(await refusal(service.commit(ALICE, tradeId, [SIG]))).toBe('signature_count_mismatch');
    expect((await service.status(ALICE, tradeId)).status).toBe('prepared');
    await service.commit(ALICE, tradeId, [SIG, SIG, SIG]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("answers trade_not_found for another user's trade", async () => {
    const { service, execute } = harness();
    const { tradeId } = await service.prepare(ALICE, intent());
    expect(await refusal(service.commit(BOB, tradeId, [SIG, SIG, SIG]))).toBe('trade_not_found');
    expect(await refusal(service.status(BOB, tradeId))).toBe('trade_not_found');
    expect(await service.list(BOB)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers trade_expired past the deadline', async () => {
    const { service } = harness();
    const { tradeId } = await service.prepare(ALICE, intent());
    service.at = new Date(T0.getTime() + 5 * 60 * 1000);
    expect(await refusal(service.commit(ALICE, tradeId, [SIG, SIG, SIG]))).toBe('trade_expired');
  });
});

describe('TradeService — reconcile on read', () => {
  function landed(userOpHash: Hash, success: boolean): UserOperationReceipt {
    return {
      userOpHash,
      success,
      ...(success ? {} : { reason: 'boom' }),
      logs: [],
      receipt: { transactionHash: hash(0xbeef), blockNumber: 42n },
    } as unknown as UserOperationReceipt;
  }

  /** A committed trade whose step `unknownAt` timed out, as the executor leaves it. */
  async function timedOut(unknownAt: number) {
    const h = harness();
    const { tradeId } = await h.service.prepare(ALICE, intent());
    const claimed = h.store.claimForCommit(ALICE.userId, tradeId, T0) as Trade;
    h.store.update(tradeId, {
      steps: claimed.steps.map((step, i) =>
        i < unknownAt
          ? { ...step, status: 'included' }
          : i === unknownAt
            ? { ...step, status: 'unknown', userOpHash: hash(i + 1), error: 'no receipt' }
            : { ...step, status: 'not_sent' },
      ),
    });
    return { ...h, tradeId };
  }

  it('keeps an unknown step unknown while the bundler still has nothing', async () => {
    const { service, tradeId } = await timedOut(2);
    const view = await service.status(ALICE, tradeId);
    expect(view.status).toBe('executing');
    expect(view.steps[2]).toMatchObject({ status: 'unknown', error: 'no receipt' });
  });

  it('completes the trade when the last step turns out to have landed', async () => {
    const { service, receipt, tradeId } = await timedOut(2);
    receipt.mockResolvedValue(landed(hash(3), true));
    const view = await service.status(ALICE, tradeId);
    expect(receipt).toHaveBeenCalledWith(hash(3));
    expect(view.status).toBe('completed');
    expect(view.steps[2]).toEqual({
      index: 2,
      kind: 'place',
      title: 'Buy',
      status: 'included',
      userOpHash: hash(3),
      transactionHash: hash(0xbeef),
      blockNumber: '42',
    });
  });

  it('fails the trade on a reverted operation — its own flag, not the bundle tx', async () => {
    const { service, receipt } = await timedOut(2);
    receipt.mockResolvedValue(landed(hash(3), false));
    const [view] = await service.list(ALICE);
    expect(view.status).toBe('failed');
    expect(view.steps[2]).toMatchObject({ status: 'reverted', error: 'boom' });
  });

  it('fails the trade when an earlier step landed but the rest were never sent', async () => {
    const { service, receipt, tradeId } = await timedOut(1);
    receipt.mockResolvedValue(landed(hash(2), true));
    const view = await service.status(ALICE, tradeId);
    expect(view.steps.map((s) => s.status)).toEqual(['included', 'included', 'not_sent']);
    expect(view.status).toBe('failed');
  });

  it('decodes a place it settles with the shared decoder, from the operation logs', async () => {
    const { service, receipt, placeResult, tradeId } = await timedOut(2);
    const logs = [{ address: MARKET, topics: [], data: '0x' }];
    receipt.mockResolvedValue({ ...landed(hash(3), true), logs } as UserOperationReceipt);
    const filled: KuruPlaceResult = {
      status: 'filled',
      requestedSize: '10',
      filledSize: '10',
      fee: '0.01',
      feeAsset: 'USDC',
      fills: [],
    };
    placeResult.mockResolvedValue(filled);

    const view = await service.status(ALICE, tradeId);

    expect(placeResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: tradeId }),
      expect.objectContaining({ index: 2, status: 'included' }),
      logs,
    );
    expect(view).toMatchObject({ status: 'completed', result: filled });
  });

  it('still settles the step when decoding its outcome fails', async () => {
    const { service, receipt, placeResult, tradeId } = await timedOut(2);
    receipt.mockResolvedValue(landed(hash(3), true));
    placeResult.mockRejectedValue(new Error('rpc down'));
    const view = await service.status(ALICE, tradeId);
    expect(view.status).toBe('completed');
    expect(view.result).toBeUndefined();
  });

  /** Step 2 went `unknown` with no user-operation hash, as the executor records it. */
  async function hashless(fields: Partial<TradeStep> = {}) {
    const h = harness();
    const { tradeId } = await h.service.prepare(ALICE, intent());
    const claimed = h.store.claimForCommit(ALICE.userId, tradeId, T0) as Trade;
    h.store.update(
      tradeId,
      {
        steps: claimed.steps.map((step, i) =>
          i < 2
            ? { ...step, status: 'included' }
            : { ...step, status: 'unknown', error: 'user_wallet_provider_failed', ...fields },
        ),
      },
      T0,
    );
    return { ...h, tradeId };
  }

  it('settles a plain broadcast from its own transaction receipt', async () => {
    const tx = hash(0x7);
    const { service, txReceipt, receipt, tradeId } = await hashless({ transactionHash: tx });
    txReceipt.mockResolvedValue({ status: 'success', blockNumber: 43n, logs: [] });
    const view = await service.status(ALICE, tradeId);
    expect(txReceipt).toHaveBeenCalledWith({ hash: tx });
    expect(receipt).not.toHaveBeenCalled();
    expect(view.status).toBe('completed');
    expect(view.steps[2]).toMatchObject({
      status: 'included',
      transactionHash: tx,
      blockNumber: '43',
    });
    expect(view.steps[2].error).toBeUndefined();
  });

  it('fails a plain broadcast whose transaction reverted', async () => {
    const { service, txReceipt, tradeId } = await hashless({ transactionHash: hash(0x7) });
    txReceipt.mockResolvedValue({ status: 'reverted', blockNumber: 43n, logs: [] });
    const view = await service.status(ALICE, tradeId);
    expect(view.status).toBe('failed');
    expect(view.steps[2]).toMatchObject({ status: 'reverted' });
  });

  it('keeps a hashless step unknown and the trade executing inside the window', async () => {
    const { service, tradeId } = await hashless();
    // Past the commit deadline, not yet past the window after it.
    service.at = new Date(T0.getTime() + 5 * 60 * 1000 + UNVERIFIABLE_AFTER_MS - 1);
    const view = await service.status(ALICE, tradeId);
    expect(view.status).toBe('executing');
    expect(view.steps[2]).toMatchObject({
      status: 'unknown',
      error: 'user_wallet_provider_failed',
    });
  });

  it('after the window: never not_sent, but unknown + send_unverifiable and a failed trade', async () => {
    const { service, tradeId } = await hashless();
    service.at = new Date(T0.getTime() + 5 * 60 * 1000 + UNVERIFIABLE_AFTER_MS);
    const view = await service.status(ALICE, tradeId);
    expect(view.status).toBe('failed');
    expect(view.steps[2]).toMatchObject({ status: 'unknown', error: SEND_UNVERIFIABLE });
    // Settled for good: the next read leaves it alone.
    service.at = new Date(service.at.getTime() + UNVERIFIABLE_AFTER_MS);
    expect(await service.status(ALICE, tradeId)).toMatchObject({ status: 'failed' });
  });

  it('keeps the summary through executor writes, so a retry answers the same', async () => {
    const { service, store } = harness();
    const first = await service.prepare(ALICE, intent());
    store.claimForCommit(ALICE.userId, first.tradeId, T0);
    store.update(first.tradeId, { status: 'completed' });
    expect((await service.prepare(ALICE, intent())).summary).toEqual(first.summary);
  });
});

describe('TradeService.perplAccount', () => {
  it('reports no account, the live minimum and an unlinked read key', async () => {
    const { service } = harness();
    expect(await service.perplAccount(ALICE)).toEqual({
      accountId: null,
      forwarding: false,
      minOpenAtoms: '100000000',
      readKey: 'unlinked',
    });
  });

  it('reports an open account, forwarding on only after its own onboarding', async () => {
    const { service, store, readContract } = harness();
    readContract.mockResolvedValue({ accountId: 493n, balanceCNS: 0n, lockedBalanceCNS: 0n });
    expect(await service.perplAccount(ALICE)).toMatchObject({
      accountId: '493',
      forwarding: false,
    });

    const onboard = await service.prepare(ALICE, onboardIntent());
    store.claimForCommit(ALICE.userId, onboard.tradeId, T0);
    store.update(onboard.tradeId, { status: 'completed' });
    expect(await service.perplAccount(ALICE)).toMatchObject({ accountId: '493', forwarding: true });
  });

  it('hands back the trade-key token and reports the read key linked after enrollment', async () => {
    const { service, secrets } = harness();
    await secrets.putPerplTradeToken(ALICE.userId, 'trade-token-1');
    expect(await service.perplAccount(ALICE)).toEqual({
      accountId: null,
      forwarding: false,
      minOpenAtoms: '100000000',
      apiKey: 'trade-token-1',
      readKey: 'unlinked',
    });

    await secrets.putPerplRead(ALICE.userId, {
      apiKey: 'read-token',
      secretKey: new Uint8Array(32).fill(5),
    });
    const linked = await service.perplAccount(ALICE);
    expect(linked).toMatchObject({ apiKey: 'trade-token-1', readKey: 'linked' });
    // The read key itself never leaves the server.
    expect(JSON.stringify(linked)).not.toContain('read-token');
    // Reading the status does not consume the stored key.
    expect(Array.from((await secrets.getPerplRead(ALICE.userId))!.secretKey)).toEqual(
      Array(32).fill(5),
    );
  });

  it("does not report another user's keys", async () => {
    const { service, secrets } = harness();
    await secrets.putPerplTradeToken('someone-else', 'trade-token-2');
    expect(await service.perplAccount(ALICE)).not.toHaveProperty('apiKey');
  });

  it('refuses a user with no wallet and answers 404 with the flag off', async () => {
    expect(await refusal(harness().service.perplAccount(BOB))).toBe('account_not_registered');
    const off = harness({ enabled: false }).service;
    expect(await refusal(off.perplAccount(ALICE))).toBe('trading_disabled');
  });
});

describe('TradeService.capabilities', () => {
  it.each([
    [false, false, { kuru: false, perpl: false }],
    [true, false, { kuru: true, perpl: false }],
    [true, true, { kuru: true, perpl: true }],
  ])('enabled %p, perpl %p gives venues %p', (enabled, perpl, venues) => {
    expect(harness({ enabled, perpl }).service.capabilities().venues).toEqual(venues);
  });
});

describe('trading_disabled', () => {
  it('refuses every service call but capabilities with the flag off', async () => {
    const { service } = harness({ enabled: false });
    expect(service.capabilities()).toEqual({
      enabled: false,
      atomicBatch: false,
      chainId: 10143,
      venues: { kuru: false, perpl: false },
    });
    expect(await refusal(service.prepare(ALICE, intent()))).toBe('trading_disabled');
    expect(await refusal(service.commit(ALICE, 'x', [SIG]))).toBe('trading_disabled');
    expect(await refusal(service.status(ALICE, 'x'))).toBe('trading_disabled');
    expect(await refusal(service.list(ALICE))).toBe('trading_disabled');
  });

  it('the route guard answers 404 trading_disabled before validation runs', () => {
    const guard = new TradingEnabledGuard({
      enabled: false,
      atomicBatch: false,
      perpl: false,
      chainId: 10143,
    });
    let thrown: unknown;
    try {
      guard.canActivate();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(404);
    expect((thrown as HttpException).getResponse()).toMatchObject({ reason: 'trading_disabled' });
    expect(
      new TradingEnabledGuard({
        enabled: true,
        atomicBatch: false,
        perpl: false,
        chainId: 10143,
      }).canActivate(),
    ).toBe(true);
  });
});

describe('TradeIntentDto', () => {
  function errors(body: Record<string, unknown>): string[] {
    return validateSync(plainToInstance(TradeIntentDto, body)).map((e) => e.property);
  }

  it('accepts each Kuru kind with its own fields', () => {
    expect(errors(PLACE)).toEqual([]);
    expect(
      errors({ kind: 'kuru.cancel', clientTradeId: CLIENT_ID, market: MARKET, orderId: '3:17' }),
    ).toEqual([]);
    expect(
      errors({ kind: 'kuru.withdraw', clientTradeId: CLIENT_ID, token: TOKEN, amountAtoms: '1' }),
    ).toEqual([]);
  });

  it('refuses a clientTradeId that is not a UUID v4', () => {
    expect(errors({ ...PLACE, clientTradeId: 'not-a-uuid' })).toEqual(['clientTradeId']);
    // A v1 UUID: well-formed, but not what the phone generates.
    expect(errors({ ...PLACE, clientTradeId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' })).toEqual([
      'clientTradeId',
    ]);
  });

  it("requires the kind's own fields and rejects malformed amounts", () => {
    expect(errors({ kind: 'kuru.place', clientTradeId: CLIENT_ID })).toEqual([
      'market',
      'side',
      'orderType',
      'sizeAtoms',
      'priceUnits',
      'maxDepositAtoms',
    ]);
    expect(errors({ ...PLACE, sizeAtoms: '1.5' })).toEqual(['sizeAtoms']);
    expect(errors({ ...PLACE, priceUnits: '-1' })).toEqual(['priceUnits']);
    expect(
      errors({ kind: 'kuru.cancel', clientTradeId: CLIENT_ID, market: MARKET, orderId: '17' }),
    ).toEqual(['orderId']);
    expect(errors({ ...PLACE, kind: 'kuru.swap' })).toContain('kind');
  });

  it('bounds the signatures of a commit', () => {
    const check = (signatures: unknown) =>
      validateSync(plainToInstance(CommitTradeDto, { signatures })).length;
    expect(check([SIG])).toBe(0);
    expect(check([])).toBe(1);
    expect(check(['not base64!'])).toBe(1);
    expect(check(Array.from({ length: 9 }, () => SIG))).toBe(1);
  });
});
