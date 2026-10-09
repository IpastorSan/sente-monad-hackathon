/**
 * SEN-187: Sente opens a funded Perpl agent's account and enrolls its key.
 *
 * Every transaction here is signed by an enclave that evaluates the agent's
 * REAL compiled mandate (`compileMandate`) with the fake enclave's `allows`,
 * so "it opened" also means "the policy let every leg through", and a leg the
 * policy would refuse is refused here too.
 */
import { compileMandate } from '@sente/mandate';
import { ERC20_APPROVE_ABI, PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import { encodeFunctionData } from 'viem';

import { allows } from '../demo/testing/fake-enclave';
import { toPerplOnboardingResponse } from '../dto/agent.dto';
import { NOW } from '../tools/testing/agent-fixture';
import { PERPL_ONBOARDING_GAS, perplOnboardingGas } from './perpl-agent';
import { collateralCap, perplOpeningMinimum } from './perpl-onboarding';
import {
  AUSD,
  FEE,
  MINIMUM,
  MON,
  amountsOf,
  perplOnboardingWorld,
} from './testing/perpl-onboarding-world';

const APPROVE = '0x095ea7b3';
const CREATE = '0xcab13915';
const FORWARD = '0x7962f910';
const ALL_GAS = perplOnboardingGas(['approve', 'createAccount', 'allowOrderForwarding']);

/** Lets the background flights a kick started run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('AgentPerplOnboarder — opening (SEN-187)', () => {
  it('opens with what the wallet holds, enrolls the key at once, and records both', async () => {
    const w = await perplOnboardingWorld({ ausd: 120 });
    const status = await w.onboarder.ensure(w.agent, 'fund');

    expect(status).toEqual({ state: 'ready', accountId: 493n, collateralAtoms: AUSD(120) });
    expect(w.selectors()).toEqual([APPROVE, CREATE, FORWARD]);
    // Exact approval: createAccount consumes all of it, nothing stays approved.
    expect(amountsOf(w.signed)).toEqual({ approve: AUSD(120), createAccount: AUSD(120) });
    expect(w.state.allowance).toBe(0n);
    // Enrolled right after opening, not lazily at the first order.
    expect(w.enroll.enrollments).toBe(1);
    expect(await w.secrets.getPerplCredentials(w.agent.id)).toBeDefined();

    const events = await w.onboardingEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      venue: 'perpl',
      status: 'opened',
      trigger: 'fund',
      message: 'Opened Perpl account 493 with 120 AUSD',
      accountId: '493',
      amount: '120',
      amountAtoms: '120000000',
      steps: ['approve', 'createAccount', 'allowOrderForwarding'],
      forwarding: true,
    });
    expect(events[0]!['txHashes']).toHaveLength(3);
    expect(events[1]).toMatchObject({ status: 'enrolled', accountId: '493' });
  });

  it('deposits at most the collateral cap and leaves the rest in the wallet', async () => {
    const w = await perplOnboardingWorld({ ausd: 400, cap: 150 });
    await w.onboarder.ensure(w.agent, 'fund');
    expect(amountsOf(w.signed)).toEqual({ approve: AUSD(150), createAccount: AUSD(150) });
    expect(w.state.ausd).toBe(AUSD(250));
  });

  it('every leg it sends satisfies the compiled policy, at the cap exactly', async () => {
    const w = await perplOnboardingWorld({ ausd: 1_000, cap: 100 });
    await w.onboarder.ensure(w.agent, 'fund');
    const rules = compileMandate(w.agent.mandate);
    expect(w.signed).toHaveLength(3);
    for (const tx of w.signed) {
      expect(allows(rules, tx, NOW)).toBe(true);
      expect(BigInt(tx.value!)).toBe(0n);
    }
    expect(w.refused).toHaveLength(0);
    // The oracle is not vacuous: one atom over the cap is refused.
    const over = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [PERPL_TESTNET_CONTRACTS.exchange, AUSD(100) + 1n],
    });
    expect(allows(rules, { ...w.signed[0]!, data: over }, NOW)).toBe(false);
  });

  it('fits a typical mandate: the 0.15 MON hire drip pays for all three legs', async () => {
    const w = await perplOnboardingWorld({ ausd: 100, mon: 0.15 });
    await w.onboarder.ensure(w.agent, 'fund');
    expect(w.state.accountId).toBe(493n);
    // 355,000 gas at 100 gwei, charged at the limit.
    expect(MON(0.15) - w.state.mon).toBe(ALL_GAS * FEE);
    expect(ALL_GAS).toBe(355_000n);
  });

  it('waits for the funds after a fund kick, then opens', async () => {
    let sleeps = 0;
    const w = await perplOnboardingWorld({
      ausd: 0,
      onboarder: {
        sleep: () => {
          sleeps += 1;
          // The transfer lands while the kick is looking for it.
          if (sleeps === 2) w.state.ausd = AUSD(100);
          return Promise.resolve();
        },
      },
    });
    w.onboarder.kick(w.agent, 'fund', { awaitFunds: true });
    await settle();
    expect(sleeps).toBe(2);
    expect(w.state.accountId).toBe(493n);
    expect(await w.onboarder.status(w.agent)).toMatchObject({ state: 'ready' });
  });

  it('opens from a status poll once funds are there (funded from anywhere)', async () => {
    const w = await perplOnboardingWorld({ ausd: 100 });
    expect(await w.onboarder.status(w.agent)).toEqual({ state: 'opening' });
    await settle();
    expect(w.state.accountId).toBe(493n);
    expect((await w.onboardingEvents())[0]).toMatchObject({ trigger: 'poll' });
  });

  it('opens at the start of a run and stamps the run on its events', async () => {
    const w = await perplOnboardingWorld({ ausd: 100 });
    const status = await w.onboarder.ensure(w.agent, 'run', 'run-1');
    expect(status.state).toBe('ready');
    const events = await w.events.list(w.agent.id, { runId: 'run-1' });
    expect(events.map((e) => e.detail['status'])).toEqual(['opened', 'enrolled']);
  });
});

describe('AgentPerplOnboarder — nothing to do, or nothing it may do', () => {
  it('says what it waits for and sends nothing below the minimum', async () => {
    const w = await perplOnboardingWorld({ ausd: 99.99, cap: 300 });
    expect(await w.onboarder.ensure(w.agent, 'fund')).toEqual({
      state: 'needs_funds',
      minimumAtoms: MINIMUM,
      walletAtoms: AUSD(99.99),
      capAtoms: AUSD(300),
    });
    expect(w.signed).toHaveLength(0);
    expect(await w.onboardingEvents()).toHaveLength(0);
  });

  it('a cap under the minimum can never open: it says so and never asks the enclave', async () => {
    const w = await perplOnboardingWorld({ ausd: 500, cap: 50 });
    expect(await w.onboarder.ensure(w.agent, 'fund')).toEqual({
      state: 'cap_below_minimum',
      minimumAtoms: MINIMUM,
      capAtoms: AUSD(50),
    });
    expect(w.signed).toHaveLength(0);
    expect(w.refused).toHaveLength(0);
  });

  it('the enclave would refuse that opening anyway: the policy caps the approve', async () => {
    const w = await perplOnboardingWorld({ ausd: 500, cap: 50 });
    await expect(
      w.accounts.onboard(
        { agentId: w.agent.id, walletId: w.agent.walletId, address: w.agent.address },
        MINIMUM,
      ),
    ).rejects.toMatchObject({ reason: 'policy_violation' });
    expect(w.signed).toHaveLength(0);
    expect(w.refused).toHaveLength(1);
  });

  it('a stale policy refusing the opening is an event, not a silent failure', async () => {
    // The live policy was compiled for a 100 AUSD cap; the stored mandate says
    // 200 (an amend whose PATCH never landed). The enclave holds the line.
    const w = await perplOnboardingWorld({ ausd: 200, cap: 100 });
    await w.store.update(w.agent.id, {
      mandate: {
        ...w.agent.mandate,
        perpl: { ...w.agent.mandate.perpl, maxCollateralAtoms: AUSD(200) },
      },
    });
    const status = await w.onboarder.ensure(w.agent, 'fund');
    expect(status).toMatchObject({ state: 'failed' });
    const [event] = await w.onboardingEvents();
    expect(event).toMatchObject({ status: 'failed' });
    expect(event!['message']).toMatch(/enclave refused to sign it \(policy_violation\)/);
    expect(w.signed).toHaveLength(0);
    expect(w.state.mon).toBe(MON(0.15));
  });

  it('nothing for an agent without Perpl, or a revoked one', async () => {
    const kuruOnly = await perplOnboardingWorld({ ausd: 500 });
    const noPerpl = {
      ...kuruOnly.agent,
      mandate: { ...kuruOnly.agent.mandate, venues: ['kuru' as const] },
    };
    expect(await kuruOnly.onboarder.ensure(noPerpl, 'fund')).toEqual({ state: 'not_in_mandate' });
    const revoked = { ...kuruOnly.agent, status: 'revoked' as const };
    expect(await kuruOnly.onboarder.status(revoked)).toEqual({ state: 'revoked' });
    expect(kuruOnly.signed).toHaveLength(0);
  });

  it('re-reads the agent inside the flight: a revoke since the kick wins', async () => {
    const w = await perplOnboardingWorld({ ausd: 500 });
    await w.store.update(w.agent.id, { status: 'revoked' });
    expect(await w.onboarder.ensure(w.agent, 'fund')).toEqual({ state: 'revoked' });
    expect(w.signed).toHaveLength(0);
  });
});

describe('AgentPerplOnboarder — gas', () => {
  it('a shortfall is a clear event and a status, with nothing signed', async () => {
    const w = await perplOnboardingWorld({ ausd: 100, mon: 0.01 });
    const status = await w.onboarder.ensure(w.agent, 'fund');

    expect(status).toMatchObject({
      state: 'needs_gas',
      needWei: ALL_GAS * FEE,
      haveWei: MON(0.01),
    });
    expect(w.signed).toHaveLength(0);
    const [event] = await w.onboardingEvents();
    expect(event).toMatchObject({
      status: 'needs_gas',
      needWei: (ALL_GAS * FEE).toString(),
      haveWei: MON(0.01).toString(),
    });
    expect(event!['message']).toBe(
      'Couldn’t open the Perpl account: the agent needs 0.0355 MON for gas ' +
        '(approve, createAccount, allowOrderForwarding) and holds 0.01 MON. Fund it with MON.',
    );
  });

  it('shows the shortfall without retrying until retryMs, then opens once topped up', async () => {
    const w = await perplOnboardingWorld({ ausd: 100, mon: 0.01, onboarder: { retryMs: 60_000 } });
    await w.onboarder.ensure(w.agent, 'fund');
    w.state.mon = MON(0.2);
    expect((await w.onboarder.ensure(w.agent, 'poll')).state).toBe('needs_gas');
    expect((await w.onboarder.status(w.agent)).state).toBe('needs_gas');
    expect(await w.onboardingEvents()).toHaveLength(1);

    w.advance(60_000);
    expect((await w.onboarder.ensure(w.agent, 'run')).state).toBe('ready');
    expect((await w.onboardingEvents()).map((e) => e['status'])).toEqual([
      'needs_gas',
      'opened',
      'enrolled',
    ]);
  });

  it('the same shortfall twice is one Ledger row, not one per retry', async () => {
    const w = await perplOnboardingWorld({ ausd: 100, mon: 0.01, onboarder: { retryMs: 0 } });
    await w.onboarder.ensure(w.agent, 'fund');
    await w.onboarder.ensure(w.agent, 'poll');
    await w.onboarder.ensure(w.agent, 'run');
    expect(await w.onboardingEvents()).toHaveLength(1);
  });
});

describe('AgentPerplOnboarder — idempotent and resumable', () => {
  it('a second call after ready sends nothing and enrolls nothing', async () => {
    const w = await perplOnboardingWorld({ ausd: 100 });
    await w.onboarder.ensure(w.agent, 'fund');
    const sent = w.signed.length;
    expect((await w.onboarder.ensure(w.agent, 'run')).state).toBe('ready');
    expect(w.signed).toHaveLength(sent);
    expect(w.enroll.enrollments).toBe(1);
  });

  it('concurrent triggers share one flight', async () => {
    const w = await perplOnboardingWorld({ ausd: 100 });
    const results = await Promise.all([
      w.onboarder.ensure(w.agent, 'fund'),
      w.onboarder.ensure(w.agent, 'deposit'),
      w.onboarder.status(w.agent),
      w.onboarder.ensure(w.agent, 'run'),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[2]).toEqual({ state: 'opening' });
    expect(w.selectors()).toEqual([APPROVE, CREATE, FORWARD]);
    expect(w.enroll.enrollments).toBe(1);
  });

  it('serialises through `exclusive`, the agent write lane', async () => {
    const order: string[] = [];
    const w = await perplOnboardingWorld({
      ausd: 100,
      onboarder: {
        exclusive: async (agentId, task) => {
          order.push(`enter ${agentId}`);
          try {
            return await task();
          } finally {
            order.push('leave');
          }
        },
      },
    });
    await w.onboarder.ensure(w.agent, 'fund');
    expect(order).toEqual([`enter ${w.agent.id}`, 'leave']);
  });

  it('resumes an account that exists with no recorded forwarding: grant only, then enroll', async () => {
    const w = await perplOnboardingWorld({ accountId: 505n, ausd: 0 });
    const status = await w.onboarder.ensure(w.agent, 'run');
    expect(status).toMatchObject({ state: 'ready', accountId: 505n });
    expect(w.selectors()).toEqual([FORWARD]);
    expect(w.signed[0]!.gas_limit).toBe(
      `0x${PERPL_ONBOARDING_GAS.allowOrderForwarding.toString(16)}`,
    );
    expect((await w.onboardingEvents()).map((e) => e['status'])).toEqual(['resumed', 'enrolled']);
  });

  it('does not re-grant forwarding once an event recorded it, even after a restart', async () => {
    const w = await perplOnboardingWorld({ ausd: 100 });
    await w.onboarder.ensure(w.agent, 'fund');
    await w.secrets.deleteAgent(w.agent.id); // a lost key: re-enroll, nothing else
    const sent = w.signed.length;
    // A fresh onboarder over the same log: what a restarted API has.
    const { AgentPerplOnboarder } = await import('./perpl-onboarding');
    const restarted = new AgentPerplOnboarder({
      accounts: w.accounts,
      secrets: w.secrets,
      chain: {
        account: () => Promise.resolve({ accountId: 493n, balance: AUSD(100), locked: 0n }),
        collateralBalance: () => Promise.resolve(0n),
        nativeBalance: () => Promise.resolve(MON(1)),
        maxFeePerGas: () => Promise.resolve(FEE),
      },
      events: w.events,
      agents: w.store,
      minimum: () => Promise.resolve(MINIMUM),
    });
    expect((await restarted.ensure(w.agent, 'run')).state).toBe('ready');
    expect(w.signed).toHaveLength(sent);
    expect(w.enroll.enrollments).toBe(2);
  });

  it('resumes after a landed approve: no second approve', async () => {
    const w = await perplOnboardingWorld({ ausd: 100, allowance: 100 });
    await w.onboarder.ensure(w.agent, 'fund');
    expect(w.selectors()).toEqual([CREATE, FORWARD]);
    expect(w.state.accountId).toBe(493n);
  });

  it('a reverted leg is an event naming the step and its hash; the retry resumes', async () => {
    const w = await perplOnboardingWorld({ ausd: 100, revert: 2, onboarder: { retryMs: 0 } });
    const status = await w.onboarder.ensure(w.agent, 'fund');
    expect(status).toMatchObject({ state: 'failed' });
    const [event] = await w.onboardingEvents();
    expect(event).toMatchObject({ status: 'failed', step: 'createAccount' });
    expect(event!['txHash']).toMatch(/^0x0+2$/);

    // The approve landed; the retry sends createAccount and forwarding only.
    w.state.mon = MON(1);
    expect((await w.onboarder.ensure(w.agent, 'run')).state).toBe('ready');
    expect(w.selectors()).toEqual([APPROVE, CREATE, CREATE, FORWARD]);
  });

  it('an enrollment failure leaves the account open and is retried without a transaction', async () => {
    const w = await perplOnboardingWorld({ ausd: 100, onboarder: { retryMs: 0 } });
    w.enroll.failStatus = 423;
    const status = await w.onboarder.ensure(w.agent, 'fund');
    expect(status).toMatchObject({ state: 'failed' });
    expect(status.state === 'failed' && status.message).toMatch(
      /^Perpl account open, but its API key: /,
    );
    expect(w.state.accountId).toBe(493n);

    w.enroll.failStatus = undefined;
    const sent = w.signed.length;
    expect((await w.onboarder.ensure(w.agent, 'run')).state).toBe('ready');
    expect(w.signed).toHaveLength(sent);
    expect((await w.onboardingEvents()).map((e) => e['status'])).toEqual([
      'opened',
      'failed',
      'enrolled',
    ]);
  });
});

describe('collateralCap and the opening minimum', () => {
  it('is the per-transaction cap, lowered by a rolling cap on AUSD', async () => {
    const w = await perplOnboardingWorld({ cap: 300 });
    expect(collateralCap(w.agent)).toBe(AUSD(300));
    const rolling = {
      ...w.agent,
      mandate: {
        ...w.agent.mandate,
        rollingCap: {
          windowSeconds: 3600,
          capAtoms: AUSD(120),
          token: PERPL_TESTNET_CONTRACTS.collateral,
        },
      },
    };
    expect(collateralCap(rolling)).toBe(AUSD(120));
  });

  it('falls back to the testnet minimum when Perpl cannot be reached', async () => {
    await expect(perplOpeningMinimum(() => Promise.reject(new Error('down')))).resolves.toBe(
      AUSD(100),
    );
  });
});

describe('GET /agents/:id/perpl on the wire', () => {
  it('carries atoms and wei as decimal strings, and only the fields of its state', () => {
    expect(
      toPerplOnboardingResponse({
        state: 'needs_funds',
        minimumAtoms: AUSD(100),
        walletAtoms: AUSD(40),
        capAtoms: AUSD(500),
      }),
    ).toEqual({
      state: 'needs_funds',
      minimumAtoms: '100000000',
      walletAtoms: '40000000',
      capAtoms: '500000000',
    });
    expect(toPerplOnboardingResponse({ state: 'opening' })).toEqual({ state: 'opening' });
  });
});
