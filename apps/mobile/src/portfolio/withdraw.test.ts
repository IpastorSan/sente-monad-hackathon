/** Withdraw rules (SEN-153). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getAddress, type Address } from 'viem';

import { parseAmount } from '../agents/amounts.ts';
import { AUSD } from '../agents/mandate.ts';
import {
  checkAmount,
  checkRecipient,
  classifyCode,
  KNOWN_RECIPIENTS_MAX,
  KURU_WITHDRAW_TOKENS,
  kuruAvailable,
  kuruResult,
  kuruReview,
  maxInput,
  parseKnownRecipients,
  recipientWarnings,
  rememberRecipient,
  sendResult,
  sendReview,
  WITHDRAW_TOKENS,
} from './withdraw.ts';

const USDC = WITHDRAW_TOKENS[0]!;
const SELF = getAddress('0x51c0e0fa1bb4ba0e0f05e1d6c8a5b4f3e2d19e2d');
// Checksummed, derived rather than typed so the test cannot carry a typo.
const OTHER = getAddress('0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8ec21e');
const AGENT = getAddress('0x00000000000000000000000000000000000a9e17');

test('only USDC and AUSD can be withdrawn — never MON (gotcha 12)', () => {
  assert.deepEqual(
    WITHDRAW_TOKENS.map((t) => t.symbol),
    ['USDC', 'AUSD'],
  );
  assert.deepEqual(
    KURU_WITHDRAW_TOKENS.map((t) => t.symbol),
    ['USDC'],
  );
});

test('checkAmount parses, bounds and refuses to judge an unread balance', () => {
  assert.deepEqual(checkAmount('  ', USDC, 10n), { kind: 'empty' });
  assert.equal(checkAmount('1.1234567', USDC, 10_000_000n).kind, 'invalid');
  assert.equal(checkAmount('1,5', USDC, 10_000_000n).kind, 'invalid');
  assert.equal(checkAmount('0.000', USDC, 10_000_000n).kind, 'zero');
  assert.deepEqual(checkAmount('2.5', USDC, 2_500_000n), { kind: 'ok', atoms: 2_500_000n });
  const over = checkAmount('2.500001', USDC, 2_500_000n);
  assert.equal(over.kind, 'too_much');
  assert.match((over as { message: string }).message, /2\.5 USDC available/);
  assert.equal(checkAmount('1', USDC, null).kind, 'invalid');
});

test('Max round-trips to exactly the balance, ungrouped', () => {
  const balance = 1_234_567_890_123n;
  const input = maxInput(balance, USDC);
  assert.equal(input, '1234567.890123');
  assert.equal(parseAmount(input, USDC.decimals), balance);
  assert.deepEqual(checkAmount(input, USDC, balance), { kind: 'ok', atoms: balance });
  assert.equal(maxInput(0n, USDC), '');
  assert.equal(maxInput(null, USDC), '');
});

test('kuruAvailable reads the free balance, not the total, and keeps unknown unknown', () => {
  const balances = [{ asset: 'USDC', available: '3.25', locked: '10', total: '13.25' }];
  assert.equal(kuruAvailable(balances, USDC), 3_250_000n);
  assert.equal(kuruAvailable([], USDC), 0n);
  assert.equal(kuruAvailable(null, USDC), null);
  assert.equal(
    kuruAvailable([{ asset: 'USDC', available: 'NaN', locked: '0', total: '0' }], USDC),
    null,
  );
});

test('checkRecipient enforces the checksum on mixed case', () => {
  assert.deepEqual(checkRecipient('', SELF), { kind: 'empty' });
  assert.deepEqual(checkRecipient(` ${OTHER} `, SELF), { kind: 'ok', address: OTHER });
  // All-lowercase carries no checksum: accepted, returned checksummed.
  assert.deepEqual(checkRecipient(OTHER.toLowerCase(), SELF), { kind: 'ok', address: OTHER });
  // One letter's case flipped: exactly the typo a checksum catches.
  const i = OTHER.search(/[a-f]/i);
  const flipped =
    OTHER.slice(0, i) +
    (OTHER[i] === OTHER[i]!.toLowerCase() ? OTHER[i]!.toUpperCase() : OTHER[i]!.toLowerCase()) +
    OTHER.slice(i + 1);
  const bad = checkRecipient(flipped, SELF);
  assert.equal(bad.kind, 'invalid');
  assert.match((bad as { message: string }).message, /checksum/);
});

test('checkRecipient refuses malformed, zero, token and own addresses', () => {
  for (const input of ['0x123', 'hello', `${OTHER}00`, OTHER.slice(2)]) {
    assert.equal(checkRecipient(input, SELF).kind, 'invalid', input);
  }
  assert.match(
    (checkRecipient(`0x${'0'.repeat(40)}`, SELF) as { message: string }).message,
    /zero address/,
  );
  assert.match((checkRecipient(AUSD.address, SELF) as { message: string }).message, /token/);
  assert.match((checkRecipient(SELF.toLowerCase(), SELF) as { message: string }).message, /own/);
  assert.equal(checkRecipient(SELF, null).kind, 'ok');
});

test('classifyCode tells a delegated EOA from a contract', () => {
  assert.equal(classifyCode('0x'), 'none');
  assert.equal(classifyCode(undefined), 'none');
  assert.equal(classifyCode(`0xef0100${'ab'.repeat(20)}`), 'delegated');
  assert.equal(classifyCode('0x6080604052'), 'contract');
  assert.equal(classifyCode(`0xef0100${'ab'.repeat(20)}00`), 'contract');
});

test('recipientWarnings: agent, contract, unknown code and new', () => {
  const agents = [{ name: 'Tengen', address: AGENT }];
  const kinds = (facts: Parameters<typeof recipientWarnings>[0]) =>
    recipientWarnings(facts).map((w) => w.kind);

  assert.deepEqual(kinds({ address: OTHER, agents, known: [], code: 'none' }), ['new']);
  assert.deepEqual(
    kinds({ address: OTHER, agents, known: [OTHER.toLowerCase()], code: 'none' }),
    [],
  );
  assert.deepEqual(kinds({ address: OTHER, agents, known: [OTHER], code: 'delegated' }), []);
  assert.deepEqual(kinds({ address: OTHER, agents, known: [OTHER], code: 'contract' }), [
    'contract',
  ]);
  assert.deepEqual(kinds({ address: OTHER, agents, known: [OTHER], code: null }), ['code_unknown']);
  assert.deepEqual(kinds({ address: OTHER, agents: null, known: [OTHER], code: 'none' }), [
    'agents_unknown',
  ]);
  const agent = recipientWarnings({ address: AGENT, agents, known: [], code: 'delegated' });
  assert.deepEqual(agent, [{ kind: 'agent', agentName: 'Tengen' }]);
});

test('rememberRecipient keeps newest first, deduplicated and capped', () => {
  let known: string[] = [];
  known = rememberRecipient(known, OTHER);
  known = rememberRecipient(known, AGENT);
  known = rememberRecipient(known, OTHER);
  assert.deepEqual(known, [OTHER.toLowerCase(), AGENT.toLowerCase()]);
  for (let n = 1; n <= 30; n += 1) {
    known = rememberRecipient(known, getAddress(`0x${n.toString(16).padStart(40, '0')}`));
  }
  assert.equal(known.length, KNOWN_RECIPIENTS_MAX);
});

test('parseKnownRecipients survives anything stored', () => {
  assert.deepEqual(parseKnownRecipients(null), []);
  assert.deepEqual(parseKnownRecipients('not json'), []);
  assert.deepEqual(parseKnownRecipients('{"a":1}'), []);
  assert.deepEqual(parseKnownRecipients(JSON.stringify([OTHER.toLowerCase(), 5, 'x'])), [
    OTHER.toLowerCase(),
  ]);
});

test('review copy names amount, token and a short address', () => {
  assert.equal(
    sendReview(12_500_000n, USDC, OTHER.toLowerCase() as Address),
    `You send 12.5 USDC to ${OTHER.slice(0, 6)}…c21e`,
  );
  assert.equal(
    kuruReview(1_000_000_000n, USDC),
    'You move 1,000 USDC from your Kuru account to your wallet',
  );
});

test('sendResult: only included succeeds, only reverted fails (SEN-127)', () => {
  assert.equal(sendResult('included', 1n, USDC, OTHER).tone, 'ok');
  const reverted = sendResult('reverted', 1n, USDC, OTHER);
  assert.equal(reverted.tone, 'error');
  assert.equal(reverted.final, false);
  for (const status of ['pending', 'unknown'] as const) {
    const result = sendResult(status, 1n, USDC, OTHER);
    assert.equal(result.tone, 'info', status);
    assert.match(result.detail, /Don’t send it again/);
  }
});

test('kuruResult: pending is never a failure', () => {
  assert.equal(kuruResult('completed', 1n, USDC).tone, 'ok');
  assert.equal(kuruResult('failed', 1n, USDC).tone, 'error');
  assert.equal(kuruResult('expired', 1n, USDC).tone, 'error');
  const pending = kuruResult('pending', 1n, USDC);
  assert.equal(pending.tone, 'info');
  assert.equal(pending.final, true);
});
