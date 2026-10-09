import { describeKuruBuilder, feePpsToBps, loadKuruBuilderConfig } from './kuru-builder.config';

const TREASURY = '0x93e6b8d57DCa7B72fAe80ADAa5c9D7308f7E33b8';

describe('loadKuruBuilderConfig', () => {
  it('is off without an address, whatever the rate says', () => {
    expect(loadKuruBuilderConfig({})).toBeNull();
    expect(
      loadKuruBuilderConfig({ KURU_BUILDER_ADDRESS: '  ', KURU_BUILDER_FEE_PPS: '5' }),
    ).toBeNull();
  });

  it('defaults the rate to 10000 pps (10 bps) and checksums the address', () => {
    expect(loadKuruBuilderConfig({ KURU_BUILDER_ADDRESS: TREASURY.toLowerCase() })).toEqual({
      address: TREASURY,
      feePps: 10_000,
    });
  });

  it('takes a lower rate', () => {
    expect(
      loadKuruBuilderConfig({ KURU_BUILDER_ADDRESS: TREASURY, KURU_BUILDER_FEE_PPS: '5000' }),
    ).toEqual({ address: TREASURY, feePps: 5000 });
  });

  it.each(['10001', '100000', '0', '-1', '1.5', '1e4', 'ten'])(
    'refuses to boot with KURU_BUILDER_FEE_PPS=%p',
    (value) => {
      expect(() =>
        loadKuruBuilderConfig({ KURU_BUILDER_ADDRESS: TREASURY, KURU_BUILDER_FEE_PPS: value }),
      ).toThrow(/KURU_BUILDER_FEE_PPS/);
    },
  );

  it.each(['0x1234', 'treasury', '0x0000000000000000000000000000000000000000'])(
    'refuses to boot with KURU_BUILDER_ADDRESS=%p',
    (value) => {
      expect(() => loadKuruBuilderConfig({ KURU_BUILDER_ADDRESS: value })).toThrow(
        /KURU_BUILDER_ADDRESS/,
      );
    },
  );
});

describe('feePpsToBps', () => {
  it.each([
    [10_000, '10'],
    [5000, '5'],
    [2500, '2.5'],
    [1, '0.001'],
  ])('%p pps is %p bps', (pps, bps) => {
    expect(feePpsToBps(pps)).toBe(bps);
  });

  it('describes itself for the boot log', () => {
    expect(describeKuruBuilder(null)).toMatch(/off/);
    expect(describeKuruBuilder({ address: TREASURY, feePps: 10_000 })).toMatch(/10 bps/);
  });
});
