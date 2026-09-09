import { loadWalletConfig, WALLET_DEFAULTS } from './wallet.config';

const KEYED_PIMLICO = 'https://api.pimlico.io/v2/10143/rpc?apikey=secret';

describe('loadWalletConfig', () => {
  it('falls back to the keyless public bundler', () => {
    const config = loadWalletConfig({});
    expect(config.bundlerUrl).toBe(WALLET_DEFAULTS.bundlerUrl);
  });

  it('defaults the confirmation cadence to Monad block time, not Base flash blocks', () => {
    expect(loadWalletConfig({}).confirmationPollMs).toBe(300);
  });

  it('reports no paymaster when nothing is configured', () => {
    // The honest state, and the one this repo is actually in until a Pimlico
    // API key exists. Nothing downstream may claim sponsorship from here.
    expect(loadWalletConfig({}).paymaster).toEqual({
      provider: 'none',
      url: undefined,
      policyId: undefined,
    });
  });

  it('infers Pimlico from a sponsorship policy id', () => {
    const config = loadWalletConfig({
      PIMLICO_BUNDLER_URL: KEYED_PIMLICO,
      PIMLICO_SPONSORSHIP_POLICY_ID: 'sp_abc',
    });
    expect(config.bundlerUrl).toBe(KEYED_PIMLICO);
    expect(config.paymaster).toEqual({
      provider: 'pimlico',
      url: KEYED_PIMLICO,
      policyId: 'sp_abc',
    });
  });

  it('infers Alchemy from a gas policy id, and takes its own RPC url', () => {
    const config = loadWalletConfig({
      ALCHEMY_RPC_URL: 'https://monad-testnet.g.alchemy.com/v2/key',
      ALCHEMY_GAS_POLICY_ID: 'policy-1',
    });
    expect(config.paymaster.provider).toBe('alchemy');
    expect(config.paymaster.url).toBe('https://monad-testnet.g.alchemy.com/v2/key');
    expect(config.paymaster.policyId).toBe('policy-1');
  });

  it('lets an explicit provider override the inference', () => {
    // The swap is a config change, not a rewrite — this is the switch.
    const config = loadWalletConfig({
      PIMLICO_SPONSORSHIP_POLICY_ID: 'sp_abc',
      WALLET_PAYMASTER_PROVIDER: 'none',
    });
    expect(config.paymaster.provider).toBe('none');
  });

  it('rejects an unknown provider', () => {
    expect(() => loadWalletConfig({ WALLET_PAYMASTER_PROVIDER: 'stackup' })).toThrow(
      /WALLET_PAYMASTER_PROVIDER/,
    );
  });

  it('rejects a malformed bundler url without echoing it', () => {
    // The URL carries the API key, so the message must never contain the value.
    expect(() => loadWalletConfig({ PIMLICO_BUNDLER_URL: 'not-a-url?apikey=leaked' })).toThrow(
      /^PIMLICO_BUNDLER_URL is not a valid URL$/,
    );
  });

  it('rejects a non-http bundler url', () => {
    expect(() => loadWalletConfig({ WALLET_BUNDLER_URL: 'ws://example.com' })).toThrow(
      /must be an http\(s\) URL/,
    );
  });

  it('rejects non-positive timing values', () => {
    expect(() => loadWalletConfig({ WALLET_CONFIRMATION_POLL_MS: '0' })).toThrow(
      /WALLET_CONFIRMATION_POLL_MS/,
    );
    expect(() => loadWalletConfig({ WALLET_PREPARE_TTL_MS: 'soon' })).toThrow(
      /WALLET_PREPARE_TTL_MS/,
    );
  });

  it('prefers WALLET_BUNDLER_URL over PIMLICO_BUNDLER_URL', () => {
    const config = loadWalletConfig({
      WALLET_BUNDLER_URL: 'https://bundler.example/rpc',
      PIMLICO_BUNDLER_URL: KEYED_PIMLICO,
      PIMLICO_SPONSORSHIP_POLICY_ID: 'sp_abc',
    });
    expect(config.bundlerUrl).toBe('https://bundler.example/rpc');
    // ...but the paymaster still uses the keyed Pimlico endpoint.
    expect(config.paymaster.url).toBe(KEYED_PIMLICO);
  });
});
