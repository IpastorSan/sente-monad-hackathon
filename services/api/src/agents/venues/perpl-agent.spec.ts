import { PERPL_TESTNET_CONTRACTS, type PerplContext } from '@sente/venues/perpl';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TypedDataDefinition,
} from 'viem';

import type { AgentWalletProvider } from '../agent-wallet.provider';
import { EnclaveRefusedError } from '../agents.errors';
import type { PrivyTransactionRequest } from '../privy/agent-wallet';
import { InMemoryAgentSecretStore, type AgentSecretStore } from './agent-secret-store';
import { AgentTransactionSender, type AgentChainClient } from './agent-transactions';
import {
  PERPL_ONBOARDING_GAS,
  PerplAgentAccounts,
  PerplNotOnboardedError,
  PerplOnboardingError,
  perplAccountInfo,
  perplOnboardingGas,
} from './perpl-agent';
import { perplEnrollPayload as payload } from './testing/perpl-enroll-fake';

const AGENT = {
  agentId: 'agent-1',
  walletId: 'wallet-1',
  address: getAddress('0x3333333333333333333333333333333333333333'),
};
const { exchange, collateral } = PERPL_TESTNET_CONTRACTS;
const hex = (n: bigint) => `0x${n.toString(16)}`;

const CONTEXT = {
  chain: { chain_id: 10143 },
  instances: [
    {
      id: 1,
      address: exchange,
      collateral_token_id: 1,
      min_account_open_amount: '100000000',
      min_deposit_amount: '10000000',
      min_withdraw_amount: '10000',
    },
  ],
  tokens: [
    { id: 1, address: collateral, symbol: 'AUSD', name: 'AUSD', decimals: 6, display_precision: 2 },
  ],
  markets: [],
} as unknown as PerplContext;

function harness(
  options: {
    accountId?: bigint | null;
    reverted?: number;
    refuseTypedData?: boolean;
    secrets?: AgentSecretStore;
    /** AUSD already approved to the Exchange; absent, no allowance reader is wired. */
    allowance?: bigint;
  } = {},
) {
  let accountId = options.accountId ?? null;
  const signedTxs: PrivyTransactionRequest[] = [];
  const signedTyped: { walletId: string; typed: TypedDataDefinition }[] = [];
  const requests: string[] = [];
  let broadcasts = 0;
  let enrollments = 0;

  const wallets: AgentWalletProvider = {
    name: 'fake',
    provision: () => Promise.reject(new Error('unused')),
    updatePolicy: () => Promise.reject(new Error('unused')),
    preparePolicyUpdate: () => Promise.reject(new Error('unused')),
    commitPrepared: () => Promise.reject(new Error('unused')),
    signTransaction: (_walletId, tx) => {
      signedTxs.push(tx);
      return Promise.resolve(`0x02${signedTxs.length}` as Hex);
    },
    signTypedData: async (walletId, typed) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (options.refuseTypedData) {
        throw new EnclaveRefusedError({ walletId, method: 'eth_signTypedData_v4' });
      }
      signedTyped.push({ walletId, typed });
      return `0x${'ab'.repeat(65)}` as Hex;
    },
  };
  const chain: AgentChainClient = {
    pendingNonce: () => Promise.resolve(broadcasts),
    fees: () => Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    sendRawTransaction: () =>
      Promise.resolve(`0x${(++broadcasts).toString(16).padStart(64, '0')}` as Hex),
    waitForReceipt: (hash) => {
      const success = broadcasts !== options.reverted;
      const sent = signedTxs[signedTxs.length - 1]?.data ?? '';
      if (success && sent.startsWith('0xcab13915')) accountId = 493n;
      return Promise.resolve({
        transactionHash: hash,
        success,
        logs: [],
        blockNumber: 74_000_000n + BigInt(broadcasts),
      });
    },
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(new URL(url).pathname);
    if (url.endsWith('/v1/pub/context')) return new Response(JSON.stringify(CONTEXT));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/payload'))
      return new Response(JSON.stringify(payload(String(body['address']))));
    enrollments += 1;
    return new Response(
      JSON.stringify({
        api_key: {
          api_key: `key-${enrollments}`,
          address: body['address'],
          scope_mask: 3,
          label: 'x',
          origin: '',
          expires_at: 0,
          created_at: 0,
        },
      }),
    );
  }) as typeof fetch;

  const secrets = options.secrets ?? new InMemoryAgentSecretStore();
  const accounts = new PerplAgentAccounts({
    sender: new AgentTransactionSender({ wallets, chain }),
    wallets,
    secrets,
    accountOf: (address: Address) => Promise.resolve(address === AGENT.address ? accountId : null),
    ...(options.allowance !== undefined
      ? { allowanceOf: () => Promise.resolve(options.allowance!) }
      : {}),
    fetchImpl,
  });
  return {
    accounts,
    secrets,
    signedTxs,
    signedTyped,
    requests,
    get enrollments() {
      return enrollments;
    },
  };
}

describe('PerplAgentAccounts.onboard', () => {
  it('sends approve → createAccount → allowOrderForwarding as three fixed-gas transactions', async () => {
    const h = harness();
    const result = await h.accounts.onboard(AGENT);

    expect(result.accountId).toBe(493n);
    expect(result.onboarded).toBe(true);
    expect(result.transactions).toHaveLength(3);
    expect(h.signedTxs.map((tx) => tx.to)).toEqual([
      getAddress(collateral),
      getAddress(exchange),
      getAddress(exchange),
    ]);
    expect(h.signedTxs.map((tx) => tx.data?.slice(0, 10))).toEqual([
      '0x095ea7b3',
      '0xcab13915',
      '0x7962f910',
    ]);
    expect(h.signedTxs.map((tx) => tx.gas_limit)).toEqual([
      hex(PERPL_ONBOARDING_GAS.approve),
      hex(PERPL_ONBOARDING_GAS.createAccount),
      hex(PERPL_ONBOARDING_GAS.allowOrderForwarding),
    ]);
    expect(h.signedTxs.map((tx) => tx.nonce)).toEqual([0, 1, 2]);
  });

  it('is a no-op for an address that already has an account', async () => {
    const h = harness({ accountId: 77n });
    await expect(h.accounts.onboard(AGENT)).resolves.toEqual({
      accountId: 77n,
      onboarded: false,
      transactions: [],
      steps: [],
    });
    expect(h.signedTxs).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
  });

  it('opens with the amount asked for, and reports it', async () => {
    const h = harness();
    const result = await h.accounts.onboard(AGENT, 150_000_000n);
    expect(result).toMatchObject({
      onboarded: true,
      amount: 150_000_000n,
      steps: ['approve', 'createAccount', 'allowOrderForwarding'],
    });
  });

  it('resumes after a landed approve: no second approve when the allowance covers it (SEN-187)', async () => {
    const h = harness({ allowance: 100_000_000n });
    const result = await h.accounts.onboard(AGENT, 100_000_000n, { forwarding: null });
    expect(result.steps).toEqual(['createAccount', 'allowOrderForwarding']);
    expect(h.signedTxs.map((tx) => tx.data?.slice(0, 10))).toEqual(['0xcab13915', '0x7962f910']);
    expect(result.accountId).toBe(493n);
  });

  it('approves again when the allowance is short of the amount', async () => {
    const h = harness({ allowance: 99_999_999n });
    const result = await h.accounts.onboard(AGENT, 100_000_000n);
    expect(result.steps).toEqual(['approve', 'createAccount', 'allowOrderForwarding']);
  });

  it('resumes an account opened without forwarding: only the grant is sent (SEN-187)', async () => {
    const h = harness({ accountId: 77n });
    const result = await h.accounts.onboard(AGENT, undefined, { forwarding: false });
    expect(result).toMatchObject({
      accountId: 77n,
      onboarded: false,
      steps: ['allowOrderForwarding'],
    });
    expect(h.signedTxs.map((tx) => tx.data?.slice(0, 10))).toEqual(['0x7962f910']);
    expect(h.signedTxs[0]!.gas_limit).toBe(hex(PERPL_ONBOARDING_GAS.allowOrderForwarding));
  });

  it('lets beforeSend see the exact legs and their gas, and refuse them all', async () => {
    const h = harness();
    const seen: unknown[] = [];
    await expect(
      h.accounts.onboard(AGENT, undefined, {
        beforeSend: (plan) => {
          seen.push(plan);
          throw new Error('short of gas');
        },
      }),
    ).rejects.toThrow('short of gas');
    expect(seen).toEqual([
      {
        steps: ['approve', 'createAccount', 'allowOrderForwarding'],
        gas: perplOnboardingGas(['approve', 'createAccount', 'allowOrderForwarding']),
        accountId: null,
      },
    ]);
    expect(h.signedTxs).toHaveLength(0);
  });

  it('stops at a reverted createAccount and never signs the forwarding call', async () => {
    const h = harness({ reverted: 2 });
    await expect(h.accounts.onboard(AGENT)).rejects.toBeInstanceOf(PerplOnboardingError);
    expect(h.signedTxs).toHaveLength(2);
  });
});

describe('PerplAgentAccounts.credentials', () => {
  it('enrolls once through the agent wallet and reuses the stored key', async () => {
    const h = harness({ accountId: 493n });
    const first = await h.accounts.credentials(AGENT);
    const second = await h.accounts.credentials(AGENT);

    expect(h.enrollments).toBe(1);
    expect(first.apiKey).toBe('key-1');
    expect(second.apiKey).toBe('key-1');
    expect(first.secretKey).toHaveLength(32);
    expect(Buffer.from(second.secretKey)).toEqual(Buffer.from(first.secretKey));
    expect(h.signedTyped).toHaveLength(1);
    expect(h.signedTyped[0]!.walletId).toBe(AGENT.walletId);
    expect(h.signedTyped[0]!.typed.primaryType).toBe('PerplRegisterApiKey');
    expect((h.signedTyped[0]!.typed.message as Record<string, unknown>)['signer']).toBe(
      AGENT.address,
    );
    expect(await h.secrets.getPerplCredentials(AGENT.agentId)).toBeDefined();
  });

  it('shares one enrollment between concurrent callers', async () => {
    const h = harness({ accountId: 493n });
    const keys = await Promise.all([1, 2, 3].map(() => h.accounts.credentials(AGENT)));
    expect(h.enrollments).toBe(1);
    expect(new Set(keys.map((k) => k.apiKey))).toEqual(new Set(['key-1']));
  });

  it('does not enroll a second key for a caller that arrives as the first one finishes', async () => {
    // SEN-148: the store read used to sit outside the single flight, so a
    // caller whose read resolved before the key was stored enrolled again.
    // A store whose reads answer what it held when asked, but late: the second
    // caller asks mid-enrollment (nothing held) and hears back after the first
    // enrollment has stored its key and left the flight.
    const inner = new InMemoryAgentSecretStore();
    let slow = false;
    const secrets: AgentSecretStore = {
      getPerplCredentials: async (agentId) => {
        const held = await inner.getPerplCredentials(agentId);
        if (slow && !held) await new Promise((resolve) => setTimeout(resolve, 50));
        return held;
      },
      putPerplCredentials: (agentId, credentials) =>
        inner.putPerplCredentials(agentId, credentials),
      deleteAgent: (agentId) => inner.deleteAgent(agentId),
    };
    const h = harness({ accountId: 493n, secrets });
    const first = h.accounts.credentials(AGENT);
    await new Promise((resolve) => setImmediate(resolve));
    slow = true;
    const late = h.accounts.credentials(AGENT);
    const keys = await Promise.all([first, late]);
    expect(h.enrollments).toBe(1);
    expect(keys.map((k) => k.apiKey)).toEqual(['key-1', 'key-1']);
  });

  it('refuses to enroll an address with no Perpl account, before signing anything', async () => {
    const h = harness();
    await expect(h.accounts.credentials(AGENT)).rejects.toBeInstanceOf(PerplNotOnboardedError);
    expect(h.signedTyped).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
  });

  it('propagates an enclave refusal and stores nothing', async () => {
    const h = harness({ accountId: 493n, refuseTypedData: true });
    await expect(h.accounts.credentials(AGENT)).rejects.toBeInstanceOf(EnclaveRefusedError);
    expect(h.requests).toEqual(['/api/v1/api-key/payload']);
    expect(await h.secrets.getPerplCredentials(AGENT.agentId)).toBeUndefined();
  });
});

describe('perplAccountInfo (SEN-78)', () => {
  const client = (readContract: () => Promise<unknown>) =>
    ({ readContract }) as unknown as PublicClient;
  const reverted = () =>
    new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: [], functionName: 'getAccountByAddr' }),
      { abi: [], functionName: 'getAccountByAddr' },
    );

  it('reads the id, balance and locked balance off the account tuple', async () => {
    const read = client(() =>
      Promise.resolve({ accountId: 7n, balanceCNS: 150_000_000n, lockedBalanceCNS: 2_000_000n }),
    );
    await expect(perplAccountInfo(read, AGENT.address)).resolves.toEqual({
      accountId: 7n,
      balance: 150_000_000n,
      locked: 2_000_000n,
    });
  });

  it('is null for id 0 and for a revert, the two ways Perpl says "no account"', async () => {
    const zero = client(() =>
      Promise.resolve({ accountId: 0n, balanceCNS: 0n, lockedBalanceCNS: 0n }),
    );
    await expect(perplAccountInfo(zero, AGENT.address)).resolves.toBeNull();
    await expect(
      perplAccountInfo(
        client(() => Promise.reject(reverted())),
        AGENT.address,
      ),
    ).resolves.toBeNull();
  });

  it('throws an RPC failure instead of reporting it as no account', async () => {
    const down = client(() => Promise.reject(new Error('fetch failed')));
    await expect(perplAccountInfo(down, AGENT.address)).rejects.toThrow('fetch failed');
  });
});
