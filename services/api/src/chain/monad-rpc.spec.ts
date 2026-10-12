import { MONAD_TESTNET_PUBLIC_RPC, monadReadTransport, monadRpcUrls } from './monad-rpc';

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
});
