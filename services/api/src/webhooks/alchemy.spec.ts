import { createHmac } from 'node:crypto';

import {
  ALCHEMY_SIGNATURE_HEADER,
  depositKey,
  parseAlchemyAddressActivity,
  toDepositDetail,
  verifyAlchemySignature,
} from './alchemy';
import { loadAlchemyConfig } from './alchemy.config';

const SIGNING_KEY = 'whsec_test_signing_key';
const AGENT = '0x1234567890AbcdEF1234567890aBcDeF12345678';

/**
 * Alchemy's own documented example delivery, with the network and addresses moved
 * to Monad testnet and a hired agent's wallet. Field for field as
 * https://www.alchemy.com/docs/reference/address-activity-webhook prints it,
 * `erc721TokenId`/`erc1155Metadata`/`typeTraceAddress` included, so the parser is
 * exercised against the real shape rather than a tidied one.
 */
const DELIVERY = {
  webhookId: 'wh_k63lg72rxda78gce',
  id: 'whevt_vq499kv7elmlbp2v',
  createdAt: '2026-09-24T07:42:26.411977228Z',
  type: 'ADDRESS_ACTIVITY',
  event: {
    network: 'MONAD_TESTNET',
    activity: [
      {
        blockNum: '0xdf34a3',
        hash: '0x7a4a39da2a3fa1fc2ef88fd1eaea070286ed2aba21e0419dcfb6d5c5d9f02a72',
        fromAddress: '0x503828976d22510aad0201ac7ec88293211d23da',
        toAddress: AGENT.toLowerCase(),
        value: 293.092129,
        asset: 'USDC',
        category: 'token',
        rawContract: {
          rawValue: '0x0000000000000000000000000000000000000000000000000000000011783b21',
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          decimals: 6,
        },
        erc721TokenId: null,
        erc1155Metadata: null,
        typeTraceAddress: null,
      },
    ],
  },
};

function body(payload: unknown = DELIVERY): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function sign(raw: Buffer, key = SIGNING_KEY): string {
  return createHmac('sha256', key).update(raw).digest('hex');
}

/** Parse or fail loudly — every mapping case below starts from a real parse. */
function parsed(payload: unknown = DELIVERY) {
  const result = parseAlchemyAddressActivity(body(payload));
  if (!result.ok) throw new Error(`fixture does not parse: ${result.reason}`);
  return result.payload;
}

describe('verifyAlchemySignature', () => {
  it('accepts the digest Alchemy documents: hex HMAC-SHA256 of the raw body', () => {
    const raw = body();
    // The docs' own sample, spelled out, so this pins the scheme and not our helper.
    const documented = createHmac('sha256', SIGNING_KEY)
      .update(raw.toString('utf8'), 'utf8')
      .digest('hex');

    expect(verifyAlchemySignature(raw, documented, SIGNING_KEY)).toBe(true);
    expect(verifyAlchemySignature(raw, documented.toUpperCase(), SIGNING_KEY)).toBe(true);
  });

  it('refuses a forged signature, a signature under another key, and a tampered body', () => {
    const raw = body();
    expect(verifyAlchemySignature(raw, sign(raw, 'someone-elses-key'), SIGNING_KEY)).toBe(false);
    expect(verifyAlchemySignature(raw, `0x${'ab'.repeat(32)}`, SIGNING_KEY)).toBe(false);
    expect(verifyAlchemySignature(raw, 'f'.repeat(64), SIGNING_KEY)).toBe(false);

    // The signature of the real body against a body with one digit changed.
    const tampered = body({
      ...DELIVERY,
      event: {
        ...DELIVERY.event,
        activity: [{ ...DELIVERY.event.activity[0], value: 999_999 }],
      },
    });
    expect(verifyAlchemySignature(tampered, sign(raw), SIGNING_KEY)).toBe(false);
  });

  it('refuses a missing signature and anything that is not 64 hex characters', () => {
    const raw = body();
    // `Buffer.from('zz','hex')` is EMPTY, so a length check has to come first or
    // every unparseable signature would compare equal to every other one.
    for (const bad of [undefined, '', 'zz', 'not-hex', sign(raw).slice(0, 63), `${sign(raw)}00`]) {
      expect(verifyAlchemySignature(raw, bad, SIGNING_KEY)).toBe(false);
    }
  });

  it('hashes bytes, so a body that is not valid UTF-8 cannot be laundered through a string', () => {
    // A lone continuation byte: `toString('utf8')` would replace it with U+FFFD
    // and hash something Alchemy never sent.
    const raw = Buffer.from([0x7b, 0x80, 0x7d]);
    expect(verifyAlchemySignature(raw, sign(raw), SIGNING_KEY)).toBe(true);
    expect(
      verifyAlchemySignature(
        raw,
        createHmac('sha256', SIGNING_KEY).update(raw.toString('utf8'), 'utf8').digest('hex'),
        SIGNING_KEY,
      ),
    ).toBe(false);
  });

  it('looks the header up under the name node normalises it to', () => {
    expect(ALCHEMY_SIGNATURE_HEADER).toBe('x-alchemy-signature');
  });
});

describe('parseAlchemyAddressActivity', () => {
  it('reads Alchemy’s documented Address Activity payload', () => {
    const parsed = parseAlchemyAddressActivity(body());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.id).toBe('whevt_vq499kv7elmlbp2v');
    expect(parsed.payload.event.network).toBe('MONAD_TESTNET');
    expect(parsed.payload.event.activity).toHaveLength(1);
  });

  it('tolerates a field Alchemy adds, and drops an activity entry missing what we need', () => {
    const grown = body({ ...DELIVERY, somethingNew: { added: 'later' } });
    expect(parseAlchemyAddressActivity(grown).ok).toBe(true);

    const half = parseAlchemyAddressActivity(
      body({
        ...DELIVERY,
        event: { ...DELIVERY.event, activity: [{ toAddress: AGENT }, DELIVERY.event.activity[0]] },
      }),
    );
    expect(half.ok).toBe(true);
    if (half.ok) expect(half.payload.event.activity).toHaveLength(1);
  });

  it('refuses a body that is not JSON', () => {
    expect(parseAlchemyAddressActivity(Buffer.from('not json'))).toEqual({
      ok: false,
      reason: 'body_not_json',
    });
    expect(parseAlchemyAddressActivity(Buffer.from('[]'))).toEqual({
      ok: false,
      reason: 'body_not_json',
    });
  });

  it('refuses another webhook type, an absent id and a missing activity list', () => {
    for (const bad of [
      { ...DELIVERY, type: 'NFT_ACTIVITY' },
      { ...DELIVERY, type: 'GRAPHQL' },
      { ...DELIVERY, id: '' },
      { ...DELIVERY, event: { network: 'MONAD_TESTNET' } },
    ]) {
      expect(parseAlchemyAddressActivity(body(bad))).toEqual({
        ok: false,
        reason: 'not_address_activity',
      });
    }
  });
});

describe('toDepositDetail', () => {
  it('maps a transfer to the asset, amount, sender, block and tx hash the Ledger shows', () => {
    const payload = parsed();
    const activity = payload.event.activity[0]!;

    const detail = toDepositDetail(payload, activity, 0);

    expect(detail).toEqual({
      asset: 'USDC',
      amount: '293.092129',
      rawAmount: '0x0000000000000000000000000000000000000000000000000000000011783b21',
      from: '0x503828976d22510aad0201ac7ec88293211d23da',
      to: AGENT.toLowerCase(),
      tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      decimals: 6,
      // 0xdf34a3, decoded: `blockNum` is documented as hex.
      blockNumber: 14_628_003,
      txHash: '0x7a4a39da2a3fa1fc2ef88fd1eaea070286ed2aba21e0419dcfb6d5c5d9f02a72',
      category: 'token',
      network: 'MONAD_TESTNET',
      deliveryId: 'whevt_vq499kv7elmlbp2v',
      dedupeKey: depositKey(activity, 0),
    });
    // The Ledger route serialises this, so it has to survive JSON unchanged.
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });

  it('handles a native MON transfer, which carries no rawContract', () => {
    const native = body({
      ...DELIVERY,
      event: {
        ...DELIVERY.event,
        activity: [
          {
            blockNum: '0x1',
            hash: `0x${'11'.repeat(32)}`,
            fromAddress: '0x503828976d22510aad0201ac7ec88293211d23da',
            toAddress: AGENT.toLowerCase(),
            value: 0.5,
            asset: 'MON',
            category: 'external',
          },
        ],
      },
    });
    const payload = parsed(JSON.parse(native.toString('utf8')));
    const detail = toDepositDetail(payload, payload.event.activity[0]!, 0);

    expect(detail).toMatchObject({
      asset: 'MON',
      amount: '0.5',
      category: 'external',
      blockNumber: 1,
    });
    expect(detail).not.toHaveProperty('rawAmount');
    expect(detail).not.toHaveProperty('tokenAddress');
  });

  it('refuses an unparseable block number rather than recording NaN', () => {
    const payload = parsed({
      ...DELIVERY,
      event: {
        ...DELIVERY.event,
        activity: [{ ...DELIVERY.event.activity[0], blockNum: 'latest' }],
      },
    });
    expect(toDepositDetail(payload, payload.event.activity[0]!, 0)).toBeUndefined();
  });

  it('names an asset Alchemy did not', () => {
    const payload = parsed({
      ...DELIVERY,
      event: {
        ...DELIVERY.event,
        activity: [{ ...DELIVERY.event.activity[0], asset: undefined, value: undefined }],
      },
    });
    expect(toDepositDetail(payload, payload.event.activity[0]!, 0)).toMatchObject({
      asset: 'unknown',
      amount: '0',
    });
  });
});

describe('depositKey', () => {
  it('is stable across a retry of the same delivery and distinguishes two transfers in one tx', () => {
    const twice = {
      ...DELIVERY,
      event: {
        ...DELIVERY.event,
        activity: [DELIVERY.event.activity[0], DELIVERY.event.activity[0]],
      },
    };
    const first = parsed(twice).event.activity;
    const retry = parsed(twice).event.activity;

    expect(depositKey(first[0]!, 0)).toBe(depositKey(retry[0]!, 0));
    expect(depositKey(first[0]!, 0)).not.toBe(depositKey(first[1]!, 1));
    // Case is not part of the identity: Alchemy sends lower case, we may not.
    expect(depositKey(first[0]!, 0)).toContain(AGENT.toLowerCase());
  });
});

describe('loadAlchemyConfig', () => {
  it('is entirely optional: nothing set is a valid, disabled configuration', () => {
    expect(loadAlchemyConfig({})).toEqual({
      webhookSigningKey: undefined,
      notifyAuthToken: undefined,
      notifyWebhookId: undefined,
      notifyTimeoutMs: 5_000,
    });
  });

  it('trims and treats blank as unset', () => {
    expect(
      loadAlchemyConfig({
        ALCHEMY_WEBHOOK_SIGNING_KEY: '  whsec_x  ',
        ALCHEMY_NOTIFY_AUTH_TOKEN: '   ',
        ALCHEMY_NOTIFY_WEBHOOK_ID: 'wh_abc',
        ALCHEMY_NOTIFY_TIMEOUT_MS: '1500',
      }),
    ).toEqual({
      webhookSigningKey: 'whsec_x',
      notifyAuthToken: undefined,
      notifyWebhookId: 'wh_abc',
      notifyTimeoutMs: 1_500,
    });
  });

  it('falls back rather than throwing on a nonsense timeout: it is not a guarantee', () => {
    for (const bad of ['0', '-1', 'soon', '1.5']) {
      expect(loadAlchemyConfig({ ALCHEMY_NOTIFY_TIMEOUT_MS: bad }).notifyTimeoutMs).toBe(5_000);
    }
  });
});
