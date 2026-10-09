/**
 * Tests for account-id → address resolution.
 *
 * The calldata and the responses below are not invented: they are the exact
 * bytes Monad testnet returned for `eth_call` against the two contracts in
 * AccountCore on 2026-09-18. `userAddressById(62)` and `userAddressById(47)`
 * resolve the two accounts of the live Kuru fill in docs/indexer.md §proven
 * (`kuru-62` taker, `kuru-47` maker), neither of which registered inside the
 * indexed window. If the ABI drifts, the selector changes and these fail —
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
import { KURU_ACCOUNT_CORE } from './seeds.ts';

/** `userAddressById(uint40)` → `0x686067c5`, argument right-aligned in one word. */
const KURU_CALLDATA_62 =
  '0x686067c5000000000000000000000000000000000000000000000000000000000000003e';

/** The chain's answer for Kuru account 62 — the taker of the §proven fill. */
const KURU_RESULT_62 = '0x00000000000000000000000015bbc549326dd8d053233c3a546aa7fdabb57256';

/** …and for account 47, the maker of the same fill. */
const KURU_RESULT_47 = '0x00000000000000000000000074443181214751970a785f5675bd372735245c9e';

test('the Kuru call is AccountCore.userAddressById with the id in one word', () => {
  const call = accountAddressCall(62n);
  assert.equal(call.to, KURU_ACCOUNT_CORE);
  assert.equal(call.data, KURU_CALLDATA_62);
});

test('the live Kuru answers decode to the two accounts of the proven fill', () => {
  assert.equal(decodeAccountAddress(KURU_RESULT_62), '0x15bbc549326dd8d053233c3a546aa7fdabb57256');
  assert.equal(decodeAccountAddress(KURU_RESULT_47), '0x74443181214751970a785f5675bd372735245c9e');
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
    return KURU_RESULT_62;
  };
  assert.equal(await readAccountAddress(62n, call), '0x15bbc549326dd8d053233c3a546aa7fdabb57256');
  assert.deepEqual(calls, [{ to: KURU_ACCOUNT_CORE, data: KURU_CALLDATA_62 }]);
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
