import { encodeAbiParameters, getAddress, numberToHex, type Hash, type Hex } from 'viem';

import {
  USER_OPERATION_EVENT_TOPIC,
  userOperationOutcome,
  type UserOperationLogClient,
} from './user-operation-logs';

const USER_OP_HASH = `0x${'7a'.repeat(32)}` as Hash;
const SENDER = getAddress(`0x${'11'.repeat(20)}`);
const PAYMASTER = getAddress(`0x${'22'.repeat(20)}`);
const TX = `0x${'33'.repeat(32)}` as Hash;

/** One `UserOperationEvent` as a node would return it. */
function log(options: { success: boolean; blockNumber?: bigint }) {
  return {
    topics: [
      USER_OPERATION_EVENT_TOPIC,
      USER_OP_HASH,
      `0x${SENDER.slice(2).toLowerCase().padStart(64, '0')}` as Hex,
      `0x${PAYMASTER.slice(2).toLowerCase().padStart(64, '0')}` as Hex,
    ] as [Hex, ...Hex[]],
    // nonce, success, actualGasCost, actualGasUsed — the non-indexed half.
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [7n, options.success, 123_456n, 78_900n],
    ),
    transactionHash: TX,
    blockNumber: numberToHex(options.blockNumber ?? 65_392_922n),
  };
}

/** A node holding `logs`, recording the filters it was asked for. */
function chain(logs: readonly ReturnType<typeof log>[], latest = 65_392_930n) {
  const filters: unknown[] = [];
  const client = {
    request: (args: { method: string; params?: unknown[] }) => {
      if (args.method === 'eth_blockNumber') return Promise.resolve(numberToHex(latest));
      filters.push(args.params?.[0]);
      return Promise.resolve(logs);
    },
  } as unknown as UserOperationLogClient;
  return { client, filters };
}

describe('userOperationOutcome', () => {
  it('reads the OPERATION’s own success flag, and where it landed', async () => {
    const { client } = chain([log({ success: true })]);

    const outcome = await userOperationOutcome(client, USER_OP_HASH);

    expect(outcome).toEqual({
      userOpHash: USER_OP_HASH,
      success: true,
      sender: SENDER,
      paymaster: PAYMASTER,
      transactionHash: TX,
      blockNumber: 65_392_922n,
      actualGasCost: 123_456n,
      actualGasUsed: 78_900n,
    });
  });

  it('reports a REVERTED operation as reverted, not as absent', async () => {
    // Gotcha 8: this is the case a transaction receipt gets wrong — the bundle
    // transaction succeeded, and the operation inside it did not.
    const { client } = chain([log({ success: false })]);

    await expect(userOperationOutcome(client, USER_OP_HASH)).resolves.toMatchObject({
      success: false,
      transactionHash: TX,
    });
  });

  it('is null while nothing has landed — "not yet", never "it failed"', async () => {
    const { client } = chain([]);

    await expect(userOperationOutcome(client, USER_OP_HASH)).resolves.toBeNull();
  });

  it('filters on the event and the hash, over a bounded window', async () => {
    const { client, filters } = chain([log({ success: true })], 1_000n);

    await userOperationOutcome(client, USER_OP_HASH, { lookbackBlocks: 50n });

    expect(filters).toEqual([
      {
        fromBlock: numberToHex(950n),
        toBlock: 'latest',
        // No EntryPoint address: v0.6 and v0.7 emit the same event at different
        // addresses, and the hash is already a 32-byte match.
        topics: [USER_OPERATION_EVENT_TOPIC, USER_OP_HASH],
      },
    ]);
  });

  it('does not ask for a negative block range on a young chain', async () => {
    const { client, filters } = chain([], 10n);

    await userOperationOutcome(client, USER_OP_HASH, { lookbackBlocks: 50n });

    expect(filters).toEqual([expect.objectContaining({ fromBlock: numberToHex(0n) })]);
  });
});
