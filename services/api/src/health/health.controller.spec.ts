import { Test } from '@nestjs/testing';

import { HealthController } from './health.controller';
import { HealthModule } from './health.module';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();
    controller = moduleRef.get(HealthController);
  });

  it('resolves through the DI container', () => {
    expect(controller).toBeInstanceOf(HealthController);
  });

  it('reports ok', () => {
    expect(controller.check()).toEqual({ status: 'ok' });
  });
});
