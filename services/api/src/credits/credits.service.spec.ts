import { CREDITS_DEFAULTS, loadCreditsConfig, type CreditsConfig } from './credits.config';
import { CreditsRefusedError } from './credits.errors';
import { createOpenRouterKeys, CreditsService, nextResetUtc } from './credits.service';
import {
  InMemoryCreditKeyStore,
  type CreditKeyClaim,
  type CreditKeyRecord,
  type CreditKeyStore,
} from './store/credit-key-store';
import { FAKE_MANAGEMENT_KEY, fakeOpenRouter } from './testing/fake-openrouter';

const USER = { userId: 'user-1' };

const configured: CreditsConfig = { managementKey: FAKE_MANAGEMENT_KEY, defaultLimitUsd: 5 };

function setup(
  options: { config?: CreditsConfig; store?: CreditKeyStore; failCreate?: number } = {},
) {
  const fake = fakeOpenRouter({ failCreate: options.failCreate });
  const config = options.config ?? configured;
  const store = options.store ?? new InMemoryCreditKeyStore();
  const service = new CreditsService(config, createOpenRouterKeys(config, fake.fetch), store);
  return { fake, store, service };
}

const creates = (fake: ReturnType<typeof fakeOpenRouter>) =>
  fake.calls.filter((call) => call.method === 'POST');

async function refusal(promise: Promise<unknown>): Promise<CreditsRefusedError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CreditsRefusedError);
  return error as CreditsRefusedError;
}

describe('CreditsService.provision', () => {
  it('mints a key with the default limit, a monthly reset, BYOK counted, and the user attributed', async () => {
    const { fake, service } = setup();

    const result = await service.provision(USER);

    expect(result).toEqual({
      created: true,
      limitUsd: 5,
      remainingUsd: 5,
      usageMonthUsd: 0,
      resetsAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/),
    });
    expect(creates(fake)[0]?.body).toEqual({
      name: 'sente:user-1',
      limit: 5,
      limit_reset: 'monthly',
      include_byok_in_limit: true,
      external: { user: 'user-1' },
    });
  });

  it('is idempotent: a second call reports the first key and mints nothing', async () => {
    const { fake, service } = setup();

    await service.provision(USER);
    const again = await service.provision(USER);

    expect(again.created).toBe(false);
    expect(creates(fake)).toHaveLength(1);
    expect(fake.keys.size).toBe(1);
  });

  it('shares one mint between concurrent calls for the same user', async () => {
    const { fake, service } = setup();

    const results = await Promise.all([service.provision(USER), service.provision(USER)]);

    expect(creates(fake)).toHaveLength(1);
    expect(results.map((result) => result.created)).toEqual([true, true]);
  });

  it('keeps separate users separate', async () => {
    const { fake, service } = setup();

    await service.provision(USER);
    await service.provision({ userId: 'user-2' });

    expect(fake.keys.size).toBe(2);
    expect(await service.keyFor('user-1')).not.toBe(await service.keyFor('user-2'));
  });

  it('when another replica wins the store race, deletes its own key and reports the winner', async () => {
    const winner: CreditKeyRecord = {
      userId: USER.userId,
      hash: 'hash-winner',
      key: 'sk-or-v1-WINNER',
      createdAt: new Date(),
    };
    // find() says "nobody yet", but by the time we claim, someone has.
    const racingStore: CreditKeyStore = {
      find: () => Promise.resolve(undefined),
      claim: (): Promise<CreditKeyClaim> => Promise.resolve({ ok: false, existing: winner }),
    };
    const { fake, service } = setup({ store: racingStore });
    // The winner's key exists upstream too.
    fake.keys.set('hash-winner', { ...structuredClone(minted()), hash: 'hash-winner' });

    const result = await service.provision(USER);

    expect(result.created).toBe(false);
    expect(fake.keys.has('hash1')).toBe(false);
    expect(fake.keys.has('hash-winner')).toBe(true);
    expect(fake.calls.map((call) => call.method)).toEqual(['POST', 'DELETE', 'GET']);
  });

  it('refuses with provision_failed when OpenRouter will not mint, and stores nothing', async () => {
    const { store, service } = setup({ failCreate: 500 });

    const error = await refusal(service.provision(USER));

    expect(error.reason).toBe('provision_failed');
    expect(error.message).toContain('HTTP 500 upstream sad');
    expect(await store.find(USER.userId)).toBeUndefined();
  });
});

describe('CreditsService.status', () => {
  it('maps limit, remaining, monthly usage and the next monthly reset', async () => {
    const { fake, service } = setup();
    await service.provision(USER);
    fake.spend('hash1', 1.25);

    const view = await service.status(USER, new Date('2026-09-11T12:00:00Z'));

    expect(view).toEqual({
      limitUsd: 5,
      remainingUsd: 3.75,
      usageMonthUsd: 1.25,
      resetsAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('refuses with not_provisioned before the first provision', async () => {
    const { fake, service } = setup();

    expect((await refusal(service.status(USER))).reason).toBe('not_provisioned');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses with status_unavailable when the key cannot be read', async () => {
    const { fake, service } = setup();
    await service.provision(USER);
    fake.keys.clear();

    expect((await refusal(service.status(USER))).reason).toBe('status_unavailable');
  });
});

describe('CreditsService.keyFor', () => {
  it('hands the server the plaintext key the user was minted', async () => {
    const { service } = setup();
    await service.provision(USER);

    expect(await service.keyFor(USER.userId)).toBe('sk-or-v1-PLAINTEXT-1');
  });

  it('refuses with not_provisioned for an unknown user', async () => {
    const { service } = setup();

    expect((await refusal(service.keyFor('nobody'))).reason).toBe('not_provisioned');
  });
});

describe('an unconfigured server', () => {
  const unconfigured = loadCreditsConfig({});

  it('refuses provision and status with credits_unconfigured and never calls OpenRouter', async () => {
    const { fake, service } = setup({ config: unconfigured });

    expect((await refusal(service.provision(USER))).reason).toBe('credits_unconfigured');
    const store = new InMemoryCreditKeyStore();
    await store.claim({ userId: USER.userId, hash: 'hash1', key: 'sk-or-v1-x' });
    const withRecord = setup({ config: unconfigured, store });
    expect((await refusal(withRecord.service.status(USER))).reason).toBe('credits_unconfigured');
    expect(fake.calls).toHaveLength(0);
    expect(withRecord.fake.calls).toHaveLength(0);
  });
});

describe('loadCreditsConfig', () => {
  it('defaults to a $5 limit and no management key', () => {
    expect(loadCreditsConfig({})).toEqual({
      managementKey: undefined,
      defaultLimitUsd: CREDITS_DEFAULTS.defaultLimitUsd,
    });
  });

  it('reads both variables', () => {
    expect(
      loadCreditsConfig({
        OPENROUTER_MANAGEMENT_KEY: ' sk-or-v1-m ',
        OPENROUTER_DEFAULT_LIMIT_USD: '2.5',
      }),
    ).toEqual({ managementKey: 'sk-or-v1-m', defaultLimitUsd: 2.5 });
  });

  it.each(['0', '-1', 'five', 'Infinity'])('rejects a limit of %s', (raw) => {
    expect(() => loadCreditsConfig({ OPENROUTER_DEFAULT_LIMIT_USD: raw })).toThrow(
      /OPENROUTER_DEFAULT_LIMIT_USD must be a positive number/,
    );
  });
});

describe('nextResetUtc', () => {
  it.each([
    ['monthly', '2026-12-31T23:59:59Z', '2027-01-01T00:00:00.000Z'],
    ['monthly', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00.000Z'],
    ['daily', '2026-09-11T23:00:00Z', '2026-09-12T00:00:00.000Z'],
    // 2026-09-14 is a Monday: the window it opens ends the next Monday.
    ['weekly', '2026-09-14T08:00:00Z', '2026-09-21T00:00:00.000Z'],
    ['weekly', '2026-09-13T08:00:00Z', '2026-09-14T00:00:00.000Z'],
  ] as const)('%s from %s is %s', (reset, now, expected) => {
    expect(nextResetUtc(reset, new Date(now))?.toISOString()).toBe(expected);
  });

  it('is null when the limit never resets', () => {
    expect(nextResetUtc(null, new Date())).toBeNull();
  });
});

function minted() {
  return {
    hash: 'x',
    name: 'sente:user-1',
    label: 'sk-or-v1-WIN...',
    disabled: false,
    limit: 5,
    limit_remaining: 5,
    limit_reset: 'monthly' as const,
    include_byok_in_limit: true,
    usage: 0,
    usage_daily: 0,
    usage_weekly: 0,
    usage_monthly: 0,
    created_at: '2026-09-11T00:00:00Z',
    updated_at: null,
  };
}
