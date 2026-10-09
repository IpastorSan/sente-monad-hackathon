/**
 * Tests for account-id → address resolution.
 *
 * The calldata and the responses below are not invented: they are the exact
 * bytes Monad testnet returned for `eth_call` against Kuru's account-id
 * AccountCore (0xdbaaDe7B…8038) on 2026-10-09 (SEN-185). `getAccountOwner(1)`
 * is AccountCore's own fee collector's root; `getAccountOwner(5)` another
 * root. (Set C's `userAddressById(62)`/`(47)` resolved the §proven fill's two
 * accounts; that getter reverts on this AccountCore.) If the ABI drifts, the
 * selector changes and these fail — which is the point: the alternative is an
 * indexer that quietly writes a wrong address, or none, onto a leaderboard row.
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
import { KURU_ACCOUNT_CORE } from './seeds.ts';

/** `getAccountOwner(uint40)` → `0xe23d95bb`, argument right-aligned in one word. */
const KURU_CALLDATA_1 =
  '0xe23d95bb0000000000000000000000000000000000000000000000000000000000000001';

/** The chain's answer for Kuru account 1. */
const KURU_RESULT_1 = '0x000000000000000000000000c64346f7ddc776b34eaa44c0b61d564797038143';

/** …and for account 5. */
const KURU_RESULT_5 = '0x000000000000000000000000d26acbf9930a85f87625d85e1ac7af45ae9ac883';

test('the Kuru call is AccountCore.getAccountOwner with the id in one word', () => {
  const call = accountAddressCall(1n);
  assert.equal(call.to, KURU_ACCOUNT_CORE);
  assert.equal(call.data, KURU_CALLDATA_1);
});

test('the live Kuru answers decode to the accounts’ root owners', () => {
  assert.equal(decodeAccountAddress(KURU_RESULT_1), '0xc64346f7ddc776b34eaa44c0b61d564797038143');
  assert.equal(decodeAccountAddress(KURU_RESULT_5), '0xd26acbf9930a85f87625d85e1ac7af45ae9ac883');
});

test('"no such account" is no address, never the zero address', () => {
  // AccountCore answers an unknown id with the zero address, not a revert…
  assert.equal(decodeAccountAddress(`0x${'0'.repeat(64)}`), undefined);
  // …and a revert reaches the decoder as empty data.
  assert.equal(decodeAccountAddress('0x'), undefined);
});

test('a resolution is one eth_call and its decode', async () => {
  const calls: { to: string; data: string }[] = [];
  const call: EthCall = async (request) => {
    calls.push(request);
    return KURU_RESULT_1;
  };
  assert.equal(await readAccountAddress(1n, call), '0xc64346f7ddc776b34eaa44c0b61d564797038143');
  assert.deepEqual(calls, [{ to: KURU_ACCOUNT_CORE, data: KURU_CALLDATA_1 }]);
});

test('a revert is an answer; a transport failure is not', async () => {
  const reverting = rpcEthCall('http://rpc.invalid', async () =>
    Response.json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }),
  );
  assert.equal(await readAccountAddress(999_999n, reverting), undefined);

  // An RPC that is down must throw so Envio retries, rather than caching a
  // null address that would never be read again.
  const down = rpcEthCall('http://rpc.invalid', async () =>
    Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } }),
  );
  await assert.rejects(() => readAccountAddress(62n, down), /header not found/);

  const offline = rpcEthCall('http://rpc.invalid', async () => new Response('', { status: 502 }));
  await assert.rejects(() => readAccountAddress(62n, offline), /answered 502/);
});
