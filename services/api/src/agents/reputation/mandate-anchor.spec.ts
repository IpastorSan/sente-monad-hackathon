/**
 * SEN-194: the mandate anchored on chain through the agent's ERC-8004 identity.
 *
 * The registry is a fake (`FakeErc8004Client`); the canonicalizer, the hashes
 * and the policy compiler are the real ones, and the policy hash is checked
 * against the rules the fake wallet provider actually holds — what the enclave
 * would enforce.
 */
import { mandateHash, parseMandate, policyHash } from '@sente/mandate';
import type { Hash } from 'viem';

import { AgentsService } from '../agents.service';
import { toAgentResponse } from '../dto/agent.dto';
import { InMemoryAgentEventLog, type AgentEvent } from '../events/agent-event-log';
import { ServerMandateOwners } from '../mandate-owner';
import { InMemoryAgentStore, type AgentRecord } from '../store/agent-store';
import { FakeAgentWalletProvider } from '../testing/fake-agent-wallet.provider';
import { testAgent, testMandateInput } from '../tools/testing/agent-fixture';
import { ERC8004_IDENTITY_REGISTRY, Erc8004Reputation } from './erc8004';
import {
  ANCHOR_RETRY_DELAYS_MS,
  decodeMandateAnchor,
  desiredAnchor,
  encodeMandateAnchor,
  MANDATE_METADATA_KEY,
  MandateAnchors,
  type AnchorEventDetail,
} from './mandate-anchor';
import { FakeErc8004Client } from './testing/fake-erc8004-client';

const ALICE = { userId: 'alice' };
const REGISTER_TX = `0x${'ab'.repeat(32)}`;

function hireInput(mandate: Record<string, unknown> = testMandateInput()) {
  return {
    name: 'Momentum',
    systemPrompt: 'Trade carefully.',
    strategy: 'Buy strength.',
    model: 'anthropic/claude-sonnet-5',
    mandate,
  };
}

function world(options: { anchors?: boolean } = {}) {
  const store = new InMemoryAgentStore();
  const wallets = new FakeAgentWalletProvider();
  const client = new FakeErc8004Client();
  const events = new InMemoryAgentEventLog();
  const retries: { run: () => void; delayMs: number }[] = [];
  const reputation = new Erc8004Reputation({
    client,
    agents: store,
    agentBaseUrl: 'https://sente.lol',
  });
  const anchors = new MandateAnchors({
    client,
    agents: store,
    events,
    schedule: (run, delayMs) => retries.push({ run, delayMs }),
  });
  const service = new AgentsService(
    store,
    wallets,
    new ServerMandateOwners(),
    undefined,
    reputation,
    undefined,
    undefined,
    undefined,
    undefined,
    options.anchors === false ? undefined : anchors,
  );
  const anchorEvents = async (id: string): Promise<AnchorEventDetail[]> =>
    (await events.list(id, { kind: 'anchor' })).map(
      (e: AgentEvent) => e.detail as unknown as AnchorEventDetail,
    );
  /** Runs every scheduled retry, then waits for the queue to drain. */
  const runRetries = async (): Promise<void> => {
    for (const retry of retries.splice(0)) retry.run();
    await anchors.whenIdle();
  };
  return { store, wallets, client, events, anchors, service, retries, anchorEvents, runRetries };
}

/** The policyHash of what the fake enclave holds for this agent right now. */
function livePolicyHash(wallets: FakeAgentWalletProvider, agent: AgentRecord): Hash {
  const rules = wallets.policies.get(agent.policyId);
  if (!rules) throw new Error(`no policy ${agent.policyId}`);
  return policyHash(rules);
}

describe('the anchor value', () => {
  it('is 66 packed bytes that decode back to what was encoded', () => {
    const want = desiredAnchor(testAgent());
    const value = encodeMandateAnchor(want);
    expect((value.length - 2) / 2).toBe(66);
    expect(value.slice(0, 6)).toBe('0x0101'); // version 1, status active
    expect(decodeMandateAnchor(value)).toEqual(want);
    const revoked = desiredAnchor(testAgent({ status: 'revoked' }));
    expect(encodeMandateAnchor(revoked).slice(0, 6)).toBe('0x0102');
    expect(decodeMandateAnchor(encodeMandateAnchor(revoked))).toEqual(revoked);
  });

  it('refuses to decode what is not an anchor', () => {
    expect(decodeMandateAnchor('0x')).toBeUndefined();
    const value = encodeMandateAnchor(desiredAnchor(testAgent()));
    expect(decodeMandateAnchor(`0x02${value.slice(4)}`)).toBeUndefined(); // version 2
    expect(decodeMandateAnchor(`0x0109${value.slice(6)}`)).toBeUndefined(); // status 9
    expect(decodeMandateAnchor(`${value}00`)).toBeUndefined();
  });
});

describe('anchoring at hire', () => {
  it('registers the identity with the mandate anchor in the same transaction', async () => {
    const w = world();
    const { agent } = await w.service.hire(ALICE, hireInput());

    expect(w.client.registrations).toHaveLength(1);
    const [entry] = w.client.registrationMetadata[0]!;
    expect(entry!.metadataKey).toBe(MANDATE_METADATA_KEY);
    const onChain = decodeMandateAnchor(entry!.metadataValue)!;
    // The hash anyone can recompute from the published mandate...
    expect(onChain.mandateHash).toBe(mandateHash(parseMandate(testMandateInput())));
    // ...and the hash of the rules the enclave holds — after the SEN-188 pin.
    expect(onChain.policyHash).toBe(livePolicyHash(w.wallets, agent));
    expect(onChain.status).toBe('active');
    expect(w.client.metadataWrites).toHaveLength(0);

    expect(agent.mandateAnchor).toEqual({
      mandateHash: onChain.mandateHash,
      policyHash: onChain.policyHash,
      status: 'active',
      txHash: REGISTER_TX,
      chainId: 10143,
      registry: ERC8004_IDENTITY_REGISTRY,
      agentTokenId: '1874',
      anchoredAt: expect.any(String) as string,
    });
    expect(await w.store.get(agent.id)).toMatchObject({ mandateAnchor: agent.mandateAnchor });
    expect(toAgentResponse(agent).mandateAnchor).toEqual(agent.mandateAnchor);

    await w.anchors.whenIdle();
    expect(w.client.metadataWrites).toHaveLength(0); // the catch-up sync found it current
    expect(await w.anchorEvents(agent.id)).toEqual([
      expect.objectContaining({
        status: 'anchored',
        message: 'Mandate anchored on chain',
        txHash: REGISTER_TX,
        agentTokenId: '1874',
      }),
    ]);
  });

  it('still hires when the registration fails, and says so on the Ledger', async () => {
    const w = world();
    w.client.registerError = new Error('insufficient funds for gas');

    const { agent } = await w.service.hire(ALICE, hireInput());

    expect(agent.status).toBe('active');
    expect(agent.erc8004AgentId).toBeUndefined();
    expect(agent.mandateAnchor).toBeUndefined();
    expect(toAgentResponse(agent)).not.toHaveProperty('mandateAnchor');
    const [event] = await w.anchorEvents(agent.id);
    expect(event).toMatchObject({ status: 'failed' });
    expect(event!.message).toContain('insufficient funds for gas');
  });

  it('registers exactly as before when anchoring is not wired', async () => {
    const w = world({ anchors: false });
    const { agent } = await w.service.hire(ALICE, hireInput());
    expect(agent.erc8004AgentId).toBe('1874');
    expect(w.client.registrationMetadata[0]).toEqual([]);
    expect(agent.mandateAnchor).toBeUndefined();
  });
});

describe('anchoring an amend and a revoke', () => {
  it('rewrites the anchor after an amend, in the background', async () => {
    const w = world();
    const { agent } = await w.service.hire(ALICE, hireInput());
    const before = agent.mandateAnchor!;

    const input = { ...testMandateInput(), maxOrderNotional: '100' };
    const amended = await w.service.amendMandate(ALICE, agent.id, input);
    await w.anchors.whenIdle();

    expect(w.client.metadataWrites).toHaveLength(1);
    const write = w.client.metadataWrites[0]!;
    expect(write.agentId).toBe(1874n);
    expect(write.entry.metadataKey).toBe(MANDATE_METADATA_KEY);
    const onChain = decodeMandateAnchor(write.entry.metadataValue)!;
    expect(onChain.mandateHash).toBe(mandateHash(parseMandate(input)));
    expect(onChain.mandateHash).not.toBe(before.mandateHash);
    expect(onChain.policyHash).toBe(livePolicyHash(w.wallets, amended));

    const stored = (await w.store.get(agent.id))!;
    expect(stored.mandateAnchor).toMatchObject({
      mandateHash: onChain.mandateHash,
      status: 'active',
      txHash: write.txHash,
    });
    expect((await w.anchorEvents(agent.id)).at(-1)).toMatchObject({
      status: 'anchored',
      message: 'Amended mandate anchored on chain',
      txHash: write.txHash,
    });
  });

  it('marks the anchor revoked, with the revocation policy', async () => {
    const w = world();
    const { agent } = await w.service.hire(ALICE, hireInput());

    const revoked = await w.service.revoke(ALICE, agent.id);
    await w.anchors.whenIdle();

    const onChain = decodeMandateAnchor(w.client.metadataWrites[0]!.entry.metadataValue)!;
    expect(onChain.status).toBe('revoked');
    expect(onChain.mandateHash).toBe(agent.mandateAnchor!.mandateHash);
    expect(onChain.policyHash).toBe(livePolicyHash(w.wallets, revoked));
    expect((await w.store.get(agent.id))!.mandateAnchor).toMatchObject({ status: 'revoked' });
    expect((await w.anchorEvents(agent.id)).at(-1)).toMatchObject({
      message: 'Revocation anchored on chain',
    });
  });

  it('never fails an amend for the anchor, and retries the write until it lands', async () => {
    const w = world();
    const { agent } = await w.service.hire(ALICE, hireInput());
    w.client.metadataErrors = [new Error('RPC is down'), new Error('nonce too low')];

    const input = { ...testMandateInput(), maxOrderNotional: '100' };
    const amended = await w.service.amendMandate(ALICE, agent.id, input);
    await w.anchors.whenIdle();

    expect(amended.mandate.maxOrderNotional).toBe('100');
    expect((await w.store.get(agent.id))!.mandateAnchor).toEqual(agent.mandateAnchor); // stale
    expect(w.retries.map((r) => r.delayMs)).toEqual([ANCHOR_RETRY_DELAYS_MS[0]]);
    expect((await w.anchorEvents(agent.id)).at(-1)).toMatchObject({ status: 'failed' });
    expect((await w.anchorEvents(agent.id)).at(-1)!.message).toContain('Retrying in 30 s');

    await w.runRetries(); // fails again
    expect(w.retries.map((r) => r.delayMs)).toEqual([ANCHOR_RETRY_DELAYS_MS[1]]);
    await w.runRetries(); // lands
    expect(w.retries).toHaveLength(0);
    expect(w.client.metadataWrites).toHaveLength(1);
    expect((await w.store.get(agent.id))!.mandateAnchor).toMatchObject({
      mandateHash: mandateHash(parseMandate(input)),
    });
  });

  it('gives up after the last retry, and the boot reconcile picks it up', async () => {
    const w = world();
    const { agent } = await w.service.hire(ALICE, hireInput());
    w.client.metadataErrors = ANCHOR_RETRY_DELAYS_MS.map(() => new Error('down')).concat(
      new Error('down'),
    );

    await w.service.revoke(ALICE, agent.id);
    await w.anchors.whenIdle();
    for (let i = 0; i < ANCHOR_RETRY_DELAYS_MS.length; i++) await w.runRetries();

    expect(w.retries).toHaveLength(0);
    expect((await w.anchorEvents(agent.id)).at(-1)!.message).toContain('next restart');
    expect((await w.store.get(agent.id))!.mandateAnchor!.status).toBe('active');

    await w.anchors.reconcile();
    expect(w.client.metadataWrites).toHaveLength(1);
    expect((await w.store.get(agent.id))!.mandateAnchor!.status).toBe('revoked');
    // Now current: a second reconcile sends nothing.
    await w.anchors.reconcile();
    expect(w.client.metadataWrites).toHaveLength(1);
  });

  it('anchors nothing for an agent with no on-chain identity', async () => {
    const w = world();
    w.client.registerError = new Error('down');
    const { agent } = await w.service.hire(ALICE, hireInput());
    w.client.registerError = undefined;

    await w.service.amendMandate(ALICE, agent.id, { ...testMandateInput(), maxOrderNotional: '1' });
    await w.anchors.whenIdle();
    await w.anchors.reconcile();

    expect(w.client.metadataWrites).toHaveLength(0);
    // A second register would mint a second agent: never retried.
    expect(w.client.registrations).toHaveLength(0);
  });
});
