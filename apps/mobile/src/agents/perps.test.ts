import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUSD, KURU_TOKENS } from './mandate.ts';
import { perpsFundHint, perpsLine, perpsPollMs } from './perps.ts';

const USDC = KURU_TOKENS.find((token) => token.symbol === 'USDC')!;

test('opening reads as live and is polled', () => {
  const status = { state: 'opening' as const };
  assert.deepEqual(perpsLine(status), {
    tone: 'live',
    title: 'Perps: opening account…',
    detail: 'Sente is opening the agent’s Perpl account and enrolling its key.',
  });
  assert.equal(perpsPollMs(status), 3_000);
  assert.equal(perpsPollMs({ state: 'ready' }), null);
});

test('needs_funds names the minimum and what the agent holds, and offers AUSD', () => {
  assert.deepEqual(
    perpsLine({
      state: 'needs_funds',
      minimumAtoms: '100000000',
      walletAtoms: '40500000',
      capAtoms: '500000000',
    }),
    {
      tone: 'held',
      title: 'Perps need at least 100 AUSD — fund it',
      detail:
        'Perpl opens an account with 100 AUSD or more. The agent holds 40.5 AUSD; Sente ' +
        'opens the account once it has enough.',
      fund: 'AUSD',
    },
  );
});

test('a cap under the minimum says to amend, not to fund', () => {
  const line = perpsLine({
    state: 'cap_below_minimum',
    minimumAtoms: '100000000',
    capAtoms: '50000000',
  });
  assert.equal(line?.fund, undefined);
  assert.match(line!.detail, /at most 50 AUSD into Perpl, under the 100 AUSD .* Amend the mandate/);
});

test('gas and failures carry the API’s own sentence', () => {
  const gas = perpsLine({ state: 'needs_gas', message: 'the agent needs 0.0355 MON' });
  assert.deepEqual(gas, {
    tone: 'held',
    title: 'Perps need gas',
    detail: 'the agent needs 0.0355 MON',
    fund: 'MON',
  });
  assert.equal(
    perpsLine({ state: 'failed', message: 'createAccount reverted.' })?.detail,
    'createAccount reverted. Sente tries again shortly.',
  );
});

test('ready shows the account and its collateral', () => {
  assert.deepEqual(perpsLine({ state: 'ready', accountId: '505', collateralAtoms: '120000000' }), {
    tone: 'idle',
    title: 'Perps ready',
    detail: 'Perpl account 505 · 120 AUSD collateral',
  });
});

test('nothing to say without Perpl, for a revoked agent, or when unknown', () => {
  assert.equal(perpsLine(null), null);
  assert.equal(perpsLine({ state: 'not_in_mandate' }), null);
  assert.equal(perpsLine({ state: 'revoked' }), null);
  assert.equal(perpsLine({ state: 'unavailable', message: 'rpc' }), null);
});

test('the Fund sheet suggests AUSD of at least 100 when perps are in the mandate', () => {
  assert.equal(perpsFundHint(['kuru'], AUSD, 1n), null);
  assert.equal(
    perpsFundHint(['kuru', 'perpl'], USDC, null),
    'Perps trade with AUSD: send at least 100 AUSD to open the agent’s Perpl account.',
  );
  assert.equal(
    perpsFundHint(['perpl'], AUSD, 50_000_000n),
    'Perpl opens an account with at least 100 AUSD, so this alone won’t open it.',
  );
  assert.equal(
    perpsFundHint(['perpl'], AUSD, 100_000_000n),
    'Sente opens the agent’s Perpl account with this AUSD, up to the mandate’s cap.',
  );
});
