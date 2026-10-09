/**
 * A Perpl agent's world for the SEN-187 specs: the REAL `PerplAgentAccounts`,
 * `AgentTransactionSender` and `AgentPerplOnboarder`, over
 *
 * - an enclave that signs only what the agent's compiled mandate allows —
 *   `compileMandate` (the real compiler) evaluated by the fake enclave's
 *   `allows`, the oracle `demo/policy.property.spec.ts` checks the compiler
 *   against — and refuses everything else with `EnclaveRefusedError`;
 * - a chain that moves AUSD and MON the way the three onboarding legs do:
 *   gas charged at the LIMIT (gotcha 4), the approve setting the allowance,
 *   `createAccount` pulling it into a new account;
 * - Perpl's REST API: `/v1/pub/context` (minimum 100 AUSD) and enrollment.
 */
import { compileMandate, type PolicyRule } from '@sente/mandate';
import {
  ERC20_APPROVE_ABI,
  PERPL_EXCHANGE_ABI,
  PERPL_TESTNET_CONTRACTS,
  type PerplContext,
} from '@sente/venues/perpl';
import { decodeFunctionData, isAddressEqual, type Address, type Hex } from 'viem';

import type { AgentWalletProvider } from '../../agent-wallet.provider';
import { EnclaveRefusedError } from '../../agents.errors';
import { allows } from '../../demo/testing/fake-enclave';
import { InMemoryAgentEventLog } from '../../events/agent-event-log';
import type { PrivyTransactionRequest } from '../../privy/agent-wallet';
import { InMemoryAgentStore, type AgentRecord } from '../../store/agent-store';
import { NOW, testAgent } from '../../tools/testing/agent-fixture';
import { InMemoryAgentSecretStore } from '../agent-secret-store';
import { AgentTransactionSender, type AgentChainClient } from '../agent-transactions';
import { PerplAgentAccounts } from '../perpl-agent';
import { AgentPerplOnboarder, type AgentPerplOnboarderOptions } from '../perpl-onboarding';
import { perplEnrollFake } from './perpl-enroll-fake';

export const AUSD = (n: number) => BigInt(Math.round(n * 1e6));
export const MON = (n: number) => BigInt(Math.round(n * 1e18));
/** 100 gwei, about what Monad testnet bids. */
export const FEE = 100_000_000_000n;
export const MINIMUM = AUSD(100);

const { exchange, collateral } = PERPL_TESTNET_CONTRACTS;

const CONTEXT = {
  chain: { chain_id: 10143 },
  instances: [
    {
      id: 1,
      address: exchange,
      collateral_token_id: 1,
      min_account_open_amount: MINIMUM.toString(),
      min_deposit_amount: '10000000',
      min_withdraw_amount: '10000',
    },
  ],
  tokens: [
    { id: 1, address: collateral, symbol: 'AUSD', name: 'AUSD', decimals: 6, display_precision: 2 },
  ],
  markets: [],
} as unknown as PerplContext;

export interface WorldOptions {
  /** Collateral cap, in AUSD. Default 500 (the test mandate's). */
  cap?: number;
  ausd?: number;
  mon?: number;
  /** An account that already exists (opened by a script, or a run that died). */
  accountId?: bigint;
  /** AUSD already approved to the Exchange. */
  allowance?: number;
  /** 1-based index of the broadcast that reverts. */
  revert?: number;
  agent?: Partial<AgentRecord>;
  onboarder?: Partial<AgentPerplOnboarderOptions>;
}

export async function perplOnboardingWorld(options: WorldOptions = {}) {
  const base = testAgent();
  const agent = testAgent({
    mandate: {
      ...base.mandate,
      perpl: { ...base.mandate.perpl, maxCollateralAtoms: AUSD(options.cap ?? 500) },
    },
    ...options.agent,
  });
  const rules: PolicyRule[] = compileMandate(agent.mandate);

  const state = {
    ausd: AUSD(options.ausd ?? 0),
    mon: MON(options.mon ?? 0.15),
    allowance: AUSD(options.allowance ?? 0),
    accountId: options.accountId ?? (null as bigint | null),
    accountBalance: options.accountId !== undefined ? AUSD(100) : 0n,
  };
  /** Every transaction the enclave signed, in order. */
  const signed: PrivyTransactionRequest[] = [];
  /** Every transaction the enclave refused. */
  const refused: PrivyTransactionRequest[] = [];
  let broadcasts = 0;

  const wallets: AgentWalletProvider = {
    name: 'policy-enforcing fake',
    provision: () => Promise.reject(new Error('unused')),
    updatePolicy: () => Promise.reject(new Error('unused')),
    preparePolicyUpdate: () => Promise.reject(new Error('unused')),
    commitPrepared: () => Promise.reject(new Error('unused')),
    signTransaction: (walletId, tx) => {
      if (!allows(rules, tx, NOW)) {
        refused.push(tx);
        return Promise.reject(new EnclaveRefusedError({ walletId, method: 'eth_signTransaction' }));
      }
      signed.push(tx);
      return Promise.resolve(`0x02${signed.length.toString(16)}` as Hex);
    },
    // The fake enclave refuses typed data; the enrollment fake stands in for
    // the signature (enrollment's own rule is pinned by the mandate specs).
    signTypedData: () => Promise.resolve(`0x${'ab'.repeat(65)}` as Hex),
  };

  const chain: AgentChainClient = {
    pendingNonce: () => Promise.resolve(broadcasts),
    fees: () => Promise.resolve({ maxFeePerGas: FEE, maxPriorityFeePerGas: 1n }),
    sendRawTransaction: () =>
      Promise.resolve(`0x${(++broadcasts).toString(16).padStart(64, '0')}` as Hex),
    waitForReceipt: (hash) => {
      const tx = signed[signed.length - 1]!;
      state.mon -= BigInt(tx.gas_limit!) * FEE; // charged at the limit, reverted or not
      const success = broadcasts !== options.revert;
      if (success) apply(tx);
      return Promise.resolve({
        transactionHash: hash,
        success,
        logs: [],
        blockNumber: 74_000_000n + BigInt(broadcasts),
      });
    },
  };

  function apply(tx: PrivyTransactionRequest): void {
    const data = tx.data as Hex;
    if (isAddressEqual(tx.to as Address, collateral)) {
      const { args } = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data });
      state.allowance = args[1];
      return;
    }
    const call = decodeFunctionData({ abi: PERPL_EXCHANGE_ABI, data });
    if (call.functionName === 'createAccount') {
      const amount = call.args[0];
      if (state.allowance < amount || state.ausd < amount) throw new Error('transferFrom reverts');
      state.allowance -= amount;
      state.ausd -= amount;
      state.accountId = 493n;
      state.accountBalance = amount;
    }
  }

  const enroll = perplEnrollFake();
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith('/v1/pub/context')
      ? Promise.resolve(new Response(JSON.stringify(CONTEXT)))
      : enroll.fetchImpl(input, init)) as typeof fetch;

  const secrets = new InMemoryAgentSecretStore();
  const sender = new AgentTransactionSender({ wallets, chain });
  const accounts = new PerplAgentAccounts({
    sender,
    wallets,
    secrets,
    accountOf: () => Promise.resolve(state.accountId),
    allowanceOf: () => Promise.resolve(state.allowance),
    fetchImpl,
  });
  const events = new InMemoryAgentEventLog();
  const store = new InMemoryAgentStore();
  await store.insert(agent);
  let now = 1_000_000;

  const onboarder = new AgentPerplOnboarder({
    accounts,
    secrets,
    chain: {
      account: () =>
        Promise.resolve(
          state.accountId === null
            ? null
            : { accountId: state.accountId, balance: state.accountBalance, locked: 0n },
        ),
      collateralBalance: () => Promise.resolve(state.ausd),
      nativeBalance: () => Promise.resolve(state.mon),
      maxFeePerGas: () => Promise.resolve(FEE),
    },
    events,
    agents: store,
    minimum: () => Promise.resolve(MINIMUM),
    now: () => now,
    sleep: () => Promise.resolve(),
    ...options.onboarder,
  });

  return {
    agent,
    rules,
    state,
    signed,
    refused,
    enroll,
    secrets,
    events,
    store,
    accounts,
    sender,
    onboarder,
    /** What each signed call was, by selector. */
    selectors: () => signed.map((tx) => tx.data?.slice(0, 10)),
    onboardingEvents: async () =>
      (await events.list(agent.id, { kind: 'onboarding' })).map((e) => e.detail),
    advance: (ms: number) => {
      now += ms;
    },
    get broadcasts() {
      return broadcasts;
    },
  };
}

export type PerplOnboardingWorld = Awaited<ReturnType<typeof perplOnboardingWorld>>;

/** The approve's and createAccount's amounts, decoded from what was signed. */
export function amountsOf(signed: readonly PrivyTransactionRequest[]): {
  approve?: bigint;
  createAccount?: bigint;
} {
  const out: { approve?: bigint; createAccount?: bigint } = {};
  for (const tx of signed) {
    const data = tx.data as Hex;
    if (isAddressEqual(tx.to as Address, collateral)) {
      out.approve = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data }).args[1];
    } else {
      const call = decodeFunctionData({ abi: PERPL_EXCHANGE_ABI, data });
      if (call.functionName === 'createAccount') out.createAccount = call.args[0];
    }
  }
  return out;
}
