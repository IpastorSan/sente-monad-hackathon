/**
 * Account id → account address, read off the chain on first sight.
 *
 * **Why this exists.** `Account.address` used to be written only by the
 * one-shot registration event, `AccountRegistered`, and `config.yaml` starts
 * about seven days before the indexer was deployed. An account registered
 * *before* that window never emits its registration again, so its address
 * stayed null forever; a Kuru maker that is only ever seen as a record inside
 * somebody else's `TradesPacked` log never had one at all. `services/api`
 * matches agents with `where: { address: { _in: […] } }` and drops
 * null-address rows, so those accounts are invisible on the leaderboard and
 * nothing heals them.
 *
 * **Why a contract read and not one of the cheaper options.**
 *
 * - *From the fill events themselves*: they do not carry it. `TradesPacked`
 *   has an `executor` (whoever submitted the order — an authorised signer,
 *   not necessarily the account), and the maker leg inside `packedTrades`
 *   carries a bare `uint40` id. Equating `executor` with the account would
 *   put a wrong address on a leaderboard row, which is worse than none.
 * - *An earlier `start_block` for the registration events only*: not
 *   expressible. Envio's per-contract `start_block` is documented in
 *   `envio/evm.schema.json` as "Can be greater than the chain start_block for
 *   more specific indexing" — later only. Reaching registrations from before
 *   the window means moving the whole chain's `start_block` back, and with it
 *   the event budget (docs/indexer.md §budget).
 *
 * So the id is resolved against AccountCore, once per account, through an
 * Envio effect (deduplicated and cached, so a re-sync does not re-read):
 * `AccountCore.getAccountOwner(uint40)` → `address`.
 *
 * Kuru's account-id AccountCore (SEN-185) has no per-account address: an id is
 * a root or a child of one, and both resolve to the ROOT OWNER — the wallet
 * that deposits, signs and is matched to a Sente agent. Set C's
 * `userAddressById` is gone from it (it reverts), so this is the getter.
 *
 * That call was verified against Monad testnet rather than taken from an ABI,
 * on 2026-10-09: `getAccountOwner(1)` answers `0xc64346f7…8143` (AccountCore's
 * own fee collector) and `getAccountOwner(5)` answers `0xd26aCBf9…C883`.
 * `accountAddress.test.ts` pins the exact calldata and those exact responses,
 * so a drift in the ABI fails loudly instead of writing a wrong address.
 *
 * AccountCore answers an **unknown id with the zero address**, not a revert; a
 * revert is read the same way. Both mean "no address", and both are stored as
 * no address rather than as `0x000…0`, which would match an agent's wallet
 * exactly as badly as a wrong one.
 */
import { createEffect, S } from 'envio';
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { KURU_ACCOUNT_CORE } from './seeds.ts';

/** `AccountCore.getAccountOwner`, from @toxicflow-labs/ts-sdk 0.3's accountCoreAbi. */
export const KURU_ACCOUNT_CORE_READ_ABI = [
  {
    type: 'function',
    name: 'getAccountOwner',
    stateMutability: 'view',
    inputs: [{ name: 'accountId', type: 'uint40' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The Monad testnet RPC the reads go to; `config.yaml`'s fallback RPC by default. */
export const DEFAULT_RPC_URL = 'https://testnet-rpc.monad.xyz';

/** The `eth_call` one resolution needs. Pure — no network, no clock. */
export function accountAddressCall(accountId: bigint): {
  readonly to: string;
  readonly data: string;
} {
  return {
    to: KURU_ACCOUNT_CORE,
    data: encodeFunctionData({
      abi: KURU_ACCOUNT_CORE_READ_ABI,
      functionName: 'getAccountOwner',
      args: [Number(accountId)],
    }),
  };
}

/**
 * The address in an `eth_call` result, lowercased — `undefined` when
 * AccountCore has no such account (the zero address, or a revert's `0x`).
 */
export function decodeAccountAddress(result: string): string | undefined {
  if (result === '0x' || result === '') return undefined;
  const address = decodeFunctionResult({
    abi: KURU_ACCOUNT_CORE_READ_ABI,
    functionName: 'getAccountOwner',
    data: result as `0x${string}`,
  });
  const lower = address.toLowerCase();
  return lower === ZERO_ADDRESS ? undefined : lower;
}

/** How a resolution reaches the chain. Substituted in tests; `fetch` in production. */
export type EthCall = (request: { to: string; data: string }) => Promise<string>;

/**
 * An `eth_call` over JSON-RPC.
 *
 * A **revert** is an answer — "no address", not a fault. Anything else — a
 * transport failure, an RPC that is down — throws, so Envio retries the effect
 * instead of caching a null address that would then never be re-read.
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

/** One resolution, end to end. `undefined` when AccountCore has no such account. */
export async function readAccountAddress(
  accountId: bigint,
  call: EthCall,
): Promise<string | undefined> {
  return decodeAccountAddress(await call(accountAddressCall(accountId)));
}

/**
 * The effect handlers call. Envio deduplicates by input and caches the answer,
 * so one account id costs one RPC read for the life of the indexer however
 * many fills it has.
 */
export const accountAddressEffect = createEffect(
  {
    name: 'accountAddressById',
    input: { accountId: S.bigint },
    output: S.nullable(S.string),
    // Monad's public RPC is the fallback source and is shared with the log
    // ingestion; these reads are one per account, so they are kept well under
    // anything that would compete with it.
    rateLimit: { calls: 20, per: 'second' },
    cache: true,
  },
  async ({ input }) => {
    const call = rpcEthCall(process.env['ENVIO_MONAD_RPC_URL'] ?? DEFAULT_RPC_URL);
    const address = await readAccountAddress(input.accountId, call);
    return address ?? null;
  },
);
