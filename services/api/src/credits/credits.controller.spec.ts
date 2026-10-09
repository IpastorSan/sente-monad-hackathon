import { HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';

import type { AgentRecord, AgentStore } from '../agents/store/agent-store';
import type { RunTranscriptSummary } from '../agents/runner/transcript/run-transcript';
import { InMemoryRunTranscriptStore } from '../agents/runner/transcript/run-transcript-store';
import { Auth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { loadCreditsConfig, type CreditsConfig } from './credits.config';
import { CreditsController } from './credits.controller';
import { CreditsModule } from './credits.module';
import { createOpenRouterKeys, CreditsService } from './credits.service';
import { NoCreditPayments, type CreditPayments } from './purchase/credit-payments';
import { CreditsPurchaseService } from './purchase/credits-purchase.service';
import { InMemoryCreditKeyStore } from './store/credit-key-store';
import { FAKE_MANAGEMENT_KEY, fakeOpenRouter } from './testing/fake-openrouter';
import { CreditsOverviewController } from './usage/credits-overview.controller';

const USER = { userId: 'user-1' };

class FixedAuth extends Auth {
  override principal() {
    return USER;
  }
}

const CONFIGURED: CreditsConfig = {
  managementKey: FAKE_MANAGEMENT_KEY,
  sharedKey: undefined,
  mode: 'per-user',
  defaultLimitUsd: 10,
};

function agentStore(agents: { id: string; name: string; userId?: string }[]): AgentStore {
  return {
    listByUser: (userId: string) =>
      Promise.resolve(
        agents
          .filter((agent) => (agent.userId ?? USER.userId) === userId)
          .map((agent) => ({ ...agent, userId: agent.userId ?? USER.userId }) as AgentRecord),
      ),
  } as unknown as AgentStore;
}

function setup(
  options: {
    config?: CreditsConfig;
    purchasesEnabled?: boolean;
    payments?: CreditPayments;
    agents?: { id: string; name: string; userId?: string }[];
  } = {},
) {
  const config = options.config ?? CONFIGURED;
  const fake = fakeOpenRouter();
  const service = new CreditsService(
    config,
    createOpenRouterKeys(config, fake.fetch),
    new InMemoryCreditKeyStore(),
  );
  const purchases = new CreditsPurchaseService(
    { purchasesEnabled: options.purchasesEnabled ?? false },
    config,
    options.payments ?? new NoCreditPayments(),
  );
  const transcripts = new InMemoryRunTranscriptStore();
  const overview = new CreditsOverviewController(
    service,
    new FixedAuth(),
    config,
    agentStore(options.agents ?? []),
    transcripts,
  );
  return {
    fake,
    service,
    transcripts,
    overview,
    controller: new CreditsController(service, purchases, new FixedAuth()),
  };
}

async function httpError(promise: Promise<unknown>): Promise<HttpException> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
}

const VIEW_FIELDS = ['limitUsd', 'remainingUsd', 'usageMonthUsd', 'resetsAt'];
const OVERVIEW_FIELDS = [
  ...VIEW_FIELDS,
  'tier',
  'provisioned',
  'mode',
  'freeTierUsd',
  'usedUsd',
  'reset',
  'usage',
];

describe('CreditsController', () => {
  it('never puts the plaintext key (or its hash) in a provision or credits response', async () => {
    const { controller: api, overview, service } = setup();

    const first = await api.provision();
    const second = await api.provision();
    const status = await overview.overview();
    const plaintext = await service.keyFor(USER.userId);

    for (const body of [first, second, status]) {
      const wire = JSON.stringify(body);
      expect(wire).not.toContain(plaintext);
      expect(wire).not.toContain('sk-or-');
      expect(wire).not.toContain('hash1');
    }
    expect(Object.keys(first).sort()).toEqual([...VIEW_FIELDS, 'created'].sort());
    expect(Object.keys(status).sort()).toEqual([...OVERVIEW_FIELDS].sort());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it('maps an unconfigured server to 503 credits_unconfigured', async () => {
    const { controller: api, overview } = setup({ config: loadCreditsConfig({}) });

    for (const call of [api.provision(), overview.overview()]) {
      const error = await httpError(call);
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toMatchObject({ reason: 'credits_unconfigured' });
    }
  });

  it('sits behind the session auth guard, like WalletController', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CreditsController)).toEqual([SessionAuthGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, CreditsOverviewController)).toEqual([
      SessionAuthGuard,
    ]);
  });
});

describe('GET /credits', () => {
  const NOW = Date.now();

  function run(agentId: string, n: number, startedAt: number, costUsd?: number) {
    return {
      runId: `run-${agentId}-${n}`,
      agentId,
      trigger: 'schedule' as const,
      model: 'moonshotai/kimi-k2.6',
      startedAt,
      costUsd,
    };
  }

  function record(
    transcripts: InMemoryRunTranscriptStore,
    r: ReturnType<typeof run>,
  ): RunTranscriptSummary {
    transcripts.start(r);
    transcripts.append(r.runId, {
      kind: 'usage',
      turn: 1,
      inputTokens: 1000,
      outputTokens: 200,
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      stopReason: 'end_turn',
    });
    return transcripts.list(r.agentId)[0]!;
  }

  it('before the first run: the untouched free tier, and no key minted', async () => {
    const { overview, fake } = setup();

    const body = await overview.overview();

    expect(body).toMatchObject({
      tier: 'free',
      provisioned: false,
      mode: 'per-user',
      freeTierUsd: 10,
      limitUsd: 10,
      remainingUsd: 10,
      usedUsd: 0,
      reset: { period: null, rollover: false },
      usage: { estimated: true, byAgent: [], recentRuns: [], unattributedUsd: 0 },
    });
    expect(body.reset.resetsAt).toBeNull();
    expect(body.reset.summary).toBe('A one-off allowance: it does not reset.');
    expect(fake.calls).toHaveLength(0);
  });

  it('breaks the meter down by agent and run, and leaves the rest unattributed', async () => {
    const {
      controller: api,
      overview,
      fake,
      transcripts,
    } = setup({
      agents: [
        { id: 'a1', name: 'Night desk' },
        { id: 'a2', name: 'Scalper' },
        { id: 'x', name: 'Someone else’s', userId: 'user-2' },
      ],
    });
    await api.provision();
    fake.spend('hash1', 1);
    record(transcripts, run('a1', 1, NOW - 2_000, 0.25));
    record(transcripts, run('a1', 2, NOW - 1_000, 0.05));
    record(transcripts, run('a2', 1, NOW - 500));
    record(transcripts, run('x', 1, NOW - 100, 0.9));

    const body = await overview.overview();

    expect(body.provisioned).toBe(true);
    expect(body.usedUsd).toBe(1);
    expect(body.remainingUsd).toBe(9);
    expect(body.usage.byAgent.map((a) => [a.name, a.runs, a.costUsd])).toEqual([
      ['Night desk', 2, 0.3],
      ['Scalper', 1, 0],
    ]);
    expect(body.usage.attributedUsd).toBe(0.3);
    expect(body.usage.unattributedUsd).toBe(0.7);
    expect(body.usage.recentRuns.map((r) => [r.runId, r.costUsd])).toEqual([
      ['run-a2-1', null],
      ['run-a1-2', 0.05],
      ['run-a1-1', 0.25],
    ]);
  });
});

describe('plans and purchases', () => {
  it('GET /credits/plans: 10, 20, 50 and custom, with purchases off and the reason', () => {
    const { controller: api } = setup();

    expect(api.plans()).toEqual({
      purchasesEnabled: false,
      note: 'Purchases open after the testnet demo.',
      currency: 'USD',
      freeTier: { usd: 10, reset: null },
      plans: [
        { id: 'pack_10', usd: 10 },
        { id: 'pack_20', usd: 20 },
        { id: 'pack_50', usd: 50 },
        { id: 'custom', usd: null },
      ],
      custom: { minUsd: 5, maxUsd: 500 },
      autoTopUp: { thresholdsUsd: [1, 2, 5], amountsUsd: [10, 20, 50] },
      paymentAssets: ['USDC', 'AUSD'],
    });
  });

  it('with the flag off, every purchase and auto top-up write is 403 purchases_disabled', async () => {
    const payments: CreditPayments = {
      purchase: jest.fn(),
      autoTopUp: jest.fn(),
      setAutoTopUp: jest.fn(),
    };
    const { controller: api } = setup({ payments });

    for (const call of [
      api.purchase({ plan: 'pack_10' }),
      api.purchase({ plan: 'custom', amountUsd: 35 }),
      api.purchase('garbage'),
      api.setAutoTopUp({ enabled: true, thresholdUsd: 2, amountUsd: 20 }),
    ]) {
      const error = await httpError(call);
      expect(error.getStatus()).toBe(403);
      expect(error.getResponse()).toMatchObject({
        reason: 'purchases_disabled',
        message: 'Purchases open after the testnet demo.',
      });
    }
    expect(await api.autoTopUp()).toEqual({ enabled: false, thresholdUsd: null, amountUsd: null });
    expect(payments.purchase).not.toHaveBeenCalled();
    expect(payments.setAutoTopUp).not.toHaveBeenCalled();
  });

  it('with the flag on, a bad body is 400 purchase_invalid and a good one reaches the payment seam', async () => {
    const { controller: api } = setup({ purchasesEnabled: true });

    const invalid = await httpError(api.purchase({ plan: 'custom', amountUsd: 4 }));
    expect(invalid.getStatus()).toBe(400);
    expect(invalid.getResponse()).toMatchObject({ reason: 'purchase_invalid' });

    // No rail is bound: the seam says so rather than pretending to charge.
    const unbound = await httpError(api.purchase({ plan: 'pack_20' }));
    expect(unbound.getStatus()).toBe(501);
    expect(unbound.getResponse()).toMatchObject({ reason: 'payments_unavailable' });
    expect(api.plans()).toMatchObject({ purchasesEnabled: true, note: null });
  });

  it('with the flag on, hands the checked order to the payment seam', async () => {
    const purchase = jest.fn().mockResolvedValue({ plan: 'pack_20', usd: 20, limitUsd: 30 });
    const { controller: api } = setup({
      purchasesEnabled: true,
      payments: { purchase, autoTopUp: jest.fn(), setAutoTopUp: jest.fn() },
    });

    await expect(api.purchase({ plan: 'pack_20' })).resolves.toEqual({
      plan: 'pack_20',
      usd: 20,
      limitUsd: 30,
    });
    expect(purchase).toHaveBeenCalledWith('user-1', { plan: 'pack_20', usd: 20 });
  });
});

describe('CreditsModule', () => {
  it('wires the service from the environment', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CreditsModule] }).compile();

    expect(moduleRef.get(CreditsService)).toBeInstanceOf(CreditsService);
    expect(moduleRef.get(CreditsPurchaseService).plans().purchasesEnabled).toBe(false);
    await moduleRef.close();
  });
});
