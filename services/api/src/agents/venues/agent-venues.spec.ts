import { KuruVenue } from '@sente/venues/kuru';
import type { PerplCredentials, PerplVenue } from '@sente/venues/perpl';
import { getAddress, type PublicClient } from 'viem';

import type { AgentWalletProvider } from '../agent-wallet.provider';
import { InMemoryAgentSecretStore } from './agent-secret-store';
import { AgentTransactionSender, type AgentChainClient } from './agent-transactions';
import { AgentVenues } from './agent-venues';

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
