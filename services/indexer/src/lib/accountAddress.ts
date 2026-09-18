/**
 * Account id → account address, read off the chain on first sight.
 *
 * **Why this exists.** `Account.address` used to be written only by the
 * one-shot registration events — Kuru `AccountRegistered`, Perpl
 * `AccountCreated` — and `config.yaml` starts at block 61294867, about seven
 * days of history. An account registered *before* that window never emits its
 * registration again, so its address stayed null forever; a Kuru maker that is
 * only ever seen as a record inside somebody else's `TradesPacked` log never
 * had one at all. `services/api` matches agents with
 * `where: { address: { _in: […] } }` and drops null-address rows, so those
 * accounts are invisible on the leaderboard and nothing heals them.
 *
 * **Why a contract read and not one of the cheaper options.**
 *
 * - *From the fill events themselves*: neither venue carries the address.
 *   Kuru's `TradesPacked` has an `executor` (whoever submitted the order —
 *   an authorised signer, not necessarily the account), the maker leg inside
 *   `packedTrades` carries a bare `uint40` id, and every Perpl fill event
 *   carries `accountId` at best. Equating `executor` with the account would
 *   put a wrong address on a leaderboard row, which is worse than none.
 * - *An earlier `start_block` for the registration events only*: not
 *   expressible. Envio's per-contract `start_block` is documented in
 *   `envio/evm.schema.json` as "Can be greater than the chain start_block for
 *   more specific indexing" — later only. Reaching registrations from before
 *   the window means moving the whole chain's `start_block` back, which is
 *   the seven-day window being given up.
 *
 * So the id is resolved against the contract, once per account, through an
 * Envio effect (deduplicated and cached, so a re-sync does not re-read):
 *
 * | Venue | Call                                          | Answer            |
 * | ----- | --------------------------------------------- | ----------------- |
 * | Kuru  | `AccountCore.userAddressById(uint40)`         | `address`         |
 * | Perpl | `Exchange.getAccountById(uint256)`            | `AccountInfo`     |
 *
 * Both were verified against Monad testnet rather than taken from an ABI —
 * `userAddressById(62)` answers `0x15bbc549…7256` and `userAddressById(47)`
 * answers `0x74443181…5c9e`, which are the two accounts in the live Kuru fill
 * in docs/indexer.md §proven; `getAccountById(1)` answers the `AccountInfo`
 * whose `accountAddr` is `0xa91f9339…0cab`. `accountAddress.test.ts` pins the
 * exact calldata and those exact responses, so a drift in either ABI fails
 * loudly instead of writing a wrong address.
 *
 * Kuru answers an **unknown id with the zero address**, not a revert; Perpl
 * reverts. Both mean "no address", and both are stored as no address rather
 * than as `0x000…0`, which would match an agent's wallet exactly as badly as
 * a wrong one.
 */
import { createEffect, S } from 'envio';
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { KURU_ACCOUNT_CORE, PERPL_EXCHANGE } from './seeds.ts';

/** `AccountCore.userAddressById`, from @toxicflow-labs/ts-sdk's accountCoreAbi. */
export const KURU_ACCOUNT_CORE_READ_ABI = [
  {
    type: 'function',
    name: 'userAddressById',
    stateMutability: 'view',
    inputs: [{ name: 'userId', type: 'uint40' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

/**
 * `Exchange.getAccountById` — the id-keyed twin of the `getAccountByAddr` in
 * packages/venues/src/perpl/onboarding.ts, same `AccountInfo` struct. Not in
 * Perpl's api-docs; found by selector against the live Exchange.
 */
export const PERPL_EXCHANGE_READ_ABI = [
  {
    type: 'function',
    name: 'getAccountById',
    stateMutability: 'view',
    inputs: [{ name: 'accountId', type: 'uint256' }],
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

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The Monad testnet RPC the reads go to; `config.yaml`'s fallback RPC by default. */
export const DEFAULT_RPC_URL = 'https://testnet-rpc.monad.xyz';

export type Venue = 'KURU' | 'PERPL';

/** The `eth_call` one resolution needs. Pure — no network, no clock. */
export function accountAddressCall(
  venue: Venue,
  accountId: bigint,
): { readonly to: string; readonly data: string } {
  return venue === 'KURU'
    ? {
        to: KURU_ACCOUNT_CORE,
        data: encodeFunctionData({
          abi: KURU_ACCOUNT_CORE_READ_ABI,
          functionName: 'userAddressById',
          args: [Number(accountId)],
        }),
      }
    : {
        to: PERPL_EXCHANGE,
        data: encodeFunctionData({
          abi: PERPL_EXCHANGE_READ_ABI,
          functionName: 'getAccountById',
          args: [accountId],
        }),
      };
}

/**
 * The address in an `eth_call` result, lowercased — `undefined` when the venue
 * says it has no such account (Kuru: the zero address; Perpl: `0x`).
 */
export function decodeAccountAddress(venue: Venue, result: string): string | undefined {
  if (result === '0x' || result === '') return undefined;
  const address =
    venue === 'KURU'
      ? decodeFunctionResult({
          abi: KURU_ACCOUNT_CORE_READ_ABI,
          functionName: 'userAddressById',
          data: result as `0x${string}`,
        })
      : decodeFunctionResult({
          abi: PERPL_EXCHANGE_READ_ABI,
          functionName: 'getAccountById',
          data: result as `0x${string}`,
        }).accountAddr;
  const lower = address.toLowerCase();
  return lower === ZERO_ADDRESS ? undefined : lower;
}

/** How a resolution reaches the chain. Substituted in tests; `fetch` in production. */
export type EthCall = (request: { to: string; data: string }) => Promise<string>;

/**
 * An `eth_call` over JSON-RPC.
 *
 * A **revert** is an answer: Perpl reverts for an id it has never issued, and
 * that is "no address", not a fault. Anything else — a transport failure, an
 * RPC that is down — throws, so Envio retries the effect instead of caching a
 * null address that would then never be re-read.
 */
export function rpcEthCall(
  rpcUrl: string = DEFAULT_RPC_URL,
  fetchImpl: typeof fetch = fetch,
): EthCall {
  return async ({ to, data }) => {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
    });
    if (!response.ok) throw new Error(`eth_call to ${rpcUrl} answered ${response.status}`);
    const payload = (await response.json()) as {
      result?: string;
      error?: { code?: number; message?: string };
    };
    if (typeof payload.result === 'string') return payload.result;
    const message = payload.error?.message ?? 'no result and no error';
    if (message.includes('reverted')) return '0x';
    throw new Error(`eth_call to ${rpcUrl} failed: ${message}`);
  };
}

/** One resolution, end to end. `undefined` when the venue has no such account. */
export async function readAccountAddress(
  venue: Venue,
  accountId: bigint,
  call: EthCall,
): Promise<string | undefined> {
  return decodeAccountAddress(venue, await call(accountAddressCall(venue, accountId)));
}

/**
 * The effect handlers call. Envio deduplicates by input and caches the answer,
 * so one account id costs one RPC read for the life of the indexer however
 * many fills it has.
 */
export const accountAddressEffect = createEffect(
  {
    name: 'accountAddressById',
    input: { venue: S.string, accountId: S.bigint },
    output: S.nullable(S.string),
    // Monad's public RPC is the fallback source and is shared with the log
    // ingestion; these reads are one per account, so they are kept well under
    // anything that would compete with it.
    rateLimit: { calls: 20, per: 'second' },
    cache: true,
  },
  async ({ input }) => {
    const call = rpcEthCall(process.env['ENVIO_MONAD_RPC_URL'] ?? DEFAULT_RPC_URL);
    const address = await readAccountAddress(input.venue as Venue, input.accountId, call);
    return address ?? null;
  },
);
