/**
 * Reading a USER OPERATION's own outcome off the chain, with no bundler
 * involved (SEN-42).
 *
 * ## Why this exists next to a perfectly good bundler
 *
 * `eth_getUserOperationReceipt` is a BUNDLER method, and a bundler answers for
 * the operations it knows about. A Privy-sponsored send is bundled by Privy's
 * sponsorship provider (`alchemy`), not by our Pimlico endpoint, so whether ours
 * would answer at all was an open question — and a confirmation view that could
 * only ask Pimlico would sit on `pending` forever for exactly the sends this
 * phase is built on.
 *
 * **It does answer**: measured on 2026-09-24, Pimlico's public Monad endpoint
 * returned a full receipt for an operation Alchemy bundled
 * (docs/privy-sponsorship.md, run 3, check 5b), which is why
 * `PollingOperationTracker` needed nothing new. This file is the source that
 * depends on no bundler's indexer: the EntryPoint's `UserOperationEvent` is on
 * chain either way, and it carries the one field that decides the question —
 * `success`. CLAUDE.md gotcha 8: the carrying transaction can succeed while the
 * operation inside it reverted, so the transaction receipt is not an answer.
 *
 * Used by the live probes today. It is deliberately here rather than in
 * `scripts/` so the tracker can be pointed at it the day a bundler stops
 * answering, which is a one-line change and not a rewrite.
 *
 * Deliberately NOT filtered by EntryPoint address: v0.6 and v0.7 emit the same
 * event signature at different addresses, and Privy's delegated accounts are
 * free to move between them. The `userOpHash` topic is a 32-byte match — there
 * is nothing to gain by also insisting on which EntryPoint emitted it.
 *
 * Pure TS with `.ts` specifiers and no Nest import (CLAUDE.md gotcha 10): the
 * SEN-42 live probe loads this file under node's type stripping.
 */

import {
  decodeEventLog,
  parseAbiItem,
  toEventSelector,
  type Address,
  type Hash,
  type Hex,
} from 'viem';

/** EntryPoint v0.6 and v0.7 both emit this, identically. */
export const USER_OPERATION_EVENT = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
);

/**
 * `0x49628fd1…ec1419f` — derived from the event above rather than pasted, so the
 * filter and the decoder can never disagree about which event this is.
 */
export const USER_OPERATION_EVENT_TOPIC: Hex = toEventSelector(USER_OPERATION_EVENT);

/** What the chain says happened to one user operation. */
export interface UserOperationOutcome {
  userOpHash: Hash;
  /** The OPERATION's own flag, not the transaction's status. */
  success: boolean;
  sender: Address;
  /** The zero address when nobody sponsored it. */
  paymaster: Address;
  transactionHash: Hash;
  blockNumber: bigint;
  actualGasCost: bigint;
  actualGasUsed: bigint;
}

/** One log as `eth_getLogs` returns it, narrowed to what this file reads. */
interface RawLog {
  topics: [Hex, ...Hex[]];
  data: Hex;
  transactionHash: Hash;
  blockNumber: Hex;
}

/**
 * The slice of a viem client this needs — two raw RPC calls.
 *
 * Raw rather than viem's `getLogs`, because the filter here is a topic match on
 * an event whose EntryPoint address is deliberately unconstrained, and because
 * it keeps the fake in a spec to four lines.
 */
export interface UserOperationLogClient {
  request(args: { method: 'eth_blockNumber'; params?: [] }): Promise<Hex>;
  request(args: {
    method: 'eth_getLogs';
    params: [{ fromBlock: Hex; toBlock: Hex | 'latest'; topics: [Hex, Hex] }];
  }): Promise<readonly RawLog[]>;
}

/**
 * How far back to look.
 *
 * 50 blocks is ~15 s at Monad's 300 ms — comfortably more than the ~1.6 s a
 * sponsored send took to land, and short enough that Monad's public RPC accepts
 * the range. A caller polling every 300 ms re-reads the same window, which is
 * cheap and means an operation is never missed because it landed one poll late.
 */
export const USER_OPERATION_LOG_LOOKBACK = 50n;

/**
 * The outcome of `userOpHash`, or `null` while it has not landed.
 *
 * `null` is "not yet", never "it failed": an operation that has not surfaced may
 * still land in the next block, and a caller that treated the two the same would
 * tell a user their transfer failed while it was in flight.
 */
export async function userOperationOutcome(
  client: UserOperationLogClient,
  userOpHash: Hash,
  options: { lookbackBlocks?: bigint; fromBlock?: bigint } = {},
): Promise<UserOperationOutcome | null> {
  // A caller that knows when it submitted passes `fromBlock` and saves a round
  // trip per poll; one that does not looks back a fixed window from the head.
  const from = options.fromBlock ?? (await lookbackFrom(client, options.lookbackBlocks));
  const logs = await client.request({
    method: 'eth_getLogs',
    params: [
      {
        fromBlock: `0x${from.toString(16)}`,
        toBlock: 'latest',
        topics: [USER_OPERATION_EVENT_TOPIC, userOpHash],
      },
    ],
  });
  const log = logs[0];
  if (!log) return null;

  const decoded = decodeEventLog({
    abi: [USER_OPERATION_EVENT],
    topics: log.topics,
    data: log.data,
  });
  const args = decoded.args;
  return {
    userOpHash,
    success: args.success,
    sender: args.sender,
    paymaster: args.paymaster,
    transactionHash: log.transactionHash,
    blockNumber: BigInt(log.blockNumber),
    actualGasCost: args.actualGasCost,
    actualGasUsed: args.actualGasUsed,
  };
}

/** The head block, minus the window. One extra round trip, so it is opt-out. */
async function lookbackFrom(
  client: UserOperationLogClient,
  lookbackBlocks = USER_OPERATION_LOG_LOOKBACK,
): Promise<bigint> {
  const latest = BigInt(await client.request({ method: 'eth_blockNumber' }));
  return latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
}

/**
 * The same read, polled until the operation lands or `timeoutMs` passes.
 *
 * Here rather than in each probe because both of them want it and the loop is
 * where the two mistakes live: polling faster than the chain produces blocks,
 * and treating "not yet" as "failed". `null` still means the operation has not
 * surfaced — which is not the same as having failed.
 */
export async function awaitUserOperation(
  client: UserOperationLogClient,
  userOpHash: Hash,
  options: { timeoutMs?: number; pollMs?: number; fromBlock?: bigint } = {},
): Promise<{ outcome: UserOperationOutcome | null; elapsedMs: number }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  // 300ms is Monad's block time: polling faster only costs requests.
  const pollMs = options.pollMs ?? 300;
  const read = () =>
    userOperationOutcome(client, userOpHash, {
      ...(options.fromBlock === undefined ? {} : { fromBlock: options.fromBlock }),
    });
  const started = Date.now();
  let outcome = await read();
  while (!outcome && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    outcome = await read();
  }
  return { outcome, elapsedMs: Date.now() - started };
}
