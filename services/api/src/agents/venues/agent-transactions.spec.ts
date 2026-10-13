import { encodeAbiParameters, getAddress, type Hex } from 'viem';

import {
  BEFORE_EXECUTION_TOPIC,
  USER_OPERATION_EVENT_TOPIC,
  type UserOperationOutcome,
} from '../../wallet/confirmation/user-operation-logs';
import { EnclaveRefusedError, SponsoredSendRejectedError } from '../agents.errors';
import { generateAuthorizationKey } from '../privy/authorization-key';
import { PrivyAgentWalletProvider } from '../privy/privy-agent-wallet.provider';
import { PrivyClient } from '../privy/privy.client';
import {
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  fakePrivy,
  signatureVerifies,
  type CapturedRequest,
} from '../privy/testing/fake-privy';
import {
  AgentTransactionSender,
  type AgentChainClient,
  type AgentLog,
  type AgentUserOperationClient,
} from './agent-transactions';

// SEN-211: an agent's transactions as Privy-sponsored sends, through the real
// Privy provider over the fake Privy API.

const agentKey = generateAuthorizationKey();
const WALLET = {
  walletId: 'wallet-a',
  address: getAddress('0x1111111111111111111111111111111111111111'),
};
const ENTRY_POINT = getAddress('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
const USDC = getAddress('0xee0722ead54f1b4fe97be399be43bc0226a6f97e');
const MARKET = getAddress('0x2222222222222222222222222222222222222222');
const BUNDLE: Hex = `0x${'b1'.repeat(32)}`;
const APPROVE = { to: USDC, data: '0x095ea7b3' as Hex, gas: 60_000n };
const NONCE_MISMATCH =
  "User Operation rejected by EntryPoint's `simulateValidation`. Details: RPC Request failed. " +
  'URL: https://monad-testnet.g.alchemy.com/v2 Request body: {"method":"eth_sendUserOperation",' +
  '"params":[{"callData":"0xe9ae5c53","signature":"0x0b9d"}]} Details: EIP-7702 nonce mismatch. ' +
  'Expected: 1, Actual: 0';

type Reply = { status: number; body: unknown } | undefined;

/** Which call is it — and was it the agent key that approved it? */
function rpcMethod(request: CapturedRequest): string | undefined {
  if (!request.url.endsWith('/rpc')) return undefined;
  return (request.body as { method?: string }).method;
}

function signedByAgent(request: CapturedRequest): boolean {
  const signature = request.headers['privy-authorization-signature'];
  if (!signature) return false;
  return signatureVerifies(
    agentKey.publicKey,
    {
      version: 1,
      method: 'POST',
      url: request.url,
      body: request.body ?? {},
      headers: { 'privy-app-id': FAKE_APP_ID },
    },
    signature,
  );
}

/**
 * The receipt of a bundle carrying two operations — ours (`userOpHash`), then
 * a stranger's — as the EntryPoint emits them: `BeforeExecution`, each
 * operation's own logs closed by its `UserOperationEvent`.
 */
function bundleLogs(userOpHash: Hex, success: boolean): AgentLog[] {
  const event = (hash: Hex): AgentLog => ({
    address: ENTRY_POINT,
    topics: [USER_OPERATION_EVENT_TOPIC, hash, `0x${'0'.repeat(24)}${WALLET.address.slice(2)}`],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [0n, success, 0n, 100_000n],
    ),
  });
  return [
    { address: ENTRY_POINT, topics: [BEFORE_EXECUTION_TOPIC], data: '0x' },
    { address: USDC, topics: [`0x${'aa'.repeat(32)}`], data: '0x01' },
    event(userOpHash),
    { address: MARKET, topics: [`0x${'cc'.repeat(32)}`], data: '0x02' },
    event(`0x${'ff'.repeat(32)}`),
  ];
}

function setup(
  options: { handle?: (request: CapturedRequest) => Reply; userOpSuccess?: boolean } = {},
) {
  const fake = fakePrivy(options.handle);
  const wallets = new PrivyAgentWalletProvider({
    client: new PrivyClient({ appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET, fetch: fake.fetch }),
    agentKey,
    mandateOwnerKey: generateAuthorizationKey(),
    agentQuorumId: 'kq-agent',
    mandateQuorumId: 'kq-mandate',
  });
  const broadcast: Hex[] = [];
  const followed: { userOpHash: Hex; fromBlock: bigint }[] = [];
  let lastUserOp: Hex | undefined;
  const chain: AgentChainClient = {
    pendingNonce: () => Promise.resolve(3),
    balance: () => Promise.resolve(10n ** 18n),
    fees: () => Promise.resolve({ maxFeePerGas: 102n, maxPriorityFeePerGas: 2n }),
    sendRawTransaction: (raw) => {
      broadcast.push(raw);
      return Promise.resolve(`0x${'0e'.repeat(32)}` as Hex);
    },
    waitForReceipt: (hash) =>
      Promise.resolve({
        transactionHash: hash,
        success: true,
        logs:
          hash === BUNDLE && lastUserOp
            ? bundleLogs(lastUserOp, options.userOpSuccess ?? true)
            : [{ address: USDC, topics: [], data: '0x' }],
        blockNumber: 500n,
      }),
  };
  const userOps: AgentUserOperationClient = {
    headBlock: () => Promise.resolve(490n),
    waitForUserOperation: (userOpHash, fromBlock): Promise<UserOperationOutcome> => {
      followed.push({ userOpHash, fromBlock });
      lastUserOp = userOpHash;
      return Promise.resolve({
        userOpHash,
        success: options.userOpSuccess ?? true,
        sender: WALLET.address,
        paymaster: getAddress('0x0000000000000000000000000000000000000000'),
        transactionHash: BUNDLE,
        blockNumber: 491n,
        actualGasCost: 0n,
        actualGasUsed: 100_000n,
      });
    },
  };
  const sender = new AgentTransactionSender({
    wallets,
    chain,
    sponsored: userOps,
    sponsoredRetryMs: 0,
  });
  const rpc = () => fake.calls.filter((call) => rpcMethod(call) !== undefined);
  return { sender, calls: fake.calls, rpc, broadcast, followed };
}

const policyViolation = { status: 400, body: { code: 'policy_violation', error: 'denied' } };
const broadcastFailure = (error: string) => ({
  status: 400,
  body: { code: 'transaction_broadcast_failure', error },
});

describe('AgentTransactionSender, sponsored (SEN-211)', () => {
  it('sends each call as a sponsored eth_sendTransaction, approved by the agent key', async () => {
    const { sender, rpc, broadcast } = setup();
    await sender.sendAll(WALLET, [APPROVE]);

    const [call] = rpc();
    expect(rpc()).toHaveLength(1);
    expect(call!.url).toBe('https://api.privy.io/v1/wallets/wallet-a/rpc');
    expect(call!.body).toEqual({
      method: 'eth_sendTransaction',
      caip2: 'eip155:10143',
      sponsor: true,
      // Value pinned to zero as on the sign path; no gas, nonce or fees: the
      // bundler sizes and prices the operation.
      params: { transaction: { to: USDC, data: '0x095ea7b3', value: '0x0', chain_id: 10143 } },
    });
    expect(signedByAgent(call!)).toBe(true);
    // Nothing went through our own RPC.
    expect(broadcast).toEqual([]);
  });

  it('decides success from the USER OPERATION and keeps only its own logs', async () => {
    const { sender, followed } = setup();
    const [receipt] = await sender.sendAll(WALLET, [APPROVE]);

    expect(followed).toHaveLength(1);
    expect(followed[0]!.fromBlock).toBe(490n);
    expect(receipt).toEqual({
      transactionHash: BUNDLE,
      success: true,
      // Ours, not the bundle's other operation's, and none of the EntryPoint's.
      logs: [{ address: USDC, topics: [`0x${'aa'.repeat(32)}`], data: '0x01' }],
      blockNumber: 491n,
      userOpHash: followed[0]!.userOpHash,
    });
  });

  it('a user operation that failed inside a successful bundle is a failure, and stops the list', async () => {
    const { sender, rpc } = setup({ userOpSuccess: false });
    const receipts = await sender.sendAll(WALLET, [APPROVE, APPROVE]);

    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.success).toBe(false);
    expect(rpc()).toHaveLength(1);
  });

  it('falls back to sign-and-broadcast when the policy has no sponsored rule for the call', async () => {
    // A policy compiled before AGENT_SPONSORED_SENDS: the sign rule, no twin.
    const { sender, rpc, broadcast } = setup({
      handle: (request) =>
        rpcMethod(request) === 'eth_sendTransaction' ? policyViolation : undefined,
    });
    const [receipt] = await sender.sendAll(WALLET, [APPROVE]);

    expect(rpc().map(rpcMethod)).toEqual(['eth_sendTransaction', 'eth_signTransaction']);
    expect(broadcast).toEqual(['0x02f8signed']);
    expect(receipt!.success).toBe(true);
    expect(receipt!.userOpHash).toBeUndefined();
  });

  it('a call the mandate forbids is refused on both paths, and nothing is broadcast', async () => {
    const { sender, rpc, broadcast } = setup({
      handle: (request) => (rpcMethod(request) ? policyViolation : undefined),
    });
    await expect(sender.sendAll(WALLET, [APPROVE])).rejects.toMatchObject({
      name: 'EnclaveRefusedError',
      method: 'eth_signTransaction',
    });
    await expect(sender.sendAll(WALLET, [APPROVE])).rejects.toBeInstanceOf(EnclaveRefusedError);
    expect(rpc().map(rpcMethod)).toEqual([
      'eth_sendTransaction',
      'eth_signTransaction',
      'eth_sendTransaction',
      'eth_signTransaction',
    ]);
    expect(broadcast).toEqual([]);
  });

  it('retries once on the EIP-7702 nonce mismatch of a wallet still being delegated', async () => {
    let attempts = 0;
    const { sender, rpc } = setup({
      handle: (request) => {
        if (rpcMethod(request) !== 'eth_sendTransaction') return undefined;
        attempts += 1;
        return attempts === 1 ? broadcastFailure(NONCE_MISMATCH) : undefined;
      },
    });
    const [receipt] = await sender.sendAll(WALLET, [APPROVE]);

    expect(rpc().map(rpcMethod)).toEqual(['eth_sendTransaction', 'eth_sendTransaction']);
    expect(receipt!.success).toBe(true);
  });

  it('any other rejection throws without a fallback broadcast, and without the quoted operation', async () => {
    const { sender, rpc, broadcast } = setup({
      handle: (request) =>
        rpcMethod(request) === 'eth_sendTransaction'
          ? broadcastFailure(
              'Execution reverted for an unknown reason. Details: RPC Request failed. ' +
                'URL: https://monad-testnet.g.alchemy.com/v2 Request body: {"callData":"0x1234"} ' +
                'Details: execution reverted',
            )
          : undefined,
    });
    const error = await sender.sendAll(WALLET, [APPROVE]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SponsoredSendRejectedError);
    const rejected = error as SponsoredSendRejectedError;
    expect(rejected.nonceMismatch).toBe(false);
    expect(rejected.message).toContain('execution reverted');
    expect(rejected.message).not.toContain('callData');
    expect(rejected.message).not.toContain('alchemy.com');
    expect(rpc()).toHaveLength(1);
    expect(broadcast).toEqual([]);
  });

  it('without the sponsored option it signs and broadcasts, as before', async () => {
    const fake = fakePrivy();
    const wallets = new PrivyAgentWalletProvider({
      client: new PrivyClient({
        appId: FAKE_APP_ID,
        appSecret: FAKE_APP_SECRET,
        fetch: fake.fetch,
      }),
      agentKey,
      mandateOwnerKey: generateAuthorizationKey(),
      agentQuorumId: 'kq-agent',
      mandateQuorumId: 'kq-mandate',
    });
    const raw: Hex[] = [];
    const sender = new AgentTransactionSender({
      wallets,
      chain: {
        pendingNonce: () => Promise.resolve(0),
        balance: () => Promise.resolve(10n ** 18n),
        fees: () => Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
        sendRawTransaction: (signed) => {
          raw.push(signed);
          return Promise.resolve(BUNDLE);
        },
        waitForReceipt: (hash) =>
          Promise.resolve({ transactionHash: hash, success: true, logs: [], blockNumber: 1n }),
      },
    });
    expect(sender.sponsored).toBe(false);
    await sender.sendAll(WALLET, [APPROVE]);
    expect(fake.calls.map(rpcMethod)).toEqual(['eth_signTransaction']);
    expect(raw).toHaveLength(1);
  });
});
