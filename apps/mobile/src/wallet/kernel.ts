/**
 * The Kernel (ZeroDev) ERC-7579 smart account, owned by the Mera passkey key.
 *
 * ---------------------------------------------------------------------------
 * WHY A SMART ACCOUNT AND NOT THE EOA
 *
 * The MOV-251 account is an ordinary secp256k1 EOA with no MON, and there is no
 * way to sponsor gas for an external EOA:
 *
 *   - Privy's smart wallets are driven by Privy's own embedded signers, and its
 *     native EIP-7702 sponsorship is embedded-wallet-only. There is no
 *     bring-your-own-signer path, so Privy is not a dependency of this file.
 *   - EIP-7702 straight onto the Mera EOA is ruled out on Monad: a delegated
 *     EOA loses the first-transaction-per-3-blocks exception to the 10 MON
 *     Reserve Balance, so it would need the user to already hold what we are
 *     trying to give them, and the faucet drips 0.5-10 MON/day.
 *
 * A separate ERC-4337 account with the Mera key as its only owner has neither
 * problem: the bundler pays, a paymaster reimburses it, and the user's balance
 * is never touched.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 *
 * The address is a pure function of (owner address, Kernel version, factory,
 * salt index) — CREATE2, no state. That matters more here than usual: the Mera
 * key itself is re-derived from the passkey rather than stored, so a wiped
 * install must land on the same smart account, and it does, without any server
 * lookup. `kernelFactoryArgs` is that pure function's on-chain half, and it is
 * pinned against fixed owner keys in `kernel.test.ts`.
 */
import {
  concatHex,
  encodeFunctionData,
  getAddress,
  toHex,
  zeroAddress,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type JsonRpcAccount,
  type LocalAccount,
  type Transport,
} from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import { toKernelSmartAccount } from 'permissionless/accounts';

/**
 * Kernel v0.3.1 on EntryPoint v0.7.
 *
 * Pinned rather than left to `permissionless`'s default, which is `0.3.0-beta`
 * for EntryPoint 0.7 and would silently move every user's address on a library
 * bump. Treat this the way `RP_ID` is treated: changing it is an account
 * migration, not a version upgrade.
 */
export const KERNEL_VERSION = '0.3.1' as const;

export const ENTRY_POINT = {
  address: entryPoint07Address,
  version: '0.7',
} as const;

/**
 * Kernel v0.3.1 deployment on Monad testnet (10143).
 *
 * These are ZeroDev's canonical deterministic deployments, and all four were
 * confirmed present with `eth_getCode` against https://testnet-rpc.monad.xyz —
 * worth checking rather than assuming, because Monad testnet was reset from
 * genesis on 2025-12-16 and pre-reset deployments are gone.
 */
export const KERNEL_ADDRESSES = {
  /** MetaFactory. `getFactoryArgs().factory` — the account's `initCode` target. */
  metaFactory: '0xd703aaE79538628d27099B8c4f621bE4CCd142d5',
  /** KernelFactory, which the MetaFactory delegates the deploy to. */
  factory: '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419',
  /** ECDSAValidator — the module that checks the Mera key's signature. */
  ecdsaValidator: '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57',
  /** Kernel implementation the proxy points at. */
  accountLogic: '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D',
} as const satisfies Record<string, Address>;

/** `0x01` = VALIDATOR. Byte 0 of Kernel v3's 21-byte root validator identifier. */
const VALIDATOR_TYPE_VALIDATOR = '0x01' as const;

const KERNEL_V3_1_INITIALIZE_ABI = [
  {
    type: 'function',
    name: 'initialize',
    stateMutability: 'nonpayable',
    outputs: [],
    inputs: [
      { name: '_rootValidator', type: 'bytes21' },
      { name: 'hook', type: 'address' },
      { name: 'validatorData', type: 'bytes' },
      { name: 'hookData', type: 'bytes' },
      { name: 'initConfig', type: 'bytes[]' },
    ],
  },
] as const;

const META_FACTORY_ABI = [
  {
    type: 'function',
    name: 'deployWithFactory',
    stateMutability: 'payable',
    outputs: [{ name: '', type: 'address' }],
    inputs: [
      { name: 'factory', type: 'address' },
      { name: 'createData', type: 'bytes' },
      { name: 'salt', type: 'bytes32' },
    ],
  },
] as const;

export type KernelFactoryArgs = {
  /** ERC-4337 `initCode` target. */
  readonly factory: Address;
  /** ERC-4337 `initCode` payload. */
  readonly factoryData: Hex;
};

/**
 * The account's deployment arguments, computed locally from nothing but the
 * owner address and the salt index.
 *
 * Pure — no RPC, no library, no chain state. That is the point: it is the one
 * piece of the derivation that can be unit tested offline against fixed
 * vectors, and it fully determines the CREATE2 address given the pinned
 * factory. Verified byte-for-byte against `permissionless`'s own
 * `getFactoryArgs()` in `kernel.test.ts`.
 *
 * For an ECDSA owner the validator's init data is just the owner's 20-byte
 * address, so the owner is the only variable input.
 */
export function kernelFactoryArgs(owner: Address, index = 0n): KernelFactoryArgs {
  const initialize = encodeFunctionData({
    abi: KERNEL_V3_1_INITIALIZE_ABI,
    functionName: 'initialize',
    args: [
      concatHex([VALIDATOR_TYPE_VALIDATOR, KERNEL_ADDRESSES.ecdsaValidator]),
      zeroAddress, // no hook
      getAddress(owner), // ECDSAValidator init data == the owner
      '0x', // no hook data
      [], // no extra modules at deploy time
    ],
  });

  return {
    factory: KERNEL_ADDRESSES.metaFactory,
    factoryData: encodeFunctionData({
      abi: META_FACTORY_ABI,
      functionName: 'deployWithFactory',
      args: [KERNEL_ADDRESSES.factory, initialize, toHex(index, { size: 32 })],
    }),
  };
}

export type SenteKernelAccount = Awaited<ReturnType<typeof toSenteKernelAccount>>;

/** The exact client shape `toKernelSmartAccount` accepts. */
export type KernelDerivationClient = Client<
  Transport,
  Chain | undefined,
  JsonRpcAccount | LocalAccount | undefined
>;

export type ToSenteKernelAccountParameters = {
  /** A public client on the target chain. Used to resolve the CREATE2 address. */
  readonly client: KernelDerivationClient;
  /**
   * The Mera-derived viem account from `src/auth`. This is the account's ONLY
   * owner — there is no server-side co-signer and no Privy signer.
   */
  readonly owner: LocalAccount;
  /** BIP-44-style account index; only 0 is used today. */
  readonly index?: bigint;
};

/**
 * Builds the Kernel account for an owner.
 *
 * Costs one `eth_call` (EntryPoint's `getSenderAddress` revert trick) to
 * resolve the counterfactual address; everything else is local.
 */
export function toSenteKernelAccount({
  client,
  owner,
  index = 0n,
}: ToSenteKernelAccountParameters) {
  return toKernelSmartAccount({
    client,
    entryPoint: { address: ENTRY_POINT.address, version: ENTRY_POINT.version },
    // The Mera account, not a Privy wallet. `owners` is a one-element tuple:
    // Kernel's ECDSA validator has exactly one root owner.
    owners: [owner],
    version: KERNEL_VERSION,
    index,
  });
}
