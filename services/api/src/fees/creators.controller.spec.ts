/** `GET /creators/me/fees` over HTTP (SEN-184), with the real session guard. */
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { authConfig, resetAuthConfig } from '../auth/auth.config';
import { Auth, RequestContextAuth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { mintSessionToken } from '../auth/session-token';
import { CREATOR_FEES, CreatorFeeLedger } from './creator-fees';
import { CreatorsController } from './creators.controller';

const SECRET = 'ef'.repeat(32);
const ORIGINAL = { ...process.env };
const CREATOR = '0x' + 'a'.repeat(40);
const FORKER = '0x' + 'b'.repeat(40);
const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

describe('CreatorsController (SEN-184)', () => {
  let app: INestApplication;
  let base: string;
  let ledger: CreatorFeeLedger;

  beforeEach(async () => {
    process.env['AUTH_SESSION_SECRET'] = SECRET;
    delete process.env['AUTH_PLACEHOLDER'];
    resetAuthConfig();
    ledger = new CreatorFeeLedger();
    const moduleRef = await Test.createTestingModule({
      controllers: [CreatorsController],
      providers: [
        { provide: CREATOR_FEES, useValue: ledger },
        SessionAuthGuard,
        { provide: Auth, useClass: RequestContextAuth },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...ORIGINAL };
    resetAuthConfig();
  });

  async function get(who: string | null): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {};
    if (who !== null) {
      headers['authorization'] = `Bearer ${mintSessionToken(authConfig().sessionSecret, {
        sub: who,
        exp: Math.floor(Date.now() / 1000) + 600,
      })}`;
    }
    const response = await fetch(new URL('/creators/me/fees', base), { headers });
    return { status: response.status, body: await response.json() };
  }

  it('answers 401 without a session', async () => {
    expect((await get(null)).status).toBe(401);
  });

  it('starts empty', async () => {
    expect(await get(CREATOR)).toEqual({
      status: 200,
      body: { share: '0.3', totals: [], recent: [] },
    });
  });

  it('reports the caller’s owed, paid and recent entries, in decimals, and nobody else’s', async () => {
    ledger.accrue({
      creatorUserId: CREATOR,
      agentId: 'fork',
      sourceAgentId: 'source',
      asset: 'USDC',
      decimals: 6,
      feeAtoms: 35_000n,
      txHash: TX(1),
      at: new Date('2026-10-09T10:00:00Z'),
    });
    ledger.payout({
      creatorUserId: CREATOR,
      asset: 'USDC',
      decimals: 6,
      amountAtoms: 10_000n,
      txHash: TX(2),
      at: new Date('2026-10-09T11:00:00Z'),
    });

    expect((await get(CREATOR)).body).toEqual({
      share: '0.3',
      totals: [{ asset: 'USDC', accrued: '0.0105', paid: '0.01', owed: '0.0005' }],
      recent: [
        {
          kind: 'payout',
          asset: 'USDC',
          amount: '0.01',
          txHash: TX(2),
          at: '2026-10-09T11:00:00.000Z',
        },
        {
          kind: 'accrued',
          asset: 'USDC',
          amount: '0.0105',
          fee: '0.035',
          agentId: 'fork',
          sourceAgentId: 'source',
          txHash: TX(1),
          at: '2026-10-09T10:00:00.000Z',
        },
      ],
    });
    expect((await get(FORKER)).body).toEqual({ share: '0.3', totals: [], recent: [] });
  });
});
