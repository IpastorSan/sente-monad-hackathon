import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { authConfig, resetAuthConfig } from '../auth/auth.config';
import { Auth, RequestContextAuth, type Principal } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { mintSessionToken } from '../auth/session-token';
import { WalletRefusedError } from '../wallet/wallet.errors';
import type { PreparedTradeDto, TradeCapabilitiesDto, TradeViewDto } from './dto/trade.dto';
import { TRADE_CHAIN_ID, TRADE_CONFIG, type TradeConfig } from './trade.config';
import { TradeController, TradingEnabledGuard } from './trade.controller';
import { TradeRefusedError, TradeService, type TradeRefusalReason } from './trade.service';

/**
 * SEN-135: `/trade` over HTTP, with the real SessionAuthGuard, the real
 * TradingEnabledGuard, the real request-scoped `Auth` and the global
 * ValidationPipe as main.ts configures it — guard ordering, DTO 400s and the
 * refusal mapping only exist there. The service is a fake that records who it
 * was asked for and what; its own behaviour is `trade.service.spec.ts`'s.
 */

const SECRET = 'cd'.repeat(32);
const ORIGINAL = { ...process.env };
const ALICE = '0x' + 'a'.repeat(40);
const BOB = '0x' + 'b'.repeat(40);
const TRADE_ID = '0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
const CLIENT_TRADE_ID = '5b0c8f1e-9a3d-4c2b-8e7f-1a2b3c4d5e6f';

const view = (tradeId = TRADE_ID): TradeViewDto => ({
  tradeId,
  clientTradeId: CLIENT_TRADE_ID,
  kind: 'kuru.withdraw',
  status: 'prepared',
  steps: [],
  updatedAt: '2026-09-27T00:00:00.000Z',
});

/** A well-formed `kuru.withdraw` intent: the smallest body the DTO accepts. */
const withdraw = (over: Record<string, unknown> = {}) => ({
  kind: 'kuru.withdraw',
  clientTradeId: CLIENT_TRADE_ID,
  token: '0x' + '0'.repeat(40),
  amountAtoms: '1000',
  ...over,
});

class FakeTrades {
  calls: unknown[][] = [];
  /** Thrown by the next call, when set. */
  failWith: Error | undefined;

  constructor(private readonly config: TradeConfig) {}

  #record(...args: unknown[]): void {
    this.calls.push(args);
    const error = this.failWith;
    if (error) throw error;
  }

  capabilities(): TradeCapabilitiesDto {
    const { enabled, atomicBatch, chainId } = this.config;
    return {
      enabled,
      atomicBatch,
      chainId,
      venues: { kuru: enabled, perpl: false },
      kuruBuilder: null,
    };
  }
  async prepare(principal: Principal, dto: unknown): Promise<PreparedTradeDto> {
    this.#record('prepare', principal, dto);
    return {
      tradeId: TRADE_ID,
      clientTradeId: CLIENT_TRADE_ID,
      expiresAt: '2026-09-27T00:05:00.000Z',
      wallet: { walletId: 'w', address: ALICE as `0x${string}` },
      steps: [],
      summary: {},
    };
  }
  async commit(principal: Principal, tradeId: string, signatures: string[]) {
    this.#record('commit', principal, tradeId, signatures);
    return view(tradeId);
  }
  async list(principal: Principal, limit?: number) {
    this.#record('list', principal, limit);
    return [view()];
  }
  async status(principal: Principal, tradeId: string) {
    this.#record('status', principal, tradeId);
    return view(tradeId);
  }
}

describe('TradeController over HTTP (SEN-135)', () => {
  let app: INestApplication;
  let fake: FakeTrades;
  let base: string;
  const tokens: Record<string, string> = {};

  async function start(enabled: boolean): Promise<void> {
    const config: TradeConfig = {
      enabled,
      atomicBatch: false,
      perpl: false,
      chainId: TRADE_CHAIN_ID,
    };
    fake = new FakeTrades(config);
    const moduleRef = await Test.createTestingModule({
      controllers: [TradeController],
      providers: [
        { provide: TradeService, useValue: fake },
        { provide: TRADE_CONFIG, useValue: config },
        { provide: Auth, useClass: RequestContextAuth },
        SessionAuthGuard,
        TradingEnabledGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  }

  beforeEach(() => {
    process.env['AUTH_SESSION_SECRET'] = SECRET;
    delete process.env['AUTH_PLACEHOLDER'];
    resetAuthConfig();
    const exp = Math.floor(Date.now() / 1000) + 600;
    for (const sub of [ALICE, BOB]) {
      tokens[sub] = mintSessionToken(authConfig().sessionSecret, { sub, exp });
    }
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...ORIGINAL };
    resetAuthConfig();
  });

  async function call(
    method: 'GET' | 'POST',
    path: string,
    { body, as = ALICE }: { body?: unknown; as?: string | null } = {},
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (as) headers['authorization'] = `Bearer ${tokens[as]}`;
    const response = await fetch(new URL(path, base), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }

  describe('with USER_TRADING off', () => {
    beforeEach(() => start(false));

    // Kills: dropping `@UseGuards(TradingEnabledGuard)` from any route (the
    // pipe answers first with a 400 that describes the route), or turning the
    // guard's refusal into anything but 404 `trading_disabled`.
    it('answers 404 trading_disabled on every gated route, even for a malformed request', async () => {
      const disabled = {
        status: 404,
        body: expect.objectContaining({ statusCode: 404, reason: 'trading_disabled' }),
      };
      expect(await call('POST', '/trade/prepare', { body: { kind: 'nope' } })).toEqual(disabled);
      expect(await call('POST', '/trade/prepare', { body: withdraw() })).toEqual(disabled);
      expect(await call('POST', '/trade/not-a-uuid/commit', { body: { signatures: 7 } })).toEqual(
        disabled,
      );
      expect(await call('GET', '/trade?limit=1000')).toEqual(disabled);
      expect(await call('GET', '/trade/not-a-uuid')).toEqual(disabled);
      expect(await call('GET', `/trade/${TRADE_ID}`)).toEqual(disabled);
      expect(fake.calls).toEqual([]);
    });

    // Kills: gating `capabilities` too — the app could never learn the flag is off.
    it('still answers capabilities, all false', async () => {
      expect(await call('GET', '/trade/capabilities')).toEqual({
        status: 200,
        body: {
          enabled: false,
          atomicBatch: false,
          chainId: TRADE_CHAIN_ID,
          venues: { kuru: false, perpl: false },
          kuruBuilder: null,
        },
      });
    });
  });

  describe('with USER_TRADING on', () => {
    beforeEach(() => start(true));

    // Kills: removing the controller-level `@UseGuards(SessionAuthGuard)`
    // (`Auth` would then 401 only after validation, and capabilities would be open).
    it('answers 401 without a session, on every route, before the service', async () => {
      for (const [method, path, body] of [
        ['GET', '/trade/capabilities', undefined],
        ['POST', '/trade/prepare', withdraw()],
        ['POST', `/trade/${TRADE_ID}/commit`, { signatures: ['AAAA'] }],
        ['GET', '/trade', undefined],
        ['GET', `/trade/${TRADE_ID}`, undefined],
      ] as const) {
        expect(await call(method, path, { body, as: null })).toMatchObject({ status: 401 });
      }
      expect(fake.calls).toEqual([]);
    });

    // Kills: `capabilities` being shadowed by `:tradeId` (declared after it).
    it('routes capabilities before :tradeId', async () => {
      expect(await call('GET', '/trade/capabilities')).toMatchObject({
        status: 200,
        body: { enabled: true, venues: { kuru: true } },
      });
      expect(fake.calls).toEqual([]);
    });

    // Kills: losing `whitelist`/`forbidNonWhitelisted` on any DTO, or a
    // validator (uuid v4, base64, bounds) drifting — each would reach the service.
    it('rejects malformed requests with 400 before the service', async () => {
      for (const [method, path, body] of [
        ['POST', '/trade/prepare', withdraw({ kind: 'kuru.lend' })],
        ['POST', '/trade/prepare', withdraw({ clientTradeId: 'not-a-uuid' })],
        ['POST', '/trade/prepare', withdraw({ amountAtoms: '1.5' })],
        ['POST', '/trade/prepare', withdraw({ extra: true })],
        ['POST', '/trade/not-a-uuid/commit', { signatures: ['AAAA'] }],
        ['POST', `/trade/${TRADE_ID}/commit`, { signatures: [] }],
        ['POST', `/trade/${TRADE_ID}/commit`, { signatures: ['not base64!'] }],
        ['POST', `/trade/${TRADE_ID}/commit`, { signatures: Array(9).fill('AAAA') }],
        ['GET', '/trade?limit=0', undefined],
        ['GET', '/trade?limit=101', undefined],
        ['GET', '/trade/not-a-uuid', undefined],
      ] as const) {
        const res = await call(method, path, { body });
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 400 });
      }
      expect(fake.calls).toEqual([]);
    });

    // Kills: the controller reading identity from anywhere but the session —
    // a smuggled `userId` must be a 400, never a different principal.
    it('refuses a body or query that names a user', async () => {
      expect(
        await call('POST', '/trade/prepare', { body: withdraw({ userId: BOB }) }),
      ).toMatchObject({ status: 400 });
      expect(
        await call('POST', `/trade/${TRADE_ID}/commit`, {
          body: { signatures: ['AAAA'], userId: BOB },
        }),
      ).toMatchObject({ status: 400 });
      expect(await call('GET', `/trade?userId=${BOB}`)).toMatchObject({ status: 400 });
      expect(fake.calls).toEqual([]);
    });

    // Kills: a principal from anything other than this request's session
    // (a cached/singleton Auth, a hard-coded subject), and the DTO transform
    // not reaching the service (limit as a string).
    it('passes each caller its own session subject and nothing else', async () => {
      expect(await call('POST', '/trade/prepare', { body: withdraw(), as: ALICE })).toMatchObject({
        status: 200,
        body: { tradeId: TRADE_ID },
      });
      expect(
        await call('POST', `/trade/${TRADE_ID}/commit`, {
          body: { signatures: ['AAAA'] },
          as: BOB,
        }),
      ).toMatchObject({ status: 200 });
      expect(await call('GET', '/trade?limit=5', { as: ALICE })).toMatchObject({ status: 200 });
      expect(await call('GET', `/trade/${TRADE_ID}`, { as: BOB })).toMatchObject({ status: 200 });

      expect(fake.calls).toEqual([
        ['prepare', { userId: ALICE }, expect.objectContaining(withdraw())],
        ['commit', { userId: BOB }, TRADE_ID, ['AAAA']],
        ['list', { userId: ALICE }, 5],
        ['status', { userId: BOB }, TRADE_ID],
      ]);
    });

    // Kills: the controller not wrapping the service in
    // `tradeRefusalToHttpException` (every refusal a 500), and any status in
    // REFUSAL_STATUS drifting — the app branches on status and reason.
    it.each<[TradeRefusalReason, number]>([
      ['not_supported_yet', 400],
      ['signature_count_mismatch', 400],
      ['invalid_intent', 400],
      ['market_not_allowed', 400],
      ['trade_not_found', 404],
      ['trade_id_conflict', 409],
      ['already_terminal', 409],
      ['trade_expired', 410],
      ['below_min_notional', 422],
      ['reserve_balance', 422],
      ['deposit_cap_exceeded', 422],
      ['insufficient_balance', 422],
    ])('maps %s to %i over the wire', async (reason, status) => {
      fake.failWith = new TradeRefusedError(reason, `refused: ${reason}`);
      expect(await call('POST', '/trade/prepare', { body: withdraw() })).toEqual({
        status,
        body: { statusCode: status, reason, message: `refused: ${reason}` },
      });
    });

    // Kills: every route but one losing the refusal mapping.
    it('maps refusals on commit, list and status too', async () => {
      fake.failWith = new TradeRefusedError('trade_expired', 'gone');
      expect(
        await call('POST', `/trade/${TRADE_ID}/commit`, { body: { signatures: ['AAAA'] } }),
      ).toMatchObject({ status: 410, body: { reason: 'trade_expired' } });
      fake.failWith = new TradeRefusedError('trade_not_found', 'none');
      expect(await call('GET', `/trade/${TRADE_ID}`)).toMatchObject({
        status: 404,
        body: { reason: 'trade_not_found' },
      });
      fake.failWith = new WalletRefusedError('account_not_registered', 'no wallet');
      expect(await call('GET', '/trade')).toMatchObject({
        status: 404,
        body: { reason: 'account_not_registered' },
      });
    });

    // Kills: the mapper swallowing unknown errors into a refusal the app would act on.
    it('leaves an unexpected error a 500 without a reason', async () => {
      fake.failWith = new Error('boom');
      const res = await call('GET', `/trade/${TRADE_ID}`);
      expect(res.status).toBe(500);
      expect(res.body).not.toHaveProperty('reason');
    });
  });
});
