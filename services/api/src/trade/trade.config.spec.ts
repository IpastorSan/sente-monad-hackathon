import { loadTradeConfig } from './trade.config';

describe('loadTradeConfig', () => {
  it('is off by default', () => {
    expect(loadTradeConfig({})).toEqual({ enabled: false, atomicBatch: false, chainId: 10143 });
  });

  it.each(['1', 'true'])('turns trading on for %p', (value) => {
    expect(loadTradeConfig({ USER_TRADING: value }).enabled).toBe(true);
  });

  it.each(['0', 'false', 'yes', 'on', 'TRUE', ''])('leaves trading off for %p', (value) => {
    expect(loadTradeConfig({ USER_TRADING: value }).enabled).toBe(false);
  });

  it('honours atomic batching only when trading is on', () => {
    expect(loadTradeConfig({ USER_TRADE_ATOMIC_BATCH: '1' }).atomicBatch).toBe(false);
    expect(
      loadTradeConfig({ USER_TRADING: '1', USER_TRADE_ATOMIC_BATCH: 'true' }).atomicBatch,
    ).toBe(true);
    expect(loadTradeConfig({ USER_TRADING: '1' }).atomicBatch).toBe(false);
  });
});
