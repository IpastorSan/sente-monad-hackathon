import { compileMandate, parseMandate, type PolicyRule } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';

import { UnconfiguredAgentWalletProvider } from '../agent-wallet.provider';
import { AgentWalletsUnconfiguredError, EnclaveRefusedError } from '../agents.errors';
import { privyTransaction } from './agent-wallet';
import { generateAuthorizationKey } from './authorization-key';
import { PrivyAgentWalletProvider } from './privy-agent-wallet.provider';
import { PrivyClient, PrivyError } from './privy.client';
import {
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  fakePrivy,
  signatureVerifies,
  type CapturedRequest,
} from './testing/fake-privy';

const agentKey = generateAuthorizationKey();
const mandateOwnerKey = generateAuthorizationKey();

/** A real compiled mandate — also proves `@sente/mandate` loads under jest. */
const RULES: PolicyRule[] = compileMandate(
  parseMandate({
    version: 1,
    chainId: 10143,
    expiresAt: 2_000_000_000,
    venues: ['kuru'],
    kuru: {
      markets: [KURU_TESTNET_MARKETS[0]!.address],
      maxDepositAtoms: { [KURU_TESTNET_TOKENS.USDC.address]: '10000000' },
    },
    perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
    maxOrderNotional: '10',
  }),
);

const TX = privyTransaction({
  to: '0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22',
  data: '0x47e7ef24',
  chainId: 10143,
  nonce: 0,
  gas: 252_059n,
  maxFeePerGas: 102_000_000_000n,
  maxPriorityFeePerGas: 0n,
});

function setup(
  options: {
    handle?: Parameters<typeof fakePrivy>[0];
    agentQuorumId?: string;
    mandateQuorumId?: string;
  } = {},
) {
  const fake = fakePrivy(options.handle);
  const created: unknown[] = [];
  const provider = new PrivyAgentWalletProvider({
    client: new PrivyClient({ appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET, fetch: fake.fetch }),
    agentKey,
    mandateOwnerKey,
    agentQuorumId: options.agentQuorumId,
    mandateQuorumId: options.mandateQuorumId,
    onQuorumsCreated: (ids) => created.push(ids),
  });
  return { provider, calls: fake.calls, created };
}

/** Which of our two keys produced this request's single signature? */
function signedBy(call: CapturedRequest): 'agent' | 'owner' | 'none' | 'other' {
  const signature = call.headers['privy-authorization-signature'];
  if (!signature) return 'none';
  const payload = {
    version: 1,
    method: call.method as 'POST' | 'PATCH',
    url: call.url,
    body: call.body ?? {},
    headers: { 'privy-app-id': FAKE_APP_ID },
  } as const;
  if (signatureVerifies(agentKey.publicKey, payload, signature)) return 'agent';
  if (signatureVerifies(mandateOwnerKey.publicKey, payload, signature)) return 'owner';
  return 'other';
}

describe('PrivyAgentWalletProvider', () => {
  it('compiles to Privy rules the way the probe will send them', () => {
    // Sanity: the fixture is a real policy, not an empty one.
    expect(RULES.length).toBeGreaterThan(0);
    expect(RULES.every((rule) => rule.action === 'ALLOW')).toBe(true);
  });

  it('provisions: agent quorum owns the wallet, mandate-owner quorum owns the policy', async () => {
    const { provider, calls, created } = setup();
    const wallet = await provider.provision({ rules: RULES, displayName: 'agent-1' });

    const [agentQuorum, ownerQuorum, policy, walletCall] = calls;
    expect(agentQuorum!.body).toMatchObject({ public_keys: [agentKey.publicKey] });
    expect(ownerQuorum!.body).toMatchObject({ public_keys: [mandateOwnerKey.publicKey] });
    expect(policy!.body).toMatchObject({ owner_id: 'kq2', rules: RULES, chain_type: 'ethereum' });
    expect(walletCall!.body).toMatchObject({ owner_id: 'kq1', policy_ids: ['pol3'] });
    // Creation needs no owner signature; only mutations of owned resources do.
    expect(calls.map(signedBy)).toEqual(['none', 'none', 'none', 'none']);

    expect(wallet).toEqual({
      walletId: 'w4',
      address: '0x3De96375140717193f52c220Df5Ec460971cbE84',
      policyId: 'pol3',
    });
    expect(created).toEqual([{ agentQuorumId: 'kq1', mandateQuorumId: 'kq2' }]);
  });

  it('creates the quorums once, and reuses pinned ones without creating any', async () => {
    const fresh = setup();
    await fresh.provider.provision({ rules: RULES, displayName: 'a' });
    await fresh.provider.provision({ rules: RULES, displayName: 'b' });
    const quorumCalls = fresh.calls.filter((c) => c.url.endsWith('/v1/key_quorums'));
    expect(quorumCalls).toHaveLength(2);

    const pinned = setup({ agentQuorumId: 'kq-a', mandateQuorumId: 'kq-m' });
    await pinned.provider.provision({ rules: RULES, displayName: 'c' });
    expect(pinned.calls.some((c) => c.url.endsWith('/v1/key_quorums'))).toBe(false);
    expect(pinned.created).toEqual([]);
  });

  it('signs transactions with the agent key, never the mandate-owner key', async () => {
    const { provider, calls } = setup();
    await expect(provider.signTransaction('w1', TX)).resolves.toBe('0x02f8signed');
    expect(signedBy(calls[0]!)).toBe('agent');
    expect(calls[0]!.body).toEqual({ method: 'eth_signTransaction', params: { transaction: TX } });
  });

  it('updates a policy with the mandate-owner key, never the agent key', async () => {
    const { provider, calls } = setup();
    await provider.updatePolicy('pol-9', RULES);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toBe('https://api.privy.io/v1/policies/pol-9');
    expect(calls[0]!.body).toEqual({ rules: RULES });
    expect(signedBy(calls[0]!)).toBe('owner');
  });

  it('maps a Privy 400 policy_violation to EnclaveRefusedError', async () => {
    const { provider } = setup({
      handle: () => ({
        status: 400,
        body: { code: 'policy_violation', error: 'Policy violation' },
      }),
    });
    const error = await provider.signTransaction('w1', TX).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnclaveRefusedError);
    expect(error).toMatchObject({
      reason: 'policy_violation',
      walletId: 'w1',
      method: 'eth_signTransaction',
      detail: 'Policy violation',
    });

    const typed = await provider
      .signTypedData('w1', {
        domain: { name: 'x', chainId: 10143 },
        types: { T: [{ name: 'a', type: 'string' }] },
        primaryType: 'T',
        message: { a: 'b' },
      })
      .catch((e: unknown) => e);
    expect(typed).toBeInstanceOf(EnclaveRefusedError);
    expect((typed as EnclaveRefusedError).method).toBe('eth_signTypedData_v4');
  });

  it('does not dress up other failures as a refusal', async () => {
    // A 401 is "nobody approved", a 400 without policy_violation is a bad
    // request: neither is the mandate saying no.
    for (const reply of [
      { status: 401, body: { error: 'Missing privy-authorization-signature header' } },
      { status: 400, body: { code: 'invalid_data', error: 'bad' } },
    ]) {
      const { provider } = setup({ handle: () => reply });
      const error = await provider.signTransaction('w1', TX).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PrivyError);
      expect(error).not.toBeInstanceOf(EnclaveRefusedError);
    }
  });

  it('serialises signing per wallet, so a rolling cap cannot be raced', async () => {
    const events: string[] = [];
    const release: Array<() => void> = [];
    const fake = fakePrivy();
    const slowFetch = ((url: string | URL | Request, init?: RequestInit) => {
      const nonce = (
        JSON.parse(init!.body as string) as { params: { transaction: { nonce: number } } }
      ).params.transaction.nonce;
      events.push(`start ${nonce}`);
      return new Promise<void>((resolve) => release.push(resolve)).then(() => {
        events.push(`end ${nonce}`);
        return fake.fetch(url, init);
      });
    }) as typeof globalThis.fetch;
    const provider = new PrivyAgentWalletProvider({
      client: new PrivyClient({ appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET, fetch: slowFetch }),
      agentKey,
      mandateOwnerKey,
    });

    const first = provider.signTransaction('w1', { ...TX, nonce: 0 });
    const second = provider.signTransaction('w1', { ...TX, nonce: 1 });
    const otherWallet = provider.signTransaction('w2', { ...TX, nonce: 7 });
    await new Promise((resolve) => setImmediate(resolve));
    // w1's second sign has not started; a different wallet is not held up.
    expect(events).toEqual(['start 0', 'start 7']);

    release.shift()!();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['start 0', 'start 7', 'end 0', 'start 1']);

    release.splice(0).forEach((go) => go());
    await Promise.all([second, otherWallet]);
  });

  it('a refused sign does not wedge the wallet for the next one', async () => {
    let refuse = true;
    const { provider } = setup({
      handle: () => (refuse ? { status: 400, body: { code: 'policy_violation' } } : undefined),
    });
    await expect(provider.signTransaction('w1', TX)).rejects.toBeInstanceOf(EnclaveRefusedError);
    refuse = false;
    await expect(provider.signTransaction('w1', TX)).resolves.toBe('0x02f8signed');
  });
});

describe('UnconfiguredAgentWalletProvider', () => {
  it('refuses every operation, typed', async () => {
    const provider = new UnconfiguredAgentWalletProvider();
    await expect(provider.provision()).rejects.toBeInstanceOf(AgentWalletsUnconfiguredError);
    await expect(provider.signTransaction()).rejects.toMatchObject({
      reason: 'agent_wallets_unconfigured',
    });
  });
});
