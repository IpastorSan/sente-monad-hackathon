import {
  MONAD_RPC_TIMEOUT_MS,
  MONAD_TESTNET_PUBLIC_RPC,
  monadReadTransport,
  monadRpcUrls,
} from './monad-rpc';

describe('monadRpcUrls', () => {
  it('is the public RPC alone when unset, blank or already public', () => {
    expect(monadRpcUrls(undefined)).toEqual([MONAD_TESTNET_PUBLIC_RPC]);
    expect(monadRpcUrls('  ')).toEqual([MONAD_TESTNET_PUBLIC_RPC]);
    expect(monadRpcUrls(MONAD_TESTNET_PUBLIC_RPC)).toEqual([MONAD_TESTNET_PUBLIC_RPC]);
  });

  it('puts a dedicated RPC first and the public one after it', () => {
    expect(monadRpcUrls(' https://monad-testnet.example/v2/key ')).toEqual([
      'https://monad-testnet.example/v2/key',
      MONAD_TESTNET_PUBLIC_RPC,
    ]);
  });
});

describe('monadReadTransport', () => {
  it('is plain http on the public RPC and a fallback behind a dedicated one', () => {
    expect(monadReadTransport(undefined)({}).config.type).toBe('http');
    expect(monadReadTransport('https://monad-testnet.example/v2/key')({}).config.type).toBe(
      'fallback',
    );
  });

  // SEN-203: viem's http keeps its own retryCount over fallback's 0, so retries
  // on an endpoint made a hung dedicated RPC cost a timeout per retry.
  it('retries the fallback, never an endpoint inside it, and times each endpoint out', () => {
    const transport = monadReadTransport('https://monad-testnet.example/v2/key', {
      retryCount: 2,
      retryDelay: 400,
    })({});
    expect(transport.config).toMatchObject({ type: 'fallback', retryCount: 2, retryDelay: 400 });
    const inner = (
      transport.value as { transports: ReturnType<ReturnType<typeof monadReadTransport>>[] }
    ).transports;
    expect(inner).toHaveLength(2);
    for (const endpoint of inner) {
      expect(endpoint.config).toMatchObject({
        type: 'http',
        retryCount: 0,
        timeout: MONAD_RPC_TIMEOUT_MS,
      });
    }
    expect(MONAD_RPC_TIMEOUT_MS).toBeLessThanOrEqual(8_000);
  });

  it('retries a lone public RPC itself', () => {
    const transport = monadReadTransport(undefined, { retryCount: 2, retryDelay: 400 })({});
    expect(transport.config).toMatchObject({
      type: 'http',
      retryCount: 2,
      retryDelay: 400,
      timeout: MONAD_RPC_TIMEOUT_MS,
    });
  });
});
