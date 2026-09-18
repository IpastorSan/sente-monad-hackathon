import { HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';

import { Auth } from '../auth/principal';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { loadCreditsConfig, type CreditsConfig } from './credits.config';
import { CreditsController } from './credits.controller';
import { CreditsModule } from './credits.module';
import { createOpenRouterKeys, CreditsService } from './credits.service';
import { InMemoryCreditKeyStore } from './store/credit-key-store';
import { FAKE_MANAGEMENT_KEY, fakeOpenRouter } from './testing/fake-openrouter';

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
  defaultLimitUsd: 5,
};

function setup(config: CreditsConfig = CONFIGURED) {
  const fake = fakeOpenRouter();
  const service = new CreditsService(
    config,
    createOpenRouterKeys(config, fake.fetch),
    new InMemoryCreditKeyStore(),
  );
  return { fake, service, controller: new CreditsController(service, new FixedAuth()) };
}

const RESPONSE_FIELDS = ['limitUsd', 'remainingUsd', 'usageMonthUsd', 'resetsAt'];

describe('CreditsController', () => {
  it('never puts the plaintext key (or its hash) in a provision or status response', async () => {
    const { controller: api, service } = setup();

    const first = await api.provision();
    const second = await api.provision();
    const status = await api.status();
    const plaintext = await service.keyFor(USER.userId);

    for (const body of [first, second, status]) {
      const wire = JSON.stringify(body);
      expect(wire).not.toContain(plaintext);
      expect(wire).not.toContain('sk-or-');
      expect(wire).not.toContain('hash1');
    }
    expect(Object.keys(first).sort()).toEqual([...RESPONSE_FIELDS, 'created'].sort());
    expect(Object.keys(status).sort()).toEqual([...RESPONSE_FIELDS].sort());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it('maps an unconfigured server to 503 credits_unconfigured', async () => {
    const { controller: api } = setup(loadCreditsConfig({}));

    const error = await api.provision().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect((error as HttpException).getResponse()).toMatchObject({
      reason: 'credits_unconfigured',
    });
  });

  it('maps a missing key to 404 not_provisioned', async () => {
    const { controller: api } = setup();

    const error = (await api.status().catch((caught: unknown) => caught)) as HttpException;

    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toMatchObject({ reason: 'not_provisioned' });
  });

  it('sits behind the session auth guard, like WalletController', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CreditsController)).toEqual([SessionAuthGuard]);
  });
});

describe('CreditsModule', () => {
  it('wires the service from the environment', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CreditsModule] }).compile();

    expect(moduleRef.get(CreditsService)).toBeInstanceOf(CreditsService);
    await moduleRef.close();
  });
});
