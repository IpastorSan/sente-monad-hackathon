import {
  agentKuruBuilder,
  describeKuruBuilder,
  feePpsToBps,
  loadAgentKuruBuilder,
  loadKuruBuilderConfig,
} from './kuru-builder.config';

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

describe('loadAgentKuruBuilder', () => {
  it('follows the builder unless KURU_BUILDER_AGENTS turns agents off', () => {
    const env = { KURU_BUILDER_ADDRESS: TREASURY };
    expect(loadAgentKuruBuilder(env)).toEqual({ address: TREASURY, feePps: 10_000 });
    expect(loadAgentKuruBuilder({ ...env, KURU_BUILDER_AGENTS: '1' })).not.toBeNull();
    expect(loadAgentKuruBuilder({ ...env, KURU_BUILDER_AGENTS: '0' })).toBeNull();
    expect(loadAgentKuruBuilder({ ...env, KURU_BUILDER_AGENTS: 'false' })).toBeNull();
    expect(loadAgentKuruBuilder({})).toBeNull();
  });
});

describe('agentKuruBuilder: old policies fall back to the plain overload (gotcha 13)', () => {
  const config = { address: TREASURY, feePps: 10_000 } as const;
  const mandate = { expiresAt: 2_000_000_000 };

  it('pays the fee when the live policy was compiled with it', () => {
    const settings = agentKuruBuilder(
      { mandate, kuruBuilder: { address: TREASURY, maxFeePps: 10_000 } },
      config,
    );
    expect(settings).toMatchObject({ address: TREASURY, feePps: 10_000 });
    // The approval never outlives the mandate: the policy caps it there.
    expect(settings!.approvalExpiry(1_700_000_000)).toBe(2_000_000_000n);
  });

  it('pays nothing for an agent hired before SEN-184 or with the fee off', () => {
    expect(agentKuruBuilder({ mandate }, config)).toBeUndefined();
    expect(
      agentKuruBuilder({ mandate, kuruBuilder: { address: TREASURY, maxFeePps: 10_000 } }, null),
    ).toBeUndefined();
  });

  it('pays nothing when the policy names another builder or a lower ceiling', () => {
    const other = '0x1111111111111111111111111111111111111111';
    expect(
      agentKuruBuilder({ mandate, kuruBuilder: { address: other, maxFeePps: 10_000 } }, config),
    ).toBeUndefined();
    expect(
      agentKuruBuilder({ mandate, kuruBuilder: { address: TREASURY, maxFeePps: 5_000 } }, config),
    ).toBeUndefined();
  });
});
