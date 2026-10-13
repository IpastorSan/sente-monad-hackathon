import { HttpRequestError } from 'viem';

import { Erc7677Sponsorship } from '../wallet/paymaster/erc7677-sponsorship';
import { WalletRefusedError, walletRefusalToHttpException } from '../wallet/wallet.errors';
import { redactError, redactSecrets } from './redact-error';

const SECRET = 'k3y-FAKE-do-not-leak';
const KEYED_URL = `https://monad-testnet.g.alchemy.com/v2/${SECRET}?apikey=${SECRET}`;

describe('redactSecrets (SEN-204)', () => {
  it('masks whole URLs, keys in the path included', () => {
    expect(redactSecrets(`POST ${KEYED_URL} failed`)).toBe('POST [url] failed');
    expect(redactSecrets(`wss://rpc.example/ws/${SECRET}`)).toBe('[url]');
  });

  it('masks key-like query values outside a URL too', () => {
    expect(redactSecrets(`apikey=${SECRET}&x=1`)).toBe('apikey=[redacted]&x=1');
    expect(redactSecrets(`api_key=${SECRET} key=${SECRET} token=${SECRET}`)).toBe(
      'api_key=[redacted] key=[redacted] token=[redacted]',
    );
    // Not a key parameter: a word that merely ends in "key".
    expect(redactSecrets('monkey=1')).toBe('monkey=1');
  });
});

describe('redactError (SEN-204)', () => {
  it("keeps viem's shortMessage and drops the URL its message carries", () => {
    const error = new HttpRequestError({ url: KEYED_URL, status: 500, details: 'upstream down' });
    expect(error.message).toContain(SECRET);

    const text = redactError(error);
    expect(text).toBe('HTTP request failed. (upstream down)');
    expect(text).not.toContain(SECRET);
  });

  it('describes a plain error by its first paragraph and Details, and caps it', () => {
    const error = new Error(
      `bundler said no\n\nRequest: ${KEYED_URL}\n Details: AA21 at ${KEYED_URL}`,
    );
    expect(redactError(error)).toBe('bundler said no (AA21 at [url])');
    expect(redactError(new Error('x'.repeat(1000)))).toHaveLength(403);
    expect(redactError(`fetch ${KEYED_URL}`)).toBe('fetch [url]');
  });
});

describe('the paymaster path (SEN-204)', () => {
  it('never puts the keyed paymaster URL in the refusal', async () => {
    // A closed local port: the request fails at once, and nothing leaves this machine.
    const url = `http://127.0.0.1:9/rpc/${SECRET}?apikey=${SECRET}`;
    const sponsorship = new Erc7677Sponsorship('pimlico', url, 'sp_policy');
    const error = await sponsorship
      .quote({
        sender: `0x${'1'.repeat(40)}`,
        nonce: 0n,
        callData: '0x',
        callGasLimit: 1n,
        verificationGasLimit: 1n,
        preVerificationGas: 1n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );
    expect(error?.message).toMatch(/pm_getPaymasterData failed/);
    expect(error?.message).not.toContain(SECRET);
  }, 20_000);

  it('redacts a refusal message on its way into an HTTP body', () => {
    const exception = walletRefusalToHttpException(
      new WalletRefusedError('sponsorship_unavailable', `declined at ${KEYED_URL}`),
    ) as { getResponse(): { message: string } };
    expect(exception.getResponse().message).toBe('declined at [url]');
  });
});
