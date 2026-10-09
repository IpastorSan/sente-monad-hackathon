import { CREDITS_DEFAULTS, loadCreditsConfig, type CreditsConfig } from './credits.config';
import { CreditsRefusedError } from './credits.errors';
import {
  createOpenRouterKeys,
  createSharedKey,
  CreditsService,
  nextResetUtc,
} from './credits.service';
import type { LimitReset } from './openrouter.client';
import {
  InMemoryCreditKeyStore,
  type CreditKeyClaim,
  type CreditKeyRecord,
  type CreditKeyStore,
} from './store/credit-key-store';
import { FAKE_MANAGEMENT_KEY, FAKE_SHARED_KEY, fakeOpenRouter } from './testing/fake-openrouter';

const USER = { userId: 'user-1' };

const configured: CreditsConfig = {
  managementKey: FAKE_MANAGEMENT_KEY,
  sharedKey: undefined,
  mode: 'per-user',
  defaultLimitUsd: 5,
};

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
  it('mints a key with the default limit, a one-off reset, BYOK counted, and the user attributed', async () => {
    const { fake, service } = setup();

    const result = await service.provision(USER);

    expect(result).toEqual({
      created: true,
      limitUsd: 5,
      remainingUsd: 5,
      usageMonthUsd: 0,
      resetsAt: null,
    });
    expect(creates(fake)[0]?.body).toEqual({
      name: 'sente:user-1',
      limit: 5,
      limit_reset: null,
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
  it('maps limit, remaining and usage, with no reset for the one-off free tier', async () => {
    const { fake, service } = setup();
    await service.provision(USER);
    fake.spend('hash1', 1.25);

    const view = await service.status(USER, new Date('2026-09-11T12:00:00Z'));

    expect(view).toEqual({
      limitUsd: 5,
      remainingUsd: 3.75,
      usageMonthUsd: 1.25,
      resetsAt: null,
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

describe('the free tier raise and one-off conversion (SEN-183)', () => {
  const tenDollars: CreditsConfig = { ...configured, defaultLimitUsd: 10 };

  /**
   * A user minted under the old $5 default, back when the free tier still
   * reset monthly, now read by a server whose default is $10 and whose free
   * tier is one-off. Provisioning itself always mints with a null reset
   * today, so the legacy monthly reset is applied by hand afterwards to
   * simulate a key that predates that change.
   */
  async function legacyUser(options: { failUpdate?: number } = {}) {
    const fake = fakeOpenRouter({ failUpdate: options.failUpdate });
    const store = new InMemoryCreditKeyStore();
    const old = new CreditsService(configured, createOpenRouterKeys(configured, fake.fetch), store);
    await old.provision(USER);
    Object.assign(fake.keys.get('hash1')!, { limit_reset: 'monthly' });
    fake.spend('hash1', 1.25);
    const service = new CreditsService(
      tenDollars,
      createOpenRouterKeys(tenDollars, fake.fetch),
      store,
    );
    return { fake, service };
  }

  const patches = (fake: ReturnType<typeof fakeOpenRouter>) =>
    fake.calls.filter((call) => call.method === 'PATCH');

  /** Provisions a single $10-default user, then overrides hash1's limit/reset before reading it. */
  async function raiseWithOverride(overrides: { limit?: number | null; limit_reset?: LimitReset }) {
    const fake = fakeOpenRouter();
    const store = new InMemoryCreditKeyStore();
    const service = new CreditsService(
      tenDollars,
      createOpenRouterKeys(tenDollars, fake.fetch),
      store,
    );
    await service.provision(USER);
    Object.assign(fake.keys.get('hash1')!, overrides);

    const view = await service.status(USER);

    return { limitUsd: view.limitUsd, patchBodies: patches(fake).map((call) => call.body) };
  }

  it('raises a key below the free tier and converts its reset, keeping what was spent', async () => {
    const { fake, service } = await legacyUser();

    const view = await service.status(USER, new Date('2026-10-09T12:00:00Z'));

    expect(view).toEqual({
      limitUsd: 10,
      remainingUsd: 8.75,
      usageMonthUsd: 1.25,
      resetsAt: null,
    });
    expect(patches(fake).map((call) => call.body)).toEqual([{ limit: 10, limit_reset: null }]);
  });

  it('is idempotent: once raised, later reads (and provisions) never PATCH again', async () => {
    const { fake, service } = await legacyUser();

    await service.status(USER);
    await service.status(USER);
    await service.provision(USER);
    await service.standing(USER);

    expect(patches(fake)).toHaveLength(1);
  });

  it('converts a legacy monthly key to one-off without lowering a limit already above target', async () => {
    const { limitUsd, patchBodies } = await raiseWithOverride({
      limit: 25,
      limit_reset: 'monthly',
    });

    expect(limitUsd).toBe(25);
    expect(patchBodies).toEqual([{ limit: 25, limit_reset: null }]);
  });

  it('raises any of our enabled keys below the target, whatever their reset, converting it too', async () => {
    const { limitUsd, patchBodies } = await raiseWithOverride({ limit: 5, limit_reset: 'weekly' });

    expect(limitUsd).toBe(10);
    expect(patchBodies).toEqual([{ limit: 10, limit_reset: null }]);
  });

  it('never lowers a key above target, and leaves one that is not ours, odd-reset-but-funded, or disabled alone', async () => {
    const fake = fakeOpenRouter();
    const store = new InMemoryCreditKeyStore();
    const service = new CreditsService(
      tenDollars,
      createOpenRouterKeys(tenDollars, fake.fetch),
      store,
    );
    const users = ['rich', 'foreign', 'weekly', 'off'].map((userId) => ({ userId }));
    for (const user of users) await service.provision(user);
    Object.assign(fake.keys.get('hash1')!, { limit: 25 });
    Object.assign(fake.keys.get('hash2')!, { limit: 5, name: 'handmade' });
    Object.assign(fake.keys.get('hash3')!, { limit: 25, limit_reset: 'weekly' });
    Object.assign(fake.keys.get('hash4')!, { limit: 5, disabled: true });

    for (const user of users) await service.status(user);

    expect(patches(fake)).toHaveLength(0);
  });

  it('answers with the key as it is when the raise fails, and does not retry it', async () => {
    const { fake, service } = await legacyUser({ failUpdate: 500 });

    const first = await service.status(USER);
    await service.status(USER);

    expect(first.limitUsd).toBe(5);
    expect(patches(fake)).toHaveLength(1);
  });
});

describe('CreditsService.standing', () => {
  it('without a key: the free tier untouched, nothing minted', async () => {
    const { fake, service } = setup({ config: { ...configured, defaultLimitUsd: 10 } });

    expect(await service.standing(USER, new Date('2026-10-09T12:00:00Z'))).toEqual({
      provisioned: false,
      mode: 'per-user',
      limitReset: null,
      view: {
        limitUsd: 10,
        remainingUsd: 10,
        usageMonthUsd: 0,
        resetsAt: null,
      },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('with a key: the key, and the reset OpenRouter reports for it', async () => {
    const { service } = setup();
    await service.provision(USER);

    expect(await service.standing(USER)).toMatchObject({
      provisioned: true,
      mode: 'per-user',
      limitReset: null,
      view: { limitUsd: 5 },
    });
  });

  it('unconfigured: refuses with credits_unconfigured', async () => {
    const { service } = setup({ config: loadCreditsConfig({}) });

    expect((await refusal(service.standing(USER))).reason).toBe('credits_unconfigured');
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
  it('defaults to the $10 free tier and no management key', () => {
    expect(loadCreditsConfig({})).toEqual({
      managementKey: undefined,
      sharedKey: undefined,
      mode: 'unconfigured',
      defaultLimitUsd: CREDITS_DEFAULTS.defaultLimitUsd,
    });
  });

  it('reads both variables', () => {
    expect(
      loadCreditsConfig({
        OPENROUTER_MANAGEMENT_KEY: ' sk-or-v1-m ',
        OPENROUTER_DEFAULT_LIMIT_USD: '2.5',
      }),
    ).toEqual({
      managementKey: 'sk-or-v1-m',
      sharedKey: undefined,
      mode: 'per-user',
      defaultLimitUsd: 2.5,
    });
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
    limit_reset: null,
    include_byok_in_limit: true,
    usage: 0,
    usage_daily: 0,
    usage_weekly: 0,
    usage_monthly: 0,
    created_at: '2026-09-11T00:00:00Z',
    updated_at: null,
  };
}

describe('shared-key dev mode (SEN-18)', () => {
  const shared = loadCreditsConfig({ OPENROUTER_API_KEY: ` ${FAKE_SHARED_KEY} ` });

  function sharedSetup(options: { failCurrentKey?: number } = {}) {
    const fake = fakeOpenRouter({ failCurrentKey: options.failCurrentKey });
    const store = new InMemoryCreditKeyStore();
    const service = new CreditsService(
      shared,
      createOpenRouterKeys(shared, fake.fetch),
      store,
      createSharedKey(shared, fake.fetch),
    );
    return { fake, store, service };
  }

  const paths = (fake: ReturnType<typeof fakeOpenRouter>) =>
    fake.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);

  it('resolves from OPENROUTER_API_KEY alone, trimmed', () => {
    expect(shared).toEqual({
      managementKey: undefined,
      sharedKey: FAKE_SHARED_KEY,
      mode: 'shared',
      defaultLimitUsd: CREDITS_DEFAULTS.defaultLimitUsd,
    });
  });

  it('prefers per-user mode when both keys are set', () => {
    const both = loadCreditsConfig({
      OPENROUTER_MANAGEMENT_KEY: FAKE_MANAGEMENT_KEY,
      OPENROUTER_API_KEY: FAKE_SHARED_KEY,
    });
    expect(both.mode).toBe('per-user');
  });

  it('refuses to boot in production', () => {
    expect(() =>
      loadCreditsConfig({ OPENROUTER_API_KEY: FAKE_SHARED_KEY, NODE_ENV: 'production' }),
    ).toThrow(/dev-only/);
  });

  it('hands every user the shared key, and never mints or stores one', async () => {
    const { fake, store, service } = sharedSetup();

    expect(await service.keyFor('user-1')).toBe(FAKE_SHARED_KEY);
    expect(await service.keyFor('user-2')).toBe(FAKE_SHARED_KEY);
    expect(creates(fake)).toHaveLength(0);
    expect(await store.find('user-1')).toBeUndefined();
  });

  it('provision and status read GET /key, never /keys, and never expose the key', async () => {
    const { fake, service } = sharedSetup();
    fake.spendShared(1.25);

    const provisioned = await service.provision(USER);
    const status = await service.status(USER);

    expect(provisioned).toEqual({
      limitUsd: 10,
      remainingUsd: 8.75,
      usageMonthUsd: 1.25,
      resetsAt: null,
      created: false,
    });
    expect(status).toEqual({
      limitUsd: 10,
      remainingUsd: 8.75,
      usageMonthUsd: 1.25,
      resetsAt: null,
    });
    expect(paths(fake)).toEqual(['GET /api/v1/key', 'GET /api/v1/key']);
    expect(JSON.stringify([provisioned, status])).not.toContain(FAKE_SHARED_KEY);
  });

  it('standing says the numbers are the shared key’s', async () => {
    const { service } = sharedSetup();

    expect(await service.standing(USER)).toMatchObject({
      provisioned: true,
      mode: 'shared',
      limitReset: null,
      view: { limitUsd: 10 },
    });
  });

  it('maps a failing GET /key to status_unavailable', async () => {
    const { service } = sharedSetup({ failCurrentKey: 500 });

    expect((await refusal(service.status(USER))).reason).toBe('status_unavailable');
    expect((await refusal(service.provision(USER))).reason).toBe('status_unavailable');
  });
});
