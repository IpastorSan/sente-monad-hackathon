import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildMandate } from '../../src/agents/mandate.ts';
import {
  agentMandateForm,
  agentMaxOrderNotional,
  BOOTSTRAP_PHASES,
  bootstrapRefusal,
  clientTradeIdFor,
  creditsProblems,
  decimalHalfOnTick,
  deltaProblems,
  deltasOf,
  halfOnTick,
  isBootstrapped,
  judgeAgentRun,
  normalizeApi,
  parseSecrets,
  PRODUCTION_API,
  remainingPhases,
  runIdOf,
  runRefusal,
  SecretsError,
  startBudgetProblems,
  targetRefusal,
  type LiveSecrets,
  type RunEvent,
} from './plan.ts';

const AUTH_KEY = `0x${'11'.repeat(32)}` as const;
const DEVICE_KEY = '22'.repeat(32);
const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const usd = (n: number) => BigInt(Math.round(n * 1e6));

const fresh: LiveSecrets = {
  version: 1,
  api: PRODUCTION_API,
  createdAt: '2026-10-09T10:00:00.000Z',
  authKey: AUTH_KEY,
  deviceKey: DEVICE_KEY,
};

const complete: LiveSecrets = {
  ...fresh,
  user: { address: ADDRESS, walletId: 'w1', walletAddress: ADDRESS },
  perpl: { accountId: '7', apiKey: 'key' },
  agent: { id: 'a1', walletId: 'aw1', address: ADDRESS, policyId: 'p1', ownerKind: 'device' },
  agentFunding: { usdc: '0xabc', ausd: 'already funded' },
  agentPerpl: { accountId: '8', transactions: [] },
};

describe('parseSecrets', () => {
  it('round-trips a complete file', () => {
    assert.deepEqual(parseSecrets(JSON.stringify(complete)), complete);
  });

  it('accepts a file with only the identity', () => {
    assert.deepEqual(parseSecrets(JSON.stringify(fresh)), fresh);
  });

  for (const [label, mutate, field] of [
    ['a wrong version', (o: Record<string, unknown>) => (o['version'] = 2), 'version'],
    ['a short authKey', (o: Record<string, unknown>) => (o['authKey'] = '0x1234'), 'authKey'],
    [
      'an authKey without 0x',
      (o: Record<string, unknown>) => (o['authKey'] = '11'.repeat(32)),
      'authKey',
    ],
    [
      'a 0x deviceKey',
      (o: Record<string, unknown>) => (o['deviceKey'] = `0x${DEVICE_KEY}`),
      'deviceKey',
    ],
    ['a missing api', (o: Record<string, unknown>) => delete o['api'], 'api'],
    [
      'an api with a path',
      (o: Record<string, unknown>) => (o['api'] = 'https://x.lol/v1'),
      'origin',
    ],
    [
      'a user with a bad address',
      (o: Record<string, unknown>) =>
        (o['user'] = { address: 'nope', walletId: 'w', walletAddress: ADDRESS }),
      'user.address',
    ],
    [
      'an agent missing its wallet',
      (o: Record<string, unknown>) =>
        (o['agent'] = { id: 'a', address: ADDRESS, policyId: 'p', ownerKind: 'device' }),
      'agent.walletId',
    ],
  ] as const) {
    it(`refuses ${label}, naming the field`, () => {
      const raw = JSON.parse(JSON.stringify(complete)) as Record<string, unknown>;
      mutate(raw);
      assert.throws(
        () => parseSecrets(JSON.stringify(raw)),
        (error: unknown) => {
          assert.ok(error instanceof SecretsError);
          assert.match(error.message, new RegExp(field));
          return true;
        },
      );
    });
  }

  it('never quotes a key in its errors', () => {
    const raw = { ...fresh, deviceKey: `0x${DEVICE_KEY}` };
    assert.throws(
      () => parseSecrets(JSON.stringify(raw)),
      (error: Error) => !error.message.includes(DEVICE_KEY),
    );
  });

  it('refuses something that is not JSON', () => {
    assert.throws(() => parseSecrets('{'), SecretsError);
  });
});

describe('bootstrap phases', () => {
  it('a missing file has everything left to do', () => {
    assert.deepEqual(remainingPhases(null), [...BOOTSTRAP_PHASES]);
  });

  it('a file stopped after the hire resumes at the funding', () => {
    const { agentFunding: _f, agentPerpl: _p, ...afterHire } = complete;
    assert.deepEqual(remainingPhases(afterHire), ['fund-agent', 'agent-perpl']);
  });

  it('a Perpl account without its key still needs the enrollment', () => {
    const s: LiveSecrets = { ...fresh, user: complete.user!, perpl: { accountId: '7' } };
    assert.deepEqual(remainingPhases(s).slice(0, 1), ['perpl-enroll']);
  });

  it('half a funding is not a funding', () => {
    assert.ok(
      remainingPhases({ ...complete, agentFunding: { usdc: '0x1' } }).includes('fund-agent'),
    );
  });

  it('a complete file is bootstrapped', () => {
    assert.equal(isBootstrapped(complete), true);
    assert.equal(remainingPhases(complete).length, 0);
  });
});

describe('bootstrapRefusal', () => {
  it('lets a first bootstrap through', () => {
    assert.equal(bootstrapRefusal(null, false), null);
  });

  it('refuses a file that already names a user or an agent', () => {
    const partial: LiveSecrets = { ...fresh, user: complete.user! };
    assert.match(
      bootstrapRefusal(partial, false) ?? '',
      /user wallet w1; refusing to bootstrap again/,
    );
    assert.match(bootstrapRefusal(complete, false) ?? '', /already bootstrapped.*agent a1/);
  });

  it('refuses a complete file even with --resume', () => {
    assert.match(bootstrapRefusal(complete, true) ?? '', /already bootstrapped/);
  });

  it('resumes a partial file with --resume', () => {
    assert.equal(bootstrapRefusal({ ...fresh, user: complete.user! }, true), null);
    assert.equal(bootstrapRefusal(fresh, true), null);
  });

  it('asks for --resume on a keys-only file instead of minting new keys over it', () => {
    assert.match(bootstrapRefusal(fresh, false) ?? '', /--resume/);
  });
});

describe('runRefusal', () => {
  it('needs a file and a finished bootstrap', () => {
    assert.match(runRefusal(null) ?? '', /--bootstrap/);
    assert.match(runRefusal({ ...fresh, user: complete.user! }) ?? '', /unfinished/);
    assert.equal(runRefusal(complete), null);
  });
});

describe('the target', () => {
  it('normalises to an origin', () => {
    assert.equal(normalizeApi('https://api.sente.lol/'), PRODUCTION_API);
    assert.equal(normalizeApi('http://localhost:3100'), 'http://localhost:3100');
    assert.throws(() => normalizeApi('ftp://x'), SecretsError);
    assert.throws(() => normalizeApi('https://api.sente.lol/perpl'), SecretsError);
  });

  it('needs --yes for production', () => {
    assert.match(
      targetRefusal({ api: PRODUCTION_API, recorded: null, yes: false }) ?? '',
      /PRODUCTION/,
    );
    assert.equal(targetRefusal({ api: PRODUCTION_API, recorded: PRODUCTION_API, yes: true }), null);
    assert.equal(targetRefusal({ api: 'http://localhost:3100', recorded: null, yes: false }), null);
  });

  it('refuses a host other than the bootstrapped one, --yes or not', () => {
    const refusal = targetRefusal({
      api: 'http://localhost:3100',
      recorded: PRODUCTION_API,
      yes: true,
    });
    assert.match(refusal ?? '', /bootstrapped on https:\/\/api\.sente\.lol/);
  });
});

describe('run ids', () => {
  it('is the UTC day and the short commit', () => {
    assert.equal(
      runIdOf(new Date('2026-10-09T23:59:00Z'), 'b855da2deadbeef\n'),
      '20261009-b855da2d',
    );
    assert.throws(() => runIdOf(new Date(), 'not-a-sha'));
  });

  it('derives a stable UUID v4 per step', () => {
    const a = clientTradeIdFor('20261009-b855da2d', 'kuru-place');
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(clientTradeIdFor('20261009-b855da2d', 'kuru-place'), a);
    assert.notEqual(clientTradeIdFor('20261009-b855da2d', 'kuru-cancel'), a);
    assert.notEqual(clientTradeIdFor('20261010-b855da2d', 'kuru-place'), a);
  });
});

describe('prices', () => {
  it('halves onto the tick, never to zero', () => {
    assert.equal(halfOnTick(28_902n, 1n), 14_451n);
    assert.equal(halfOnTick(1_005n, 10n), 500n);
    assert.equal(halfOnTick(3n, 10n), 10n);
    assert.throws(() => halfOnTick(0n, 1n));
  });

  it('halves a decimal mark onto a decimal tick', () => {
    assert.equal(decimalHalfOnTick('76982.4', '0.1'), '38491.2');
    assert.equal(decimalHalfOnTick('76982.45', '0.1'), '38491.2');
    assert.equal(decimalHalfOnTick('77000.8', '0.5'), '38500');
  });

  it('sizes the agent’s notional to a full-mark minimum order, at least 11', () => {
    assert.equal(agentMaxOrderNotional('76982.4', '0.001'), '77');
    assert.equal(agentMaxOrderNotional('5000', '0.001'), '11');
  });
});

describe('the agent mandate', () => {
  it('builds through the hire screen’s own buildMandate', () => {
    const now = 1_790_000_000;
    const kuruMarket = '0xfdbE356828c8f5A5d5ed4f69ddE0816f4058Ef61';
    const built = buildMandate(
      agentMandateForm({ kuruMarket, maxOrderNotional: '77', nowSeconds: now, returnTo: ADDRESS }),
      now,
    );
    assert.ok(built.ok);
    assert.deepEqual(built.mandate.venues, ['kuru', 'perpl']);
    assert.deepEqual(built.mandate.kuru.markets, [kuruMarket]);
    assert.deepEqual(Object.values(built.mandate.kuru.maxDepositAtoms), [15_000_000n]);
    assert.equal(built.mandate.perpl.maxCollateralAtoms, 100_000_000n);
    assert.deepEqual(built.mandate.perpl.markets, ['BTC-PERP']);
    assert.equal(built.mandate.maxOrderNotional, '77');
    assert.equal(built.mandate.expiresAt, now + 90 * 86_400);
    assert.equal(built.mandate.returnTo, ADDRESS);
  });
});

describe('budget', () => {
  const enough = { usdcAtoms: usd(12), ausdAtoms: usd(50) };

  it('starts on a sent kit with enough USDC and AUSD', () => {
    assert.deepEqual(startBudgetProblems({ starterKit: 'sent', holdings: enough }), []);
  });

  it('names every shortfall', () => {
    const problems = startBudgetProblems({
      starterKit: 'pending',
      holdings: { usdcAtoms: usd(11.99), ausdAtoms: usd(49) },
    });
    assert.equal(problems.length, 3);
    assert.match(problems.join('|'), /pending.*USDC 11\.99 < 12.*AUSD 49 < 50/);
  });

  it('bounds one run’s credits and what is left', () => {
    assert.deepEqual(
      creditsProblems({ usedUsd: 1, remainingUsd: 9 }, { usedUsd: 1.29, remainingUsd: 8.71 }),
      [],
    );
    assert.match(
      creditsProblems({ usedUsd: 1, remainingUsd: 9 }, { usedUsd: 1.3, remainingUsd: 8.7 }).join(),
      /cost \$0\.3000/,
    );
    assert.match(
      creditsProblems(
        { usedUsd: 8.9, remainingUsd: 1.1 },
        { usedUsd: 9.1, remainingUsd: 0.9 },
      ).join(),
      /left/,
    );
    assert.match(
      creditsProblems(
        { usedUsd: 0, remainingUsd: null },
        { usedUsd: 0, remainingUsd: null },
      ).join(),
      /unknown/,
    );
  });

  it('allows a dime of USDC and no AUSD at all', () => {
    const before = { usdcAtoms: usd(100), ausdAtoms: usd(50) };
    assert.deepEqual(
      deltaProblems(deltasOf(before, { usdcAtoms: usd(99.9), ausdAtoms: usd(50) })),
      [],
    );
    assert.match(
      deltaProblems(deltasOf(before, { usdcAtoms: usd(99.89), ausdAtoms: usd(50) })).join(),
      /USDC moved −0\.11/,
    );
    assert.match(
      deltaProblems(deltasOf(before, { usdcAtoms: usd(100), ausdAtoms: usd(50.000001) })).join(),
      /AUSD moved \+0\.000001/,
    );
    assert.deepEqual(
      deltaProblems(deltasOf(before, { usdcAtoms: usd(110), ausdAtoms: usd(50) })),
      [],
    );
  });
});

describe('judgeAgentRun', () => {
  const placed: RunEvent = { kind: 'order', tool: 'place_limit', detail: { status: 'ok' } };
  const cancelled: RunEvent = { kind: 'order', tool: 'cancel_order', detail: { status: 'ok' } };
  const thesis: RunEvent = { kind: 'thesis', tool: 'record_thesis' };

  it('passes a thesis, a placed bid and its cancel', () => {
    assert.deepEqual(
      judgeAgentRun({ stopReason: 'end_turn', events: [thesis, placed, cancelled] }),
      { ok: true },
    );
  });

  it('fails on any refusal, naming its layer', () => {
    const refusal: RunEvent = {
      kind: 'refusal',
      layer: 'enclave',
      tool: 'place_limit',
      detail: { code: 'policy_violation' },
    };
    const verdict = judgeAgentRun({ stopReason: 'end_turn', events: [placed, refusal, cancelled] });
    assert.deepEqual(verdict, {
      ok: false,
      problem: 'refused by enclave on place_limit: policy_violation',
    });
  });

  it('fails without the order or the cancel, or when one failed', () => {
    assert.equal(judgeAgentRun({ stopReason: 'end_turn', events: [cancelled] }).ok, false);
    assert.equal(judgeAgentRun({ stopReason: 'end_turn', events: [placed] }).ok, false);
    const failed: RunEvent = { kind: 'order', tool: 'cancel_order', detail: { status: 'failed' } };
    assert.equal(judgeAgentRun({ stopReason: 'end_turn', events: [placed, failed] }).ok, false);
  });

  it('fails on a fill or a run that did not finish', () => {
    assert.equal(
      judgeAgentRun({ stopReason: 'end_turn', events: [placed, { kind: 'fill' }, cancelled] }).ok,
      false,
    );
    assert.deepEqual(judgeAgentRun({ stopReason: 'max_iterations', events: [placed, cancelled] }), {
      ok: false,
      problem: 'the run stopped on max_iterations',
    });
  });
});
