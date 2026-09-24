import { createHmac } from 'node:crypto';

import { HttpException } from '@nestjs/common';

import {
  InMemoryAgentEventLog,
  type AgentEvent,
  type AgentEventLog,
} from '../agents/events/agent-event-log';
import type { AlchemyConfig } from './alchemy.config';
import { loadAlchemyConfig } from './alchemy.config';
import { WebhooksService, type AgentAddresses } from './webhooks.service';

const SIGNING_KEY = 'whsec_test_signing_key';
const AGENT_ID = 'agent-1';
/** EIP-55, as `AgentRecord.address` stores it. Alchemy sends it lower case. */
const AGENT_WALLET = '0x1234567890AbcdEF1234567890aBcDeF12345678';
const STRANGER = '0x00000000000000000000000000000000000000ff';

const CONFIGURED: AlchemyConfig = loadAlchemyConfig({
  ALCHEMY_WEBHOOK_SIGNING_KEY: SIGNING_KEY,
});

function delivery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    webhookId: 'wh_k63lg72rxda78gce',
    id: 'whevt_vq499kv7elmlbp2v',
    createdAt: '2026-09-24T07:42:26.411977228Z',
    type: 'ADDRESS_ACTIVITY',
    event: {
      network: 'MONAD_TESTNET',
      activity: [
        {
          blockNum: '0xdf34a3',
          hash: `0x${'7a'.repeat(32)}`,
          fromAddress: '0x503828976d22510aad0201ac7ec88293211d23da',
          toAddress: AGENT_WALLET.toLowerCase(),
          value: 25,
          asset: 'USDC',
          category: 'token',
          rawContract: {
            rawValue: `0x${'0'.repeat(56)}017d7840`,
            address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            decimals: 6,
          },
        },
      ],
    },
    ...overrides,
  };
}

function raw(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function sign(body: Buffer, key = SIGNING_KEY): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

/** Only `AGENT_WALLET` belongs to an agent; everything else is a stranger. */
const addresses: AgentAddresses = {
  agentIdForAddress: (address) =>
    Promise.resolve(address.toLowerCase() === AGENT_WALLET.toLowerCase() ? AGENT_ID : undefined),
};

function setup(
  config: AlchemyConfig = CONFIGURED,
  log: AgentEventLog = new InMemoryAgentEventLog(),
) {
  const service = new WebhooksService(config, log, addresses);
  // Nest's Logger writes to stdout; a spec exercising four refusals should not.
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  return { service, log };
}

async function deposits(log: AgentEventLog): Promise<AgentEvent[]> {
  return log.list(AGENT_ID, { kind: 'deposit' });
}

async function httpError(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof HttpException)) {
    throw new Error(`expected HttpException, got ${String(error)}`);
  }
  return { status: error.getStatus(), body: error.getResponse() };
}

describe('WebhooksService.handleAlchemy', () => {
  afterEach(() => jest.restoreAllMocks());

  it('appends exactly one deposit for a valid delivery naming a hired agent', async () => {
    const { service, log } = setup();
    const body = raw(delivery());

    await expect(service.handleAlchemy(body, sign(body))).resolves.toEqual({
      received: true,
      appended: 1,
    });

    const [deposit, ...rest] = await deposits(log);
    expect(rest).toHaveLength(0);
    expect(deposit).toMatchObject({
      agentId: AGENT_ID,
      kind: 'deposit',
      detail: {
        asset: 'USDC',
        amount: '25',
        from: '0x503828976d22510aad0201ac7ec88293211d23da',
        blockNumber: 14_628_003,
        txHash: `0x${'7a'.repeat(32)}`,
        deliveryId: 'whevt_vq499kv7elmlbp2v',
      },
    });
    // Nothing the agent did caused it, so it names no run and no tool.
    expect(deposit?.runId).toBeUndefined();
    expect(deposit?.tool).toBeUndefined();
  });

  it('appends nothing on a repeated delivery — Alchemy retries, and a retry is not a second deposit', async () => {
    const { service, log } = setup();
    const body = raw(delivery());
    const signature = sign(body);

    await expect(service.handleAlchemy(body, signature)).resolves.toEqual({
      received: true,
      appended: 1,
    });
    await expect(service.handleAlchemy(body, signature)).resolves.toEqual({
      received: true,
      appended: 0,
      ignored: 'already_seen',
    });
    await expect(service.handleAlchemy(body, signature)).resolves.toMatchObject({ appended: 0 });

    expect(await deposits(log)).toHaveLength(1);
  });

  it('appends one per transfer when a delivery carries several, including a repeat of the same amount', async () => {
    const { service, log } = setup();
    const first = delivery().event as { activity: unknown[] };
    const body = raw(
      delivery({
        event: { network: 'MONAD_TESTNET', activity: [first.activity[0], first.activity[0]] },
      }),
    );

    await expect(service.handleAlchemy(body, sign(body))).resolves.toEqual({
      received: true,
      appended: 2,
    });
    expect(await deposits(log)).toHaveLength(2);
    // And the retry of THAT delivery still appends nothing.
    await expect(service.handleAlchemy(body, sign(body))).resolves.toMatchObject({ appended: 0 });
    expect(await deposits(log)).toHaveLength(2);
  });

  it('refuses a forged, wrongly-keyed or missing signature with 401 and appends nothing', async () => {
    const { service, log } = setup();
    const body = raw(delivery());

    for (const signature of [
      undefined,
      '',
      'f'.repeat(64),
      sign(body, 'someone-elses-key'),
      sign(raw(delivery({ id: 'whevt_other' }))),
    ]) {
      expect(await httpError(service.handleAlchemy(body, signature))).toMatchObject({
        status: 401,
        body: { reason: 'signature_invalid' },
      });
    }
    expect(await deposits(log)).toHaveLength(0);
  });

  it('refuses when the raw body never reached it, rather than trusting an unsigned call', async () => {
    const { service } = setup();
    expect(await httpError(service.handleAlchemy(undefined, 'f'.repeat(64)))).toMatchObject({
      status: 401,
    });
  });

  it('refuses with 503 when no signing key is configured, so nothing unverified is ever accepted', async () => {
    const { service, log } = setup(loadAlchemyConfig({}));
    const body = raw(delivery());

    // Even a correctly signed call: without the key there is nothing to check against.
    expect(await httpError(service.handleAlchemy(body, sign(body)))).toMatchObject({
      status: 503,
      body: { reason: 'webhook_unconfigured' },
    });
    expect(await deposits(log)).toHaveLength(0);
  });

  it('accepts and ignores a verified delivery for an address that is not a hired agent', async () => {
    const { service, log } = setup();
    const activity = (delivery().event as { activity: Record<string, unknown>[] }).activity[0];
    const body = raw(
      delivery({
        event: {
          network: 'MONAD_TESTNET',
          activity: [{ ...activity, toAddress: STRANGER }],
        },
      }),
    );

    // 200, not an error: the webhook may legitimately watch other addresses, and
    // a non-2xx would make Alchemy retry for ten minutes.
    await expect(service.handleAlchemy(body, sign(body))).resolves.toEqual({
      received: true,
      appended: 0,
      ignored: 'no_watched_agent',
    });
    expect(await deposits(log)).toHaveLength(0);
  });

  it('accepts and ignores a verified delivery that is not Address Activity, or is not JSON', async () => {
    const { service } = setup();
    const other = raw(delivery({ type: 'NFT_ACTIVITY' }));
    await expect(service.handleAlchemy(other, sign(other))).resolves.toEqual({
      received: true,
      appended: 0,
      ignored: 'not_address_activity',
    });

    const junk = Buffer.from('<html>not json</html>');
    await expect(service.handleAlchemy(junk, sign(junk))).resolves.toEqual({
      received: true,
      appended: 0,
      ignored: 'body_not_json',
    });
  });

  it('answers 200 when the log itself fails, so Alchemy does not retry a delivery already spent', async () => {
    const failing: AgentEventLog = {
      append: () => Promise.reject(new Error('log is full')),
      list: () => Promise.resolve([]),
    };
    const { service } = setup(CONFIGURED, failing);
    const body = raw(delivery());

    await expect(service.handleAlchemy(body, sign(body))).resolves.toEqual({
      received: true,
      appended: 0,
      ignored: 'append_failed',
    });
  });

  it('leaves a delivery replayable when the log failed, rather than burning its key', async () => {
    let failing = true;
    const log = new InMemoryAgentEventLog();
    const flaky: AgentEventLog = {
      append: (event) => (failing ? Promise.reject(new Error('log is full')) : log.append(event)),
      list: (agentId, query) => log.list(agentId, query),
    };
    const { service } = setup(CONFIGURED, flaky);
    const body = raw(delivery());

    // Reserving the key before the append and never releasing it would make this
    // deposit unrecoverable: the 200 tells Alchemy not to retry, and a manual
    // replay would then be dropped as a duplicate.
    await expect(service.handleAlchemy(body, sign(body))).resolves.toMatchObject({
      ignored: 'append_failed',
    });

    failing = false;
    await expect(service.handleAlchemy(body, sign(body))).resolves.toEqual({
      received: true,
      appended: 1,
    });
    expect(await deposits(log)).toHaveLength(1);
  });
});
