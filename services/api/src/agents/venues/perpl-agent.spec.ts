import { PERPL_TESTNET_CONTRACTS, type PerplContext } from '@sente/venues/perpl';
import { getAddress, type Address, type Hex, type TypedDataDefinition } from 'viem';

import type { AgentWalletProvider } from '../agent-wallet.provider';
import { EnclaveRefusedError } from '../agents.errors';
import type { PrivyTransactionRequest } from '../privy/agent-wallet';
import { InMemoryAgentSecretStore } from './agent-secret-store';
import { AgentTransactionSender, type AgentChainClient } from './agent-transactions';
import {
  PERPL_ONBOARDING_GAS,
  PerplAgentAccounts,
  PerplNotOnboardedError,
  PerplOnboardingError,
} from './perpl-agent';

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

function payload(address: string) {
  return {
    typed_data: {
      types: {
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
          { name: 'time', type: 'uint64' },
        ],
      },
      primaryType: 'PerplRegisterApiKey',
      domain: {
        name: 'perpl.xyz',
        version: '1',
        chainId: '0x279f',
        verifyingContract: '0x0000000000000000000000000000000000000000',
        salt: '0x00000000000000000000000000000000000000006aa2f731368ca5c38d4d3fb0',
      },
      message: {
        signer: address,
        statement:
          'I authorize the creation of Perpl API key with the specified scope and parameters',
        publicKey: 'k',
        scope: '3',
        label: 'x',
        time: '0x1a08c959a61',
      },
    },
    mac: '0xmac',
  };
}

function harness(
  options: { accountId?: bigint | null; reverted?: number; refuseTypedData?: boolean } = {},
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
      if (success && broadcasts === 3) accountId = 493n;
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

  const secrets = new InMemoryAgentSecretStore();
  const accounts = new PerplAgentAccounts({
    sender: new AgentTransactionSender({ wallets, chain }),
    wallets,
    secrets,
    accountOf: (address: Address) => Promise.resolve(address === AGENT.address ? accountId : null),
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
    });
    expect(h.signedTxs).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
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
