/**
 * Step 3 of SEN-30: a hire adds the new agent's wallet to the Notify webhook,
 * and a hire SURVIVES that failing.
 *
 * The rule is `docs/alchemy.md`'s and `erc8004.spec.ts`'s alike — a third party
 * being down must cost a feature, never a wallet. So every case here asks the same
 * question: is the agent still `active` afterwards?
 */
import { Logger } from '@nestjs/common';

import { AgentsService } from '../agents/agents.service';
import { ServerMandateOwners } from '../agents/mandate-owner';
import { InMemoryAgentStore } from '../agents/store/agent-store';
import { FakeAgentWalletProvider } from '../agents/testing/fake-agent-wallet.provider';
import { testMandateInput } from '../agents/tools/testing/agent-fixture';
import { loadAlchemyConfig } from './alchemy.config';
import { AlchemyNotifyClient, type AlchemyNotifyAddresses } from './alchemy-notify';

const ALICE = { userId: 'alice' };

function hireInput() {
  return {
    name: 'Momentum',
    systemPrompt: 'Trade carefully.',
    strategy: 'Buy strength.',
    model: 'anthropic/claude-sonnet-5' as const,
    mandate: testMandateInput(),
  };
}

function setup(deposits?: AlchemyNotifyAddresses) {
  const store = new InMemoryAgentStore();
  const service = new AgentsService(
    store,
    new FakeAgentWalletProvider(),
    new ServerMandateOwners(),
    undefined,
    undefined,
    deposits,
  );
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  return { store, service };
}

describe('AgentsService.hire with the Alchemy Notify address list', () => {
  afterEach(() => jest.restoreAllMocks());

  it("asks Notify to watch the new agent's own wallet address", async () => {
    const watched: string[] = [];
    const { service } = setup({
      watchAddress: (address) => {
        watched.push(address);
        return Promise.resolve({ ok: true });
      },
    });

    const { agent } = await service.hire(ALICE, hireInput());

    // The agent's own EOA, checksummed as the record stores it — not the owner's.
    expect(watched).toEqual([agent.address]);
  });

  it('hires anyway when Notify refuses the registration', async () => {
    const { service } = setup({
      watchAddress: () =>
        Promise.resolve({ ok: false, reason: 'notify_rejected', message: 'HTTP 403' }),
    });

    const { agent } = await service.hire(ALICE, hireInput());

    expect(agent.status).toBe('active');
  });

  it('hires anyway when Notify is unreachable, and when the client itself throws', async () => {
    for (const deposits of [
      { watchAddress: () => Promise.reject(new Error('ECONNRESET')) },
      {
        watchAddress: (): Promise<never> => {
          throw new Error('a bug in the client');
        },
      },
    ]) {
      const { service } = setup(deposits as AlchemyNotifyAddresses);
      const { agent } = await service.hire(ALICE, hireInput());
      expect(agent.status).toBe('active');
    }
  });

  it('hires anyway with the real client and no configuration — the default state today', async () => {
    // The client is always constructible: unconfigured refuses rather than being
    // absent, so there is one code path and one warning.
    const { service } = setup(new AlchemyNotifyClient(loadAlchemyConfig({})));

    const { agent } = await service.hire(ALICE, hireInput());

    expect(agent.status).toBe('active');
  });

  it('hires anyway when the webhook is not wired into the module at all', async () => {
    const { service } = setup();
    const { agent } = await service.hire(ALICE, hireInput());
    expect(agent.status).toBe('active');
  });
});
