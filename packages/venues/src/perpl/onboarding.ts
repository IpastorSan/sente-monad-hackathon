/**
 * Perpl onboarding as a call list: approve -> createAccount -> allowOrderForwarding.
 *
 * Three calls, three failure modes, and all three are required before the API
 * can post a single order (see docs/monad-testnet-assets.md):
 *
 *   1. `approve(Exchange, amount)` on the collateral token (AUSD, 6 decimals).
 *   2. `createAccount(amount)` — `0xcab13915`. Pulls the deposit with
 *      `transferFrom`, so it reverts without step 1. The amount must be at least
 *      the instance's `min_account_open_amount` (100 AUSD on testnet, 10 on
 *      mainnet — read it live, it is not a constant).
 *   3. `allowOrderForwarding(true)` — `0x7962f910`. `createAccount` leaves this
 *      OFF; without it authed API calls succeed and every order fails with
 *      `sr: 34`. Once granted, the exchange submits orders and pays their gas.
 *
 * The calls are plain `{ to, value, data }` records, structurally identical to
 * `Erc7579Call` in `apps/mobile/src/wallet/batch.ts`, so they go straight into
 * `encodeKernelExecute` / `useSmartAccount().sendCalls` as one atomic batch, or
 * out as three ordinary transactions from an EOA. This module only encodes; it
 * never batches and never signs.
 *
 * WHO MUST SEND THEM: whoever calls `createAccount` owns the Perpl account,
 * and the API key must later be enrolled by that same address with a plain
 * secp256k1 EIP-712 signature — Perpl's enroll does not accept ERC-1271 (see
 * `enroll.ts` and docs/monad-testnet-assets.md). A Kernel account that sends
 * this batch owns a Perpl account nobody can ever get an API key for, which was
 * verified the expensive way on testnet. Send these from the passkey EOA, as
 * three transactions; batching them through the smart account works on chain
 * and produces an account the API can never trade.
 */
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';

import type { PerplContext } from './wire.ts';

/** One leg of the onboarding sequence. Structurally an ERC-7579 call. */
export interface PerplCall {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
}

export const PERPL_EXCHANGE_ABI = [
  {
    type: 'function',
    name: 'createAccount',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amountCNS', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowOrderForwarding',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'allow', type: 'bool' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'depositCollateral',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amountCNS', type: 'uint256' }],
    outputs: [],
  },
  {
    // Returns the whole AccountInfo struct (the api-docs `cast` example decodes
    // only its first word). Reverts when the address has no account.
    type: 'function',
    name: 'getAccountByAddr',
    stateMutability: 'view',
    inputs: [{ name: 'accountAddress', type: 'address' }],
    outputs: [
      {
        name: 'accountInfo',
        type: 'tuple',
        components: [
          { name: 'accountId', type: 'uint256' },
          { name: 'balanceCNS', type: 'uint256' },
          { name: 'lockedBalanceCNS', type: 'uint256' },
          { name: 'frozen', type: 'uint8' },
          { name: 'accountAddr', type: 'address' },
          {
            name: 'positions',
            type: 'tuple',
            components: [
              { name: 'bank1', type: 'uint256' },
              { name: 'bank2', type: 'uint256' },
              { name: 'bank3', type: 'uint256' },
              { name: 'bank4', type: 'uint256' },
            ],
          },
        ],
      },
    ],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/** Everything onboarding needs, as read from `GET /api/v1/pub/context`. */
export interface PerplOnboardingParams {
  readonly exchange: Address;
  readonly collateral: Address;
  readonly collateralDecimals: number;
  /** Raw collateral units (6 decimals for AUSD). */
  readonly minAccountOpenAmount: bigint;
  readonly minDepositAmount: bigint;
}

/**
 * Reads the onboarding parameters off the live context.
 *
 * Deliberately NOT hard-coded: the api-docs README names a stale collateral
 * token (`0xdf5b718d…`, "Test USD") that the live Exchange never touches, and
 * the minimum differs 10x between testnet and mainnet.
 */
export function onboardingParams(context: PerplContext): PerplOnboardingParams {
  const instance = context.instances[0];
  if (!instance) throw new Error('Perpl context lists no protocol instance');
  const token = context.tokens.find((t) => t.id === instance.collateral_token_id);
  if (!token?.address) {
    throw new Error(`Perpl context has no collateral token ${instance.collateral_token_id}`);
  }
  return {
    exchange: getAddress(instance.address),
    collateral: getAddress(token.address),
    collateralDecimals: token.decimals,
    minAccountOpenAmount: BigInt(instance.min_account_open_amount),
    minDepositAmount: BigInt(instance.min_deposit_amount),
  };
}

/** A request to open a Perpl account below the venue minimum. */
export class OnboardingAmountError extends Error {
  constructor(amount: bigint, minimum: bigint) {
    super(`Perpl requires at least ${minimum} raw collateral units to open, got ${amount}`);
    this.name = 'OnboardingAmountError';
  }
}

/**
 * The three calls, in order. `amount` defaults to the venue minimum.
 *
 * The approval is for exactly `amount`, never unlimited: `createAccount`
 * consumes all of it, so nothing is left approved afterwards.
 */
export function perplOnboardingCalls(
  params: PerplOnboardingParams,
  amount: bigint = params.minAccountOpenAmount,
): readonly [PerplCall, PerplCall, PerplCall] {
  if (amount < params.minAccountOpenAmount) {
    throw new OnboardingAmountError(amount, params.minAccountOpenAmount);
  }
  return [
    {
      to: params.collateral,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [params.exchange, amount],
      }),
    },
    {
      to: params.exchange,
      value: 0n,
      data: encodeFunctionData({
        abi: PERPL_EXCHANGE_ABI,
        functionName: 'createAccount',
        args: [amount],
      }),
    },
    {
      to: params.exchange,
      value: 0n,
      data: encodeFunctionData({
        abi: PERPL_EXCHANGE_ABI,
        functionName: 'allowOrderForwarding',
        args: [true],
      }),
    },
  ];
}
