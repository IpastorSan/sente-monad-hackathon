import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { KuruVenue } from '@sente/venues/kuru';
import type { PerplCredentials, PerplVenue } from '@sente/venues/perpl';
import { getAddress, type Hex, type PublicClient } from 'viem';

import type { AgentWalletProvider } from '../agent-wallet.provider';
import { InMemoryAgentSecretStore, type AgentSecretStore } from './agent-secret-store';
import { AgentTransactionSender, type AgentChainClient } from './agent-transactions';
import { AgentVenues } from './agent-venues';
import { FileAgentSecretStore } from './file-agent-secret-store';
import { PerplAgentAccounts } from './perpl-agent';
import { perplEnrollFake } from './testing/perpl-enroll-fake';

const AGENT = {
  agentId: 'agent-1',
  walletId: 'wallet-1',
  address: getAddress('0x4444444444444444444444444444444444444444'),
};
const IDLE_MS = 60_000;

function harness() {
  const secrets = new InMemoryAgentSecretStore();
  const created: { credentials: PerplCredentials; close: jest.Mock }[] = [];
  const venues = new AgentVenues({
    publicClient: {} as PublicClient,
    sender: new AgentTransactionSender({
      wallets: {} as AgentWalletProvider,
      chain: {} as AgentChainClient,
    }),
    secrets,
    idleMs: IDLE_MS,
    createPerplVenue: (credentials) => {
      const fake = { credentials, close: jest.fn() };
      created.push(fake);
      return fake as unknown as PerplVenue;
    },
  });
  const enroll = () =>
    secrets.putPerplCredentials(AGENT.agentId, { apiKey: 'k1', secretKey: new Uint8Array(32) });
  return { venues, created, enroll };
}

describe('AgentVenues', () => {
  afterEach(() => jest.useRealTimers());

  it('gives Kuru signed by the agent wallet, and no Perpl before enrollment', async () => {
    const h = harness();
    const set = await h.venues.forAgent(AGENT);

    expect(set.kuru).toBeInstanceOf(KuruVenue);
    expect(set.perpl).toBeUndefined();
    expect('perpl' in set).toBe(false);
    expect((await h.venues.forAgent(AGENT)).kuru).toBe(set.kuru);
  });

  it('builds the Perpl venue once from the stored credentials and reuses it', async () => {
    const h = harness();
    await h.enroll();
    const first = await h.venues.forAgent(AGENT);
    const second = await h.venues.forAgent(AGENT);

    expect(first.perpl).toBeDefined();
    expect(second.perpl).toBe(first.perpl);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.credentials.apiKey).toBe('k1');
  });

  it('closes the Perpl socket after the idle period, and use pushes it back', async () => {
    jest.useFakeTimers();
    const h = harness();
    await h.enroll();
    await h.venues.forAgent(AGENT);

    jest.advanceTimersByTime(IDLE_MS - 1);
    await h.venues.forAgent(AGENT); // touch
    jest.advanceTimersByTime(IDLE_MS - 1);
    expect(h.created[0]!.close).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(h.created[0]!.close).toHaveBeenCalledTimes(1);
    expect(h.venues.size).toBe(0);

    await h.venues.forAgent(AGENT); // a fresh socket next time
    expect(h.created).toHaveLength(2);
  });

  it('closes at once on release (revocation) and on shutdown', async () => {
    const h = harness();
    await h.enroll();
    await h.venues.forAgent(AGENT);
    h.venues.release(AGENT.agentId);
    expect(h.created[0]!.close).toHaveBeenCalledTimes(1);

    await h.venues.forAgent(AGENT);
    h.venues.onModuleDestroy();
    expect(h.created[1]!.close).toHaveBeenCalledTimes(1);
    expect(h.venues.size).toBe(0);
  });

  it('rebuilds when the agent is bound to a different wallet', async () => {
    const h = harness();
    await h.enroll();
    const before = await h.venues.forAgent(AGENT);
    const after = await h.venues.forAgent({ ...AGENT, walletId: 'wallet-2' });

    expect(after.kuru).not.toBe(before.kuru);
    expect(h.created[0]!.close).toHaveBeenCalledTimes(1);
  });
});

/**
 * SEN-148: a real PerplAgentAccounts over a fake Perpl API and a fake Privy
 * signer, so single-flight and the stored key are the production code's.
 */
describe('AgentVenues on-demand Perpl enrollment', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sente-venues-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function enrolling(options: { secrets?: AgentSecretStore; retryMs?: number } = {}) {
    const perpl = perplEnrollFake();
    const secrets = options.secrets ?? new InMemoryAgentSecretStore();
    const warnings: string[] = [];
    let now = 1_000_000;
    const signed: string[] = [];
    const wallets = {
      signTypedData: async (walletId: string) => {
        await new Promise((resolve) => setImmediate(resolve));
        signed.push(walletId);
        return `0x${'ab'.repeat(65)}` as Hex;
      },
    } as unknown as AgentWalletProvider;
    const sender = new AgentTransactionSender({ wallets, chain: {} as AgentChainClient });
    const accounts = new PerplAgentAccounts({
      sender,
      wallets,
      secrets,
      accountOf: () => Promise.resolve(493n),
      fetchImpl: perpl.fetchImpl,
    });
    const created: PerplCredentials[] = [];
    const venues = new AgentVenues({
      publicClient: {} as PublicClient,
      sender,
      secrets,
      perplAccounts: accounts,
      enrollRetryMs: options.retryMs ?? 60_000,
      now: () => now,
      logger: { warn: (message) => warnings.push(message) },
      createPerplVenue: (credentials) => {
        created.push(credentials);
        return { close: jest.fn() } as unknown as PerplVenue;
      },
    });
    return {
      perpl,
      secrets,
      venues,
      warnings,
      signed,
      created,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('enrolls once when a run and a portfolio read need Perpl at the same time', async () => {
    const h = enrolling();
    const [run, again, read] = await Promise.all([
      h.venues.forAgent(AGENT, { enrollPerpl: true }),
      h.venues.forAgent(AGENT, { enrollPerpl: true }),
      h.venues.readPerpl(AGENT, (perpl) => Promise.resolve(perpl), { enrollPerpl: true }),
    ]);

    expect(h.perpl.enrollments).toBe(1);
    expect(h.signed).toEqual([AGENT.walletId]);
    expect(run.perpl).toBeDefined();
    expect(again.perpl).toBe(run.perpl);
    expect(read).toBeDefined();
    expect((await h.secrets.getPerplCredentials(AGENT.agentId))?.apiKey).toBe('key-1');
  });

  it('never enrolls for a caller that does not ask (Perpl not in the mandate)', async () => {
    const h = enrolling();
    const set = await h.venues.forAgent(AGENT);
    const read = await h.venues.readPerpl(AGENT, (perpl, why) => Promise.resolve({ perpl, why }));

    expect(set.perpl).toBeUndefined();
    expect(read).toEqual({ perpl: undefined, why: undefined });
    expect(h.perpl.enrollments).toBe(0);
  });

  it('reuses the stored key after a restart instead of enrolling again', async () => {
    const path = join(dir, 'agent-secrets.json');
    const key = Buffer.alloc(32, 3);
    const before = enrolling({ secrets: new FileAgentSecretStore(path, key) });
    await before.venues.forAgent(AGENT, { enrollPerpl: true });
    expect(before.perpl.enrollments).toBe(1);

    const after = enrolling({ secrets: new FileAgentSecretStore(path, key) });
    const set = await after.venues.forAgent(AGENT, { enrollPerpl: true });
    expect(after.perpl.enrollments).toBe(0);
    expect(set.perpl).toBeDefined();
    expect(after.created[0]?.apiKey).toBe('key-1');
  });

  it('reports a failed enrollment as a reason and does not retry it on every poll', async () => {
    const h = enrolling({ retryMs: 60_000 });
    h.perpl.failStatus = 423;
    const read = () =>
      h.venues.readPerpl(AGENT, (perpl, why) => Promise.resolve({ perpl, why }), {
        enrollPerpl: true,
      });

    const first = await read();
    expect(first.perpl).toBeUndefined();
    expect(first.why).toMatch(/Perpl enrollment failed: .*423.*16 active keys/);
    for (let i = 0; i < 5; i += 1) await read();
    const set = await h.venues.forAgent(AGENT, { enrollPerpl: true });
    expect(set.perplUnavailable).toBe(first.why);
    expect(h.perpl.enrollments).toBe(1);
    expect(h.warnings).toHaveLength(1);

    h.perpl.failStatus = undefined;
    h.advance(60_000);
    expect((await read()).perpl).toBeDefined();
    expect(h.perpl.enrollments).toBe(2);
  });

  it('logs nothing secret', async () => {
    const h = enrolling();
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => inspect(arg, { depth: 6 })).join(' '));
      }),
    );
    try {
      const set = await h.venues.forAgent(AGENT, { enrollPerpl: true });
      const held = (await h.secrets.getPerplCredentials(AGENT.agentId))!;
      console.log('venues', set, held, { context: held });
      logged.push(...h.warnings);

      const secretHex = Buffer.from(held.secretKey).toString('hex');
      const secretList = Array.from(held.secretKey).join(', ');
      for (const line of logged) {
        expect(line).not.toContain('key-1');
        expect(line).not.toContain(secretHex);
        expect(line).not.toContain(secretList);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
