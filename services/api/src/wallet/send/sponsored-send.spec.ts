import { KURU_TESTNET_TOKENS, NATIVE_TOKEN } from '@sente/venues/kuru';
import { decodeFunctionData, erc20Abi, getAddress } from 'viem';

import {
  generateAuthorizationKey,
  signAuthorizationPayload,
} from '../../agents/privy/authorization-key';
import { PrivyClient } from '../../agents/privy/privy.client';
import {
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  fakePrivy,
  requestSignedByAny,
} from '../../agents/privy/testing/fake-privy';
import { PrivyUserWalletProvider } from '../user-wallet.provider';
import {
  readSendResponse,
  SEND_CAIP2,
  SEND_CHAIN_ID,
  sendableToken,
  sponsoredCallTransaction,
  sponsoredSendBody,
  sponsoredTransferTransaction,
} from './sponsored-send';

const RECIPIENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const USDC = KURU_TESTNET_TOKENS.USDC;
const MON = KURU_TESTNET_TOKENS.MON;

describe('sponsoredTransferTransaction', () => {
  it('encodes an ERC-20 transfer with no value at all', () => {
    const transaction = sponsoredTransferTransaction(USDC, getAddress(RECIPIENT), 5_000_000n);

    expect(transaction).toEqual({
      to: getAddress(USDC.address),
      data: expect.stringMatching(/^0xa9059cbb/) as unknown as string,
      chain_id: SEND_CHAIN_ID,
    });
    // An absent `value` and a zero one are different bytes, and the phone
    // rebuilds these bytes: the absence is part of the contract.
    expect(transaction).not.toHaveProperty('value');
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: transaction['data'] as `0x${string}`,
    });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toEqual([getAddress(RECIPIENT), 5_000_000n]);
  });

  it('sends native MON as a hex value with no calldata', () => {
    const transaction = sponsoredTransferTransaction(MON, getAddress(RECIPIENT), 10n ** 17n);

    expect(transaction).toEqual({
      to: getAddress(RECIPIENT),
      // Hex, unpadded, lowercase: Privy rejects a decimal string outright.
      value: '0x16345785d8a0000',
      chain_id: SEND_CHAIN_ID,
    });
    expect(transaction).not.toHaveProperty('data');
  });

  it('checksums the recipient, because Privy compares `to` case-sensitively', () => {
    const transaction = sponsoredTransferTransaction(MON, RECIPIENT as `0x${string}`, 1n);

    expect(transaction['to']).toBe(getAddress(RECIPIENT));
  });

  it('refuses a zero or negative amount', () => {
    expect(() => sponsoredTransferTransaction(USDC, getAddress(RECIPIENT), 0n)).toThrow(RangeError);
    expect(() => sponsoredTransferTransaction(USDC, getAddress(RECIPIENT), -1n)).toThrow(
      RangeError,
    );
  });
});

describe('sponsoredSendBody', () => {
  it('asks for sponsorship on Monad testnet, and nothing else', () => {
    const transaction = sponsoredTransferTransaction(USDC, getAddress(RECIPIENT), 1n);

    expect(sponsoredSendBody(transaction)).toEqual({
      method: 'eth_sendTransaction',
      caip2: 'eip155:10143',
      sponsor: true,
      params: { transaction },
    });
    expect(SEND_CAIP2).toBe(`eip155:${SEND_CHAIN_ID}`);
  });
});

describe('sponsoredCallTransaction', () => {
  const CALLDATA = '0xdeadbeef';

  it('checksums `to` and carries no `value` when none is attached', () => {
    const transaction = sponsoredCallTransaction(RECIPIENT as `0x${string}`, CALLDATA);

    expect(transaction).toEqual({
      to: getAddress(RECIPIENT),
      data: CALLDATA,
      chain_id: SEND_CHAIN_ID,
    });
    expect(transaction).not.toHaveProperty('value');
  });

  it('leaves a zero value out rather than signing `0x0`', () => {
    expect(sponsoredCallTransaction(getAddress(RECIPIENT), CALLDATA, 0n)).not.toHaveProperty(
      'value',
    );
  });

  it('writes a non-zero value as unpadded hex', () => {
    expect(sponsoredCallTransaction(getAddress(RECIPIENT), CALLDATA, 10n ** 17n)).toEqual({
      to: getAddress(RECIPIENT),
      data: CALLDATA,
      value: '0x16345785d8a0000',
      chain_id: SEND_CHAIN_ID,
    });
  });

  it('refuses a negative value', () => {
    expect(() => sponsoredCallTransaction(getAddress(RECIPIENT), CALLDATA, -1n)).toThrow(
      RangeError,
    );
  });
});

// SEN-87: the idempotency key is a signed `privy-` header, so it has to be in
// the payload the phone signs AND in the request commit sends — one without
// the other is a 401 at Privy. Checked end to end against the fake Privy.
describe('PrivyUserWalletProvider idempotency key', () => {
  const WALLET_ID = 'wallet-1';
  const KEY = 'sente-trade:client-1:0';

  function provider() {
    const fake = fakePrivy((request) =>
      request.url.endsWith('/rpc')
        ? { status: 200, body: { data: { hash: '', transaction_id: 'tx-1' } } }
        : undefined,
    );
    const client = new PrivyClient({
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
      fetch: fake.fetch,
    });
    return { fake, wallets: new PrivyUserWalletProvider(client) };
  }

  const transaction = sponsoredTransferTransaction(USDC, getAddress(RECIPIENT), 1n);

  it('puts the key in the signed headers and sends the same header on commit', async () => {
    const { fake, wallets } = provider();
    const owner = generateAuthorizationKey();

    const prepared = await wallets.prepareSend({
      walletId: WALLET_ID,
      transaction,
      idempotencyKey: KEY,
    });
    expect(prepared.payload.headers).toEqual({
      'privy-app-id': FAKE_APP_ID,
      'privy-idempotency-key': KEY,
    });
    expect(prepared.request.idempotencyKey).toBe(KEY);

    const signature = signAuthorizationPayload(owner.privateKey, prepared.payload);
    await wallets.commitSend(prepared.request, { signature });

    const sent = fake.calls.at(-1)!;
    expect(sent.headers['privy-idempotency-key']).toBe(KEY);
    // The phone's signature verifies over what was actually sent.
    expect(requestSignedByAny(sent, [owner.publicKey])).toBe(true);
  });

  it('without a key, signs and sends exactly what a transfer always did', async () => {
    const { fake, wallets } = provider();
    const owner = generateAuthorizationKey();

    const prepared = await wallets.prepareSend({ walletId: WALLET_ID, transaction });
    expect(prepared.payload.headers).toEqual({ 'privy-app-id': FAKE_APP_ID });
    expect(prepared.request).not.toHaveProperty('idempotencyKey');

    await wallets.commitSend(prepared.request, {
      signature: signAuthorizationPayload(owner.privateKey, prepared.payload),
    });

    const sent = fake.calls.at(-1)!;
    expect(sent.headers).not.toHaveProperty('privy-idempotency-key');
    expect(requestSignedByAny(sent, [owner.publicKey])).toBe(true);
  });

  it('a key changed after signing breaks the signature', async () => {
    const { fake, wallets } = provider();
    const owner = generateAuthorizationKey();

    const prepared = await wallets.prepareSend({
      walletId: WALLET_ID,
      transaction,
      idempotencyKey: KEY,
    });
    const signature = signAuthorizationPayload(owner.privateKey, prepared.payload);
    await wallets.commitSend(
      { ...prepared.request, idempotencyKey: `${KEY}-other` },
      { signature },
    );

    expect(requestSignedByAny(fake.calls.at(-1)!, [owner.publicKey])).toBe(false);
  });
});

describe('sendableToken', () => {
  it('finds a token whatever the casing, native MON included', () => {
    expect(sendableToken(USDC.address.toLowerCase())?.symbol).toBe('USDC');
    expect(sendableToken(NATIVE_TOKEN)?.symbol).toBe('MON');
    expect(sendableToken(USDC.address)?.decimals).toBe(6);
  });

  it('is undefined for a token that is not sendable, and for nonsense', () => {
    expect(sendableToken('0x1111111111111111111111111111111111111111')).toBeUndefined();
    expect(sendableToken('not-an-address')).toBeUndefined();
    expect(sendableToken('')).toBeUndefined();
  });
});

describe('readSendResponse', () => {
  it('reads the USER OPERATION hash of a sponsored send, and not the empty `hash`', () => {
    // The exact body Privy returned on 2026-09-24.
    const outcome = readSendResponse({
      method: 'eth_sendTransaction',
      data: {
        hash: '',
        user_operation_hash: `0x${'ab'.repeat(32)}`,
        transaction_id: 'txid_1',
      },
    });

    expect(outcome).toEqual({
      userOpHash: `0x${'ab'.repeat(32)}`,
      transactionId: 'txid_1',
    });
    // Empty string is not a hash. A confirmation view that took it for one would
    // poll a transaction receipt forever (the SEN-39 probe's check 6r).
    expect(outcome.transactionHash).toBeUndefined();
  });

  it('reads a plain transaction hash when Privy did not sponsor', () => {
    const outcome = readSendResponse({
      data: { hash: `0x${'cd'.repeat(32)}` },
    });

    expect(outcome).toEqual({ transactionHash: `0x${'cd'.repeat(32)}` });
  });

  it('finds nothing in a shape it does not recognise, rather than inventing it', () => {
    expect(readSendResponse({})).toEqual({});
    expect(readSendResponse(null)).toEqual({});
    expect(readSendResponse({ data: { hash: '0x1234' } })).toEqual({});
  });
});
