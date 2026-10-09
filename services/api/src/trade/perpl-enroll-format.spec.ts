import type { PerplTypedData } from '@sente/venues/perpl';
import type { Hex } from 'viem';

import {
  enrollPayloadProblem,
  perplPublicKeyField,
  type EnrollExpectation,
} from './perpl-enroll-format';

/**
 * Perpl's live `/v1/api-key/payload` answers, verbatim, as probe P5 recorded
 * them on 2026-10-09 (`docs/user-trading.md` §P5): the phone's trade key asked
 * for `scope_mask: 2`, a read key for `scope_mask: 1`, from wallet
 * 0x0d46…cdaF. If Perpl changes its format these stop being what it serves,
 * and this spec is the record of what it used to be.
 */
const TYPES: PerplTypedData['types'] = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ],
  PerplRegisterApiKey: [
    { name: 'signer', type: 'address' },
    { name: 'statement', type: 'string' },
    { name: 'publicKey', type: 'string' },
    { name: 'scope', type: 'string' },
    { name: 'label', type: 'string' },
    { name: 'expiresAt', type: 'string' },
    { name: 'ipCidrs', type: 'string' },
    { name: 'origin', type: 'string' },
    { name: 'builderId', type: 'string' },
    { name: 'maxBuilderFeePer100K', type: 'string' },
    { name: 'time', type: 'uint64' },
  ],
};

const SIGNER = '0x0d46fB9bD65FF35604cD654Cf98C5bb6ac75cdaF';
const STATEMENT =
  'I authorize the creation of Perpl API key with the specified scope and parameters';

const LIVE_TRADE: PerplTypedData = {
  types: TYPES,
  primaryType: 'PerplRegisterApiKey',
  domain: {
    name: 'perpl.xyz',
    version: '1',
    chainId: '0x279f',
    verifyingContract: '0x0000000000000000000000000000000000000000',
    salt: '0x00000000000000000000000000000000000000006ac90a94368ca5c38df038c8',
  },
  message: {
    builderId: '0',
    expiresAt: '0',
    ipCidrs: '',
    label: 'sente-trade-live',
    maxBuilderFeePer100K: '0',
    origin: '',
    publicKey: 'K-jkJP9_btQdpK93KHSogNuKj3hjZ4SAbD_SzNbUsxw',
    scope: '3',
    signer: SIGNER,
    statement: STATEMENT,
    time: '0x1a121515593',
  },
};

const LIVE_READ: PerplTypedData = {
  types: TYPES,
  primaryType: 'PerplRegisterApiKey',
  domain: {
    name: 'perpl.xyz',
    version: '1',
    chainId: '0x279f',
    verifyingContract: '0x0000000000000000000000000000000000000000',
    salt: '0x00000000000000000000000000000000000000006ac90a95895a93c38d8e6b3e',
  },
  message: {
    builderId: '0',
    expiresAt: '0',
    ipCidrs: '',
    label: 'sente-trade-live-read',
    maxBuilderFeePer100K: '0',
    origin: '',
    publicKey: '2_7hT2H3eLnefScEi7O4QT1TeCYVcir1ntXz2hZuJIM',
    scope: '1',
    signer: SIGNER,
    statement: STATEMENT,
    time: '0x1a121515641',
  },
};

/** The `public_key` each request sent, as `0x` hex. */
const TRADE_KEY: Hex = '0x2be8e424ff7f6ed41da4af772874a880db8a8f78636784806c3fd2ccd6d4b31c';
const READ_KEY: Hex = '0xdbfee14f61f778b9de7d27048bb3b8413d53782615722af59ed5f3da166e2483';

const TRADE: EnrollExpectation = {
  role: 'trade',
  chainId: 10143,
  signer: SIGNER,
  publicKeyHex: TRADE_KEY,
  label: 'sente-trade-live',
  now: new Date(0x1a121515593),
};
const READ: EnrollExpectation = {
  role: 'read',
  chainId: 10143,
  signer: SIGNER,
  publicKeyHex: READ_KEY,
  label: 'sente-trade-live-read',
  now: new Date(0x1a121515641),
};

function tampered(typed: PerplTypedData, message: Record<string, string>): PerplTypedData {
  return { ...typed, message: { ...typed.message, ...message } };
}

describe('enrollPayloadProblem against the live P5 payloads', () => {
  it('accepts the trade-scoped payload Perpl served', () => {
    expect(enrollPayloadProblem(LIVE_TRADE, TRADE)).toBeUndefined();
  });

  it('accepts the read-scoped payload Perpl served', () => {
    expect(enrollPayloadProblem(LIVE_READ, READ)).toBeUndefined();
  });

  it('reads the public key as unpadded base64url of the hex we sent', () => {
    expect(perplPublicKeyField(TRADE_KEY)).toBe(LIVE_TRADE.message['publicKey']);
    expect(perplPublicKeyField(READ_KEY)).toBe(LIVE_READ.message['publicKey']);
  });

  it('pins scope to the effective mask: trade is 3, read is 1', () => {
    expect(enrollPayloadProblem(tampered(LIVE_TRADE, { scope: '2' }), TRADE)).toBe('scope 2');
    expect(enrollPayloadProblem(tampered(LIVE_READ, { scope: '3' }), READ)).toBe('scope 3');
    // A trade-scoped payload is not a read-scoped one, whatever else matches.
    expect(enrollPayloadProblem(LIVE_TRADE, { ...TRADE, role: 'read' })).toBe('scope 3');
  });

  it.each([
    ['expiresAt', ''],
    ['expiresAt', '1791560221000'],
    ['builderId', ''],
    ['builderId', 'skimmer'],
    ['maxBuilderFeePer100K', ''],
    ['maxBuilderFeePer100K', '50'],
    ['ipCidrs', '0'],
    ['origin', 'https://sente.lol'],
  ])('refuses %s %j: only the recorded spelling of "not set" passes', (field, value) => {
    expect(enrollPayloadProblem(tampered(LIVE_TRADE, { [field]: value }), TRADE)).toBe(
      `${field} ${value}`,
    );
  });

  it('refuses our key in another encoding', () => {
    const hex = tampered(LIVE_TRADE, { publicKey: TRADE_KEY });
    expect(enrollPayloadProblem(hex, TRADE)).toBe(`publicKey ${TRADE_KEY}`);
    const padded = tampered(LIVE_TRADE, { publicKey: `${LIVE_TRADE.message['publicKey']}=` });
    expect(enrollPayloadProblem(padded, TRADE)).toMatch(/^publicKey /);
  });

  it('refuses a payload served more than five minutes from our clock', () => {
    const late = { ...TRADE, now: new Date(0x1a121515593 + 5 * 60 * 1000 + 1) };
    expect(enrollPayloadProblem(LIVE_TRADE, late)).toBe('time 0x1a121515593');
  });
});
