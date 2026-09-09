import { encodeFunctionData, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  AUTHORIZATION_PRIMARY_TYPE,
  AUTHORIZATION_TYPES,
  authorizationDomain,
  executeBodyHash,
  type AuthorizationMessage,
} from './authorization/authorization';
import type { Bundler, SenteUserOperation, UserOperationGasEstimate } from './bundler/bundler';
import type { KernelAccountFactory, KernelAccountView } from './chain/kernel-account.factory';
import type { OperationTracker, TrackedOperation } from './confirmation/operation-tracker';
import { SponsorshipUnavailableError, type Sponsorship } from './paymaster/sponsorship';
import {
  InMemoryPreparedOperationStore,
  type PreparedOperationStore,
} from './store/prepared-operation-store';
import {
  InMemorySmartAccountRegistry,
  type SmartAccountRegistry,
} from './store/smart-account-registry';
import { WALLET_DEFAULTS, type WalletConfig } from './wallet.config';
import { WalletRefusedError } from './wallet.errors';
import { WALLET_CHAIN_ID, WalletService, EXECUTE_ROUTE } from './wallet.service';

/**
 * Well-known anvil test key #1. Public by construction; used here purely as a
 * stable owner identity, exactly as `apps/mobile/src/wallet/kernel.test.ts`
 * uses it.
 */
const OWNER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ownerAccount = privateKeyToAccount(OWNER_KEY);
const OWNER = ownerAccount.address;

/** The Kernel account this owner derives, observed on Monad testnet. */
const SENDER = '0xEC4b217240f0292c65Bf136b341e400e2D28cA6F' as Address;
/** Some other user's account. This is the address a stale client would send. */
const OTHER_ACCOUNT = '0xB3729F7e1Ab0B4a50E7De5599Ecc321B8775d30d' as Address;

const USER = { userId: 'user-1' };
const AUSD = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc' as Address;
const PAYMASTER = '0x2222222222222222222222222222222222222222' as Address;
const CALLS = [
  { to: AUSD, value: 0n, data: '0x095ea7b3' as Hex },
  { to: OTHER_ACCOUNT, value: 0n, data: '0xcab13915' as Hex },
];

const config = (over: Partial<WalletConfig> = {}): WalletConfig => ({
  bundlerUrl: WALLET_DEFAULTS.bundlerUrl,
  paymaster: { provider: 'pimlico', url: 'https://example.invalid', policyId: 'sp_test' },
  rpcUrl: undefined,
  confirmationPollMs: 300,
  confirmationTimeoutMs: 5_000,
  prepareTtlMs: 120_000,
  ...over,
});

/** A fake Kernel account: real encoding, no network. */
function kernelAccounts(address: Address = SENDER, deployed = false): KernelAccountFactory {
  const view: KernelAccountView = {
    address,
    isDeployed: () => Promise.resolve(deployed),
    getNonce: () => Promise.resolve(7n),
    getFactoryArgs: () =>
      Promise.resolve(
        deployed
          ? {}
          : {
              factory: '0xd703aaE79538628d27099B8c4f621bE4CCd142d5' as Address,
              factoryData: '0xdead' as Hex,
            },
      ),
    encodeCalls: (calls) =>
      Promise.resolve(
        encodeFunctionData({
          abi: [
            {
              type: 'function',
              name: 'execute',
              stateMutability: 'payable',
              outputs: [],
              inputs: [
                { name: 'execMode', type: 'bytes32' },
                { name: 'executionCalldata', type: 'bytes' },
              ],
            },
          ],
          functionName: 'execute',
          args: [
            '0x0100000000000000000000000000000000000000000000000000000000000000',
            `0x${calls.length.toString(16).padStart(64, '0')}` as Hex,
          ],
        }),
      ),
    getStubSignature: () => Promise.resolve('0xstub00' as Hex),
  };
  return { forOwner: () => Promise.resolve(view) };
}

function bundler(behaviour: 'ok' | 'reject' | 'no-prefund' = 'ok') {
  const sent: SenteUserOperation[] = [];
  const estimate: UserOperationGasEstimate = {
    callGasLimit: 100_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 50_000n,
  };
  const impl: Bundler = {
    name: 'fake',
    fees: () => Promise.resolve({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
    estimate: () =>
      behaviour === 'no-prefund'
        ? Promise.reject(
            new Error(
              "UserOperation reverted during simulation with reason: AA21 didn't pay prefund",
            ),
          )
        : Promise.resolve(estimate),
    send: (userOperation) => {
      if (behaviour === 'reject') {
        return Promise.reject(new Error('AA33 reverted'));
      }
      sent.push(userOperation);
      return Promise.resolve('0xabc123' as Hash);
    },
    receipt: () => Promise.resolve(null),
  };
  return { impl, sent };
}

function sponsorship(mode: 'ok' | 'unavailable' | 'declines-quote' = 'ok'): Sponsorship {
  const quote = {
    paymaster: PAYMASTER,
    paymasterData: '0xf00d' as Hex,
    paymasterVerificationGasLimit: 30_000n,
    paymasterPostOpGasLimit: 10_000n,
  };
  return {
    name: mode === 'unavailable' ? 'none' : 'pimlico',
    available: mode !== 'unavailable',
    stub: () => Promise.resolve(quote),
    quote: () =>
      mode === 'declines-quote'
        ? Promise.reject(new SponsorshipUnavailableError('pimlico', 'policy declined'))
        : Promise.resolve(quote),
  };
}

function tracker() {
  const tracked: Pick<TrackedOperation, 'userOpHash' | 'sender' | 'sponsored'>[] = [];
  const impl: OperationTracker = {
    track: (operation) => {
      tracked.push(operation);
    },
    status: () => undefined,
  };
  return { impl, tracked };
}

type Overrides = {
  cfg?: Partial<WalletConfig>;
  registry?: SmartAccountRegistry;
  prepared?: PreparedOperationStore;
  accounts?: KernelAccountFactory;
  bundlerBehaviour?: 'ok' | 'reject' | 'no-prefund';
  sponsorshipMode?: 'ok' | 'unavailable' | 'declines-quote';
};

function build(over: Overrides = {}) {
  const registry = over.registry ?? new InMemorySmartAccountRegistry();
  const prepared = over.prepared ?? new InMemoryPreparedOperationStore();
  const accounts = over.accounts ?? kernelAccounts();
  const bundle = bundler(over.bundlerBehaviour ?? 'ok');
  const track = tracker();
  const service = new WalletService(
    config(over.cfg),
    registry,
    prepared,
    accounts,
    bundle.impl,
    sponsorship(over.sponsorshipMode ?? 'ok'),
    track.impl,
  );
  return { service, registry, prepared, bundle, track };
}

/** Signs the envelope the server issued, as the owner would on device. */
function signEnvelope(message: AuthorizationMessage, key: Hex = OWNER_KEY): Promise<Hex> {
  return privateKeyToAccount(key).signTypedData({
    domain: authorizationDomain(WALLET_CHAIN_ID),
    types: AUTHORIZATION_TYPES,
    primaryType: AUTHORIZATION_PRIMARY_TYPE,
    message,
  });
}

describe('WalletService', () => {
  describe('registration', () => {
    it('binds the user to their owner and returns the derived account', async () => {
      const { service } = build();
      const view = await service.register(USER, OWNER);
      expect(view.owner).toBe(OWNER);
      expect(view.address).toBe(SENDER);
      expect(view.deployed).toBe(false);
      expect(view.sponsorshipAvailable).toBe(true);
    });

    it('is idempotent for the same owner', async () => {
      const { service } = build();
      await service.register(USER, OWNER);
      await expect(service.register(USER, OWNER.toLowerCase())).resolves.toMatchObject({
        address: SENDER,
      });
    });

    it('refuses to rebind a user to a different owner key', async () => {
      const { service } = build();
      await service.register(USER, OWNER);
      await expect(
        service.register(USER, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'),
      ).rejects.toMatchObject({ reason: 'owner_conflict' });
    });

    it('refuses an operation before registration', async () => {
      const { service } = build();
      await expect(service.prepare(USER, { calls: CALLS })).rejects.toMatchObject({
        reason: 'account_not_registered',
      });
    });
  });

  // -------------------------------------------------------------------------
  // The canonical-sender rule. See `store/smart-account-registry.ts` for why
  // this one matters more than it looks.
  // -------------------------------------------------------------------------
  describe('canonical sender resolution', () => {
    it('rejects a request whose client-supplied address is not the canonical one', async () => {
      const { service } = build();
      await service.register(USER, OWNER);

      await expect(
        service.prepare(USER, { calls: CALLS, sender: OTHER_ACCOUNT }),
      ).rejects.toMatchObject({ reason: 'sender_mismatch' });
    });

    it('rejects a malformed client-supplied address rather than ignoring it', async () => {
      const { service } = build();
      await service.register(USER, OWNER);
      await expect(
        service.prepare(USER, { calls: CALLS, sender: 'not-an-address' }),
      ).rejects.toBeInstanceOf(WalletRefusedError);
    });

    it('accepts a matching sender in any hex case', async () => {
      const { service } = build();
      await service.register(USER, OWNER);
      const prepared = await service.prepare(USER, {
        calls: CALLS,
        sender: SENDER.toLowerCase(),
      });
      expect(prepared.sender).toBe(SENDER);
    });

    it('uses the canonical sender when the client supplies none', async () => {
      const { service } = build();
      await service.register(USER, OWNER);
      const prepared = await service.prepare(USER, { calls: CALLS });
      expect(prepared.userOperation.sender).toBe(SENDER);
    });

    it('refuses when derivation drifts away from the bound address', async () => {
      const { service, registry } = build();
      await registry.bind({ userId: USER.userId, owner: OWNER, address: OTHER_ACCOUNT });
      await expect(service.prepare(USER, { calls: CALLS })).rejects.toMatchObject({
        reason: 'sender_mismatch',
      });
    });
  });

  describe('prepare', () => {
    it('produces a sponsored, fully-sized operation and an envelope bound to it', async () => {
      const { service } = build();
      await service.register(USER, OWNER);
      const prepared = await service.prepare(USER, { calls: CALLS });

      expect(prepared.sponsored).toBe(true);
      expect(prepared.userOperation.paymaster).toBe(PAYMASTER);
      expect(prepared.userOperation.callGasLimit).toBe(100_000n);
      // Undeployed, so the factory call rides along in the same operation.
      expect(prepared.userOperation.factory).toBeDefined();

      expect(prepared.authorization.message.userOpHash).toBe(prepared.userOpHash);
      expect(prepared.authorization.message.sender).toBe(SENDER);
      expect(prepared.authorization.message.owner).toBe(OWNER);
      expect(prepared.authorization.message.path).toBe(EXECUTE_ROUTE.path);
      expect(prepared.authorization.message.bodyHash).toBe(executeBodyHash(prepared.prepareId));
      expect(prepared.authorization.domain.chainId).toBe(WALLET_CHAIN_ID);
    });

    it('issues a fresh single-use nonce per prepare', async () => {
      const { service } = build();
      await service.register(USER, OWNER);
      const a = await service.prepare(USER, { calls: CALLS });
      const b = await service.prepare(USER, { calls: CALLS });
      expect(a.authorization.message.nonce).not.toBe(b.authorization.message.nonce);
      expect(a.prepareId).not.toBe(b.prepareId);
    });

    it('reports sponsored=false rather than pretending when no paymaster is configured', async () => {
      const { service } = build({ sponsorshipMode: 'unavailable' });
      await service.register(USER, OWNER);
      const prepared = await service.prepare(USER, { calls: CALLS });
      expect(prepared.sponsored).toBe(false);
      expect(prepared.userOperation.paymaster).toBeUndefined();
    });

    it('explains AA21 rather than leaking a 500 when nothing will pay for gas', async () => {
      // The state this repo is actually in without a Pimlico key. The
      // operation is well-formed; nobody has agreed to pay for it.
      const { service } = build({ sponsorshipMode: 'unavailable', bundlerBehaviour: 'no-prefund' });
      await service.register(USER, OWNER);
      await expect(service.prepare(USER, { calls: CALLS })).rejects.toMatchObject({
        reason: 'sponsorship_unavailable',
      });
      await expect(service.prepare(USER, { calls: CALLS })).rejects.toThrow(
        /PIMLICO_SPONSORSHIP_POLICY_ID/,
      );
    });

    it('refuses rather than silently self-funding when the paymaster declines the quote', async () => {
      const { service } = build({ sponsorshipMode: 'declines-quote' });
      await service.register(USER, OWNER);
      await expect(service.prepare(USER, { calls: CALLS })).rejects.toMatchObject({
        reason: 'sponsorship_unavailable',
      });
    });
  });

  describe('execute', () => {
    const prepareAndSign = async (over: Overrides = {}) => {
      const built = build(over);
      await built.service.register(USER, OWNER);
      const prepared = await built.service.prepare(USER, { calls: CALLS });
      const signature = await signEnvelope(prepared.authorization.message);
      return { ...built, prepared, signature };
    };

    it('verifies both signatures and submits', async () => {
      const { service, bundle, track, prepared, signature } = await prepareAndSign();
      const result = await service.execute(USER, {
        prepareId: prepared.prepareId,
        userOpSignature: '0xdeadbeef',
        authorizationSignature: signature,
      });

      expect(result.userOpHash).toBe('0xabc123');
      expect(result.sponsored).toBe(true);
      expect(bundle.sent).toHaveLength(1);
      // The submitted operation is the stored one plus the client's signature —
      // nothing from the execute request body reaches the bundler.
      expect(bundle.sent[0]?.signature).toBe('0xdeadbeef');
      expect(bundle.sent[0]?.sender).toBe(SENDER);
      expect(track.tracked).toHaveLength(1);
    });

    it('rejects an envelope signed by a different key', async () => {
      const { service, prepared } = await prepareAndSign();
      const wrongKey: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
      const forged = await signEnvelope(prepared.authorization.message, wrongKey);
      await expect(
        service.execute(USER, {
          prepareId: prepared.prepareId,
          userOpSignature: '0xdeadbeef',
          authorizationSignature: forged,
        }),
      ).rejects.toMatchObject({ reason: 'invalid_authorization' });
    });

    it('rejects an envelope signed for a different prepare id', async () => {
      const { service, prepared } = await prepareAndSign();
      // Same owner, same everything except the body hash — which is exactly the
      // field that binds the signature to this request.
      const signature = await signEnvelope({
        ...prepared.authorization.message,
        bodyHash: executeBodyHash('some-other-prepare-id'),
      });
      await expect(
        service.execute(USER, {
          prepareId: prepared.prepareId,
          userOpSignature: '0xdeadbeef',
          authorizationSignature: signature,
        }),
      ).rejects.toMatchObject({ reason: 'invalid_authorization' });
    });

    it('rejects an envelope re-pointed at a different endpoint', async () => {
      const { service, prepared } = await prepareAndSign();
      const signature = await signEnvelope({
        ...prepared.authorization.message,
        path: '/wallet/prepare',
      });
      await expect(
        service.execute(USER, {
          prepareId: prepared.prepareId,
          userOpSignature: '0xdeadbeef',
          authorizationSignature: signature,
        }),
      ).rejects.toMatchObject({ reason: 'invalid_authorization' });
    });

    it('is single use: a prepared operation cannot be replayed', async () => {
      const { service, prepared, signature } = await prepareAndSign();
      const command = {
        prepareId: prepared.prepareId,
        userOpSignature: '0xdeadbeef' as Hex,
        authorizationSignature: signature,
      };
      await service.execute(USER, command);
      await expect(service.execute(USER, command)).rejects.toMatchObject({
        reason: 'prepare_expired',
      });
    });

    it('refuses an unknown prepare id', async () => {
      const { service } = build();
      await expect(
        service.execute(USER, {
          prepareId: 'nope',
          userOpSignature: '0x00',
          authorizationSignature: '0x00',
        }),
      ).rejects.toMatchObject({ reason: 'prepare_expired' });
    });

    it("refuses another user's prepared operation", async () => {
      const { service, prepared, signature } = await prepareAndSign();
      await expect(
        service.execute(
          { userId: 'someone-else' },
          {
            prepareId: prepared.prepareId,
            userOpSignature: '0xdeadbeef',
            authorizationSignature: signature,
          },
        ),
      ).rejects.toMatchObject({ reason: 'sender_mismatch' });
    });

    it('surfaces a bundler rejection as bundler_rejected', async () => {
      const { service, prepared, signature } = await prepareAndSign({ bundlerBehaviour: 'reject' });
      await expect(
        service.execute(USER, {
          prepareId: prepared.prepareId,
          userOpSignature: '0xdeadbeef',
          authorizationSignature: signature,
        }),
      ).rejects.toMatchObject({ reason: 'bundler_rejected' });
    });
  });

  describe('status', () => {
    it('reports unknown for a hash we never submitted', async () => {
      const { service } = build();
      await expect(service.status('0xnothing' as Hash)).resolves.toMatchObject({
        status: 'unknown',
      });
    });
  });
});
