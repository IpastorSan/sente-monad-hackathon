import { loadTradeConfig } from './trade.config';

describe('loadTradeConfig', () => {
  it('is off by default', () => {
    expect(loadTradeConfig({})).toEqual({
      enabled: false,
      atomicBatch: false,
      perpl: false,
      chainId: 10143,
      kuruBuilder: null,
    });
  });

  it('reads the Sente builder fee whether or not trading is on (agents pay it too)', () => {
    expect(
      loadTradeConfig({ KURU_BUILDER_ADDRESS: '0x93e6b8d57dca7b72fae80adaa5c9d7308f7e33b8' })
        .kuruBuilder,
    ).toEqual({ address: '0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8', feePps: 10_000 });
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

  it.each([
    [undefined, undefined, false],
    [undefined, '1', false],
    ['1', undefined, false],
    ['1', 'yes', false],
    ['1', '1', true],
    ['true', 'true', true],
  ])('USER_TRADING=%p USER_TRADING_PERPL=%p gives perpl %p', (trading, perpl, expected) => {
    expect(loadTradeConfig({ USER_TRADING: trading, USER_TRADING_PERPL: perpl }).perpl).toBe(
      expected,
    );
  });
});
