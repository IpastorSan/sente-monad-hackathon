import {
  cancelOrderCall,
  depositCalls,
  KURU_MEASURED_GAS,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  KuruExecutionError,
  KuruVenue,
  placeOrderCall,
  withdrawCall,
  type KuruCall,
} from '@sente/venues/kuru';
import { getAddress, type Address, type Hex, type PublicClient } from 'viem';

import type { AgentWalletProvider } from '../agent-wallet.provider';
import { EnclaveRefusedError } from '../agents.errors';
import type { PrivyTransactionRequest } from '../privy/agent-wallet';
import { AgentTransactionSender, type AgentChainClient } from './agent-transactions';
import {
  AGENT_APPROVE_GAS,
  kuruGasLimit,
  PrivyKuruSubmitter,
  UnmeasuredCallError,
} from './privy-kuru-submitter';

const AGENT: { walletId: string; address: Address } = {
  walletId: 'wallet-a',
  address: getAddress('0x1111111111111111111111111111111111111111'),
};
const OTHER = {
  walletId: 'wallet-b',
  address: getAddress('0x2222222222222222222222222222222222222222'),
};
const ACCOUNT_CORE = KURU_TESTNET_CONTRACTS.accountCore;
const USDC = KURU_TESTNET_TOKENS.USDC;
const MON = KURU_TESTNET_TOKENS.MON;
const MARKET = KURU_TESTNET_MARKETS[0]!.address;
const FEES = { maxFeePerGas: 102_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };
const HEX = /^0x[0-9a-f]+$/;

const hashOf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/** Fake Monad RPC plus fake enclave, sharing one "work in flight" counter per wallet. */
function harness(options: { reverted?: number[]; refuseAt?: number; laggingNonce?: boolean } = {}) {
  const signed: { walletId: string; tx: PrivyTransactionRequest }[] = [];
  const broadcast: Hex[] = [];
  const active = new Map<string, number>();
  let maxActivePerWallet = 0;
  let maxActiveTotal = 0;
  const walletOfHash = new Map<Hex, string>();
  const nonces = new Map<string, number>();
  const refusal = new EnclaveRefusedError({
    walletId: AGENT.walletId,
    method: 'eth_signTransaction',
    detail: 'Policy violation',
  });

  const bump = (walletId: string, delta: number) => {
    active.set(walletId, (active.get(walletId) ?? 0) + delta);
    maxActivePerWallet = Math.max(maxActivePerWallet, active.get(walletId)!);
    maxActiveTotal = Math.max(
      maxActiveTotal,
      [...active.values()].reduce((a, b) => a + b, 0),
    );
  };

  const wallets: AgentWalletProvider = {
    name: 'fake',
    provision: () => Promise.reject(new Error('unused')),
    updatePolicy: () => Promise.reject(new Error('unused')),
    signTypedData: () => Promise.reject(new Error('unused')),
    signTransaction: async (walletId, tx) => {
      bump(walletId, 1);
      await new Promise((resolve) => setImmediate(resolve));
      if (signed.length === options.refuseAt) {
        bump(walletId, -1);
        throw refusal;
      }
      signed.push({ walletId, tx });
      return `0x02${signed.length.toString(16).padStart(4, '0')}${walletId}` as Hex;
    },
  };

  const chain: AgentChainClient = {
    pendingNonce: (address) => {
      const walletId = address === AGENT.address ? AGENT.walletId : OTHER.walletId;
      // A lagging RPC keeps reporting the first nonce.
      return Promise.resolve(options.laggingNonce ? 7 : 7 + (nonces.get(walletId) ?? 0));
    },
    fees: () => Promise.resolve(FEES),
    sendRawTransaction: (raw) => {
      broadcast.push(raw);
      const hash = hashOf(broadcast.length);
      const walletId = raw.endsWith(AGENT.walletId) ? AGENT.walletId : OTHER.walletId;
      walletOfHash.set(hash, walletId);
      nonces.set(walletId, (nonces.get(walletId) ?? 0) + 1);
      return Promise.resolve(hash);
    },
    waitForReceipt: async (hash) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      bump(walletOfHash.get(hash)!, -1);
      const n = broadcast.length;
      return {
        transactionHash: hash,
        success: !(options.reverted ?? []).includes(n),
        logs: [{ address: MARKET, topics: [], data: `0x${n.toString(16).padStart(2, '0')}` }],
      };
    },
  };

  const sender = new AgentTransactionSender({ wallets, chain });
  return {
    sender,
    signed,
    broadcast,
    refusal,
    submitter: (wallet = AGENT) => new PrivyKuruSubmitter({ wallet, sender }),
    get maxActivePerWallet() {
      return maxActivePerWallet;
    },
    get maxActiveTotal() {
      return maxActiveTotal;
    },
  };
}

const usdcDeposit = () => depositCalls(ACCOUNT_CORE, USDC, 10_000_000n);
const placeCall = (): KuruCall =>
  placeOrderCall(MARKET, {
    side: 'buy',
    quantity: 5_000n,
    price: 2_000n,
    tif: 'gtc',
    executionInstruction: 'none',
    minSizeAfterBlock: 0n,
  });

describe('PrivyKuruSubmitter', () => {
  it('submits each call as its own transaction, in order, with fixed gas limits', async () => {
    const h = harness();
    const execution = await h.submitter().submit(usdcDeposit());

    expect(h.signed.map((s) => s.tx.to)).toEqual([
      getAddress(USDC.address),
      getAddress(ACCOUNT_CORE),
    ]);
    expect(h.signed.map((s) => s.tx.nonce)).toEqual([7, 8]);
    expect(h.signed.map((s) => s.tx.gas_limit)).toEqual([
      `0x${AGENT_APPROVE_GAS.toString(16)}`,
      `0x${KURU_MEASURED_GAS.firstDeposit.toString(16)}`,
    ]);
    expect(h.signed.every((s) => s.tx.chain_id === 10143 && s.tx.type === 2)).toBe(true);
    expect(h.signed.every((s) => s.walletId === AGENT.walletId)).toBe(true);
    expect(h.broadcast).toHaveLength(2);
    expect(execution).toEqual({
      hash: hashOf(2),
      transactionHash: hashOf(2),
      success: true,
      logs: [
        { address: MARKET, topics: [], data: '0x01' },
        { address: MARKET, topics: [], data: '0x02' },
      ],
    });
  });

  it('sends fee, gas and value fields to Privy as 0x-hex strings', async () => {
    const h = harness();
    await h.submitter().submit([...usdcDeposit(), ...depositCalls(ACCOUNT_CORE, MON, 10n ** 18n)]);

    for (const { tx } of h.signed) {
      expect(tx.gas_limit).toMatch(HEX);
      expect(tx.max_fee_per_gas).toBe(`0x${FEES.maxFeePerGas.toString(16)}`);
      expect(tx.max_priority_fee_per_gas).toBe(`0x${FEES.maxPriorityFeePerGas.toString(16)}`);
    }
    // A zero-value call carries no value; the native deposit carries it as hex.
    expect('value' in h.signed[0]!.tx).toBe(false);
    expect(h.signed[2]!.tx.value).toBe('0xde0b6b3a7640000');
  });

  it('gives success: false from a reverted receipt and stops the list there', async () => {
    const h = harness({ reverted: [1] });
    const execution = await h.submitter().submit(usdcDeposit());

    expect(execution.success).toBe(false);
    expect(execution.hash).toBe(hashOf(1));
    expect(h.signed).toHaveLength(1); // the deposit was never signed
  });

  it('reports a reverted LAST leg as a failure too', async () => {
    const h = harness({ reverted: [2] });
    const execution = await h.submitter().submit(usdcDeposit());

    expect(execution.success).toBe(false);
    expect(execution.transactionHash).toBe(hashOf(2));
  });

  it('propagates an enclave refusal unchanged and broadcasts nothing', async () => {
    const h = harness({ refuseAt: 0 });
    await expect(h.submitter().submit(usdcDeposit())).rejects.toBe(h.refusal);
    expect(h.broadcast).toHaveLength(0);
  });

  it('broadcasts nothing for the refused leg when an earlier one landed', async () => {
    const h = harness({ refuseAt: 1 });
    await expect(h.submitter().submit(usdcDeposit())).rejects.toBeInstanceOf(EnclaveRefusedError);
    expect(h.broadcast).toHaveLength(1);
  });

  it('keeps one transaction in flight per wallet, and runs lists whole and in order', async () => {
    const h = harness();
    const a = h.submitter();
    const b = h.submitter(); // a second submitter for the SAME wallet, same sender
    await Promise.all([a.submit(usdcDeposit()), b.submit([placeCall()])]);

    expect(h.maxActivePerWallet).toBe(1);
    expect(h.signed.map((s) => s.tx.nonce)).toEqual([7, 8, 9]);
    expect(h.signed.map((s) => s.tx.to)).toEqual([
      getAddress(USDC.address),
      getAddress(ACCOUNT_CORE),
      getAddress(MARKET),
    ]);
  });

  it('does not serialise different wallets against each other', async () => {
    const h = harness();
    await Promise.all([
      h.submitter(AGENT).submit([placeCall()]),
      h.submitter(OTHER).submit([placeCall()]),
    ]);
    expect(h.maxActivePerWallet).toBe(1);
    expect(h.maxActiveTotal).toBe(2);
  });

  it('never reuses a nonce when the RPC lags behind its own receipts', async () => {
    const h = harness({ laggingNonce: true });
    await h.submitter().submit(usdcDeposit());
    expect(h.signed.map((s) => s.tx.nonce)).toEqual([7, 8]);
  });

  it('refuses a call with no measured gas limit before signing anything', async () => {
    const h = harness();
    const unknown: KuruCall = { to: MARKET, value: 0n, data: '0xdeadbeef' };
    await expect(h.submitter().submit([...usdcDeposit(), unknown])).rejects.toBeInstanceOf(
      UnmeasuredCallError,
    );
    expect(h.signed).toHaveLength(0);
  });

  it('lands KuruVenue writes, and a revert surfaces as KuruExecutionError', async () => {
    const ok = harness();
    const venue = new KuruVenue({ publicClient: {} as PublicClient, submitter: ok.submitter() });
    await expect(venue.deposit('USDC', '10')).resolves.toMatchObject({ success: true });

    const bad = harness({ reverted: [2] });
    const failing = new KuruVenue({ publicClient: {} as PublicClient, submitter: bad.submitter() });
    await expect(failing.deposit('USDC', '10')).rejects.toBeInstanceOf(KuruExecutionError);
  });
});

describe('kuruGasLimit', () => {
  it('maps each adapter call to its measured limit', () => {
    const [approve, deposit] = usdcDeposit();
    expect(kuruGasLimit(approve!)).toBe(AGENT_APPROVE_GAS);
    expect(kuruGasLimit(deposit!)).toBe(KURU_MEASURED_GAS.firstDeposit);
    expect(kuruGasLimit(placeCall())).toBe(KURU_MEASURED_GAS.placeTakingOneLevel);
    expect(kuruGasLimit(cancelOrderCall(MARKET, 3))).toBe(KURU_MEASURED_GAS.cancelOne);
    expect(kuruGasLimit(withdrawCall(ACCOUNT_CORE, USDC, 14_000_000n))).toBe(
      KURU_MEASURED_GAS.withdraw,
    );
  });

  it('throws for anything unmeasured', () => {
    expect(() => kuruGasLimit({ to: MARKET, data: '0x12345678' })).toThrow(UnmeasuredCallError);
    expect(() => kuruGasLimit({ to: MARKET })).toThrow(UnmeasuredCallError);
  });
});
