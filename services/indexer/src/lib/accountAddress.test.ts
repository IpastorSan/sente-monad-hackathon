/**
 * Tests for account-id → address resolution.
 *
 * The calldata and the responses below are not invented: they are the exact
 * bytes Monad testnet returned for `eth_call` against the two contracts in
 * config.yaml on 2026-09-18. `userAddressById(62)` and `userAddressById(47)`
 * resolve the two accounts of the live Kuru fill in docs/indexer.md §proven
 * (`kuru-62` taker, `kuru-47` maker), neither of which registered inside the
 * indexed window. If either ABI drifts, the selector changes and these fail —
 * which is the point: the alternative is an indexer that quietly writes a
 * wrong address, or none, onto a leaderboard row.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountAddressCall,
  decodeAccountAddress,
  readAccountAddress,
  rpcEthCall,
  type EthCall,
} from './accountAddress.ts';
import { KURU_ACCOUNT_CORE, PERPL_EXCHANGE } from './seeds.ts';

/** `userAddressById(uint40)` → `0x686067c5`, argument right-aligned in one word. */
const KURU_CALLDATA_62 =
  '0x686067c5000000000000000000000000000000000000000000000000000000000000003e';

/** `getAccountById(uint256)` → `0x05aca141`. */
const PERPL_CALLDATA_1 =
  '0x05aca141' + '1'.padStart(64, '0');

/** The chain's answer for Kuru account 62 — the taker of the §proven fill. */
const KURU_RESULT_62 =
  '0x00000000000000000000000015bbc549326dd8d053233c3a546aa7fdabb57256';

/** …and for account 47, the maker of the same fill. */
const KURU_RESULT_47 =
  '0x00000000000000000000000074443181214751970a785f5675bd372735245c9e';

/**
 * The `AccountInfo` struct for Perpl account 1: accountId, balanceCNS,
 * lockedBalanceCNS, frozen, accountAddr, then the four position banks. The
 * address is the fifth word; reading any other one yields a plausible-looking
 * address made of balance digits, which is why this is pinned whole.
 */
const PERPL_RESULT_1 =
  '0x0000000000000000000000000000000000000000000000000000000000000001' +
  '00000000000000000000000000000000000000000000000000002a86ccb8a966' +
  '0000000000000000000000000000000000000000000000000000013a896fd37a' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000a91f9339e65d6d0ded8861aa91de9e6ae9910cab' +
  '2000000000000000000000000000000000000000000000010001000100010000' +
  '0000000000000000000000000000000000000000000000008000000000008000' +
  '8000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000';

test('the Kuru call is AccountCore.userAddressById with the id in one word', () => {
  const call = accountAddressCall('KURU', 62n);
  assert.equal(call.to, KURU_ACCOUNT_CORE);
  assert.equal(call.data, KURU_CALLDATA_62);
});

test('the Perpl call is Exchange.getAccountById', () => {
  const call = accountAddressCall('PERPL', 1n);
  assert.equal(call.to, PERPL_EXCHANGE);
  assert.equal(call.data, PERPL_CALLDATA_1);
});

test('the live Kuru answers decode to the two accounts of the proven fill', () => {
  assert.equal(
    decodeAccountAddress('KURU', KURU_RESULT_62),
    '0x15bbc549326dd8d053233c3a546aa7fdabb57256',
  );
  assert.equal(
    decodeAccountAddress('KURU', KURU_RESULT_47),
    '0x74443181214751970a785f5675bd372735245c9e',
  );
});

test('the live Perpl answer decodes to accountAddr, not to another struct word', () => {
  assert.equal(
    decodeAccountAddress('PERPL', PERPL_RESULT_1),
    '0xa91f9339e65d6d0ded8861aa91de9e6ae9910cab',
  );
});

test('"no such account" is no address, never the zero address', () => {
  // Kuru answers an unknown id with the zero address rather than reverting…
  assert.equal(
    decodeAccountAddress('KURU', `0x${'0'.repeat(64)}`),
    undefined,
  );
  // …and a revert reaches the decoder as empty data.
  assert.equal(decodeAccountAddress('PERPL', '0x'), undefined);
});

test('a resolution is one eth_call and its decode', async () => {
  const calls: { to: string; data: string }[] = [];
  const call: EthCall = async (request) => {
    calls.push(request);
    return KURU_RESULT_62;
  };
  assert.equal(
    await readAccountAddress('KURU', 62n, call),
    '0x15bbc549326dd8d053233c3a546aa7fdabb57256',
  );
  assert.deepEqual(calls, [{ to: KURU_ACCOUNT_CORE, data: KURU_CALLDATA_62 }]);
});

test('a revert is an answer; a transport failure is not', async () => {
  const reverting = rpcEthCall('http://rpc.invalid', async () =>
    Response.json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }),
  );
  assert.equal(await readAccountAddress('PERPL', 999_999n, reverting), undefined);

  // An RPC that is down must throw so Envio retries, rather than caching a
  // null address that would never be read again.
  const down = rpcEthCall('http://rpc.invalid', async () =>
    Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } }),
  );
  await assert.rejects(() => readAccountAddress('KURU', 62n, down), /header not found/);

  const offline = rpcEthCall('http://rpc.invalid', async () => new Response('', { status: 502 }));
  await assert.rejects(() => readAccountAddress('KURU', 62n, offline), /answered 502/);
});
