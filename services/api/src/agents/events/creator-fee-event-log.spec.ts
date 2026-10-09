import { parseMandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { getAddress } from 'viem';

import { CreatorFeeLedger } from '../../fees/creator-fees';
import { InMemoryAgentStore, type AgentRecord } from '../store/agent-store';
import { EXPIRES_IN_A_YEAR } from '../testing/mandate-expiry';
import { InMemoryAgentEventLog, type NewAgentEvent } from './agent-event-log';
import { CreatorFeeEventLog } from './creator-fee-event-log';

const TX = `0x${'ab'.repeat(32)}`;

function record(id: string, userId: string, forkedFrom?: string): AgentRecord {
  const now = new Date();
  return {
    id,
    userId,
    name: id,
    systemPrompt: '',
    strategy: '',
    model: 'anthropic/claude-sonnet-5',
    mandate: parseMandate({
      version: 1,
      chainId: 10143,
      expiresAt: EXPIRES_IN_A_YEAR,
      venues: ['kuru'],
      kuru: {
        markets: [KURU_TESTNET_MARKETS[0]!.address],
        maxDepositAtoms: { [KURU_TESTNET_TOKENS.USDC.address]: '1000000' },
      },
      perpl: { maxCollateralAtoms: '0', maxLeverage: 1, markets: [] },
      maxOrderNotional: '10',
    }),
    walletId: `wallet-${id}`,
    address: getAddress(`0x${id.length.toString(16).padStart(40, '1')}`),
    policyId: `policy-${id}`,
    ownerKind: 'server',
    mcpTokenHash: `hash-${id}`,
    status: 'active',
    policyCleared: false,
    public: true,
    ...(forkedFrom ? { forkedFrom } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function fillEvent(agentId: string, detail: Record<string, unknown> = {}): NewAgentEvent {
  return {
    agentId,
    kind: 'fill',
    tool: 'place_market',
    detail: {
      venue: 'kuru',
      symbol: 'MON-USDC',
      txHash: TX,
      fee: '0.0245',
      feeAsset: 'USDC',
      senteFee: '0.035',
      senteFeeAsset: 'USDC',
      ...detail,
    },
  };
}

async function harness() {
  const agents = new InMemoryAgentStore();
  await agents.insert(record('source', 'creator'));
  await agents.insert({ ...record('fork', 'forker', 'source'), mcpTokenHash: 'h2' });
  await agents.insert({ ...record('self-fork', 'creator', 'source'), mcpTokenHash: 'h3' });
  await agents.insert({ ...record('original', 'forker'), mcpTokenHash: 'h4' });
  const ledger = new CreatorFeeLedger();
  const log = new CreatorFeeEventLog(new InMemoryAgentEventLog(), ledger, agents);
  return { ledger, log };
}

describe('CreatorFeeEventLog (SEN-184)', () => {
  it('owes the source agent’s owner 3/10 of a fork’s Sente fee, once', async () => {
    const { ledger, log } = await harness();
    await log.append(fillEvent('fork'));
    await log.append(fillEvent('fork')); // the same fill again
    expect(ledger.totals('creator')).toEqual([
      { asset: 'USDC', decimals: 6, accruedAtoms: 10_500n, paidAtoms: 0n, owedAtoms: 10_500n },
    ]);
    expect(ledger.recent('creator', 1)[0]).toMatchObject({
      agentId: 'fork',
      sourceAgentId: 'source',
      feeAtoms: 35_000n,
      txHash: TX,
    });
  });

  it('owes nothing for an agent that is no fork, a fork of one’s own agent, or no fee', async () => {
    const { ledger, log } = await harness();
    await log.append(fillEvent('original'));
    await log.append(fillEvent('self-fork'));
    await log.append(fillEvent('fork', { senteFee: undefined }));
    await log.append(fillEvent('fork', { senteFee: '0' }));
    await log.append(fillEvent('fork', { venue: 'perpl' }));
    expect(ledger.creators()).toEqual([]);
  });

  it('never fails the append when the ledger does', async () => {
    const agents = new InMemoryAgentStore();
    await agents.insert(record('source', 'creator'));
    await agents.insert({ ...record('fork', 'forker', 'source'), mcpTokenHash: 'h2' });
    const broken = {
      accrue: () => {
        throw new Error('disk full');
      },
    };
    const log = new CreatorFeeEventLog(new InMemoryAgentEventLog(), broken, agents);
    const stored = await log.append(fillEvent('fork'));
    expect(stored.kind).toBe('fill');
    expect(await log.list('fork')).toHaveLength(1);
  });
});
