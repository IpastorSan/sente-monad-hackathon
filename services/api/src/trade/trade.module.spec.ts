import { Test } from '@nestjs/testing';

import { StepExecutor } from './step-executor';
import { TRADE_CONFIG, type TradeConfig } from './trade.config';
import { TradeModule } from './trade.module';
import { TradeStore } from './trade-store';

describe('TradeModule', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('boots with the flag off and wires one store and executor', async () => {
    delete process.env.USER_TRADING;
    delete process.env.USER_TRADE_ATOMIC_BATCH;
    delete process.env.USER_TRADING_PERPL;
    const moduleRef = await Test.createTestingModule({ imports: [TradeModule] }).compile();

    expect(moduleRef.get<TradeConfig>(TRADE_CONFIG)).toEqual({
      enabled: false,
      atomicBatch: false,
      perpl: false,
      chainId: 10143,
    });
    expect(moduleRef.get(TradeStore)).toBeInstanceOf(TradeStore);
    expect(moduleRef.get(StepExecutor)).toBeInstanceOf(StepExecutor);
    await moduleRef.close();
  });
});
