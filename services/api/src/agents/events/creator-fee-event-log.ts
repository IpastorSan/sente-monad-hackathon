import { Logger } from '@nestjs/common';
import { KURU_DEPLOYMENTS, toUnits, type KuruToken } from '@sente/venues/kuru';

import type { CreatorFeeLedger } from '../../fees/creator-fees';
import type { AgentStore } from '../store/agent-store';
import type { AgentEvent, AgentEventLog } from './agent-event-log';

/**
 * The agent event log, with the creator's share of Sente's fee recorded off
 * every fill that paid one (SEN-184).
 *
 * A decorator rather than a call in the gate, because a `fill` has more than
 * one writer — the gate at placement and the resting-fill watcher later — and
 * the share is owed whichever wrote it. Only a Kuru fill carrying `senteFee`
 * (what AccountCore's `BuilderFeeAccrued` said this agent paid) counts, and
 * only for an agent forked from SOMEONE ELSE's agent: the source agent's owner
 * is the creator. Like `ReputationEventLog`, it never fails the append: the
 * fill happened whether or not the ledger took the share, and the miss is
 * logged with what is needed to enter it by hand.
 *
 * The share accrues in the asset the fee was paid in, which is the asset the
 * fill RECEIVED (SEN-195): the base on a buy, USDC on a sell.
 */
export class CreatorFeeEventLog implements AgentEventLog {
  readonly #inner: AgentEventLog;
  readonly #ledger: Pick<CreatorFeeLedger, 'accrue'>;
  readonly #agents: Pick<AgentStore, 'get'>;
  readonly #logger = new Logger('CreatorFees');

  constructor(
    inner: AgentEventLog,
    ledger: Pick<CreatorFeeLedger, 'accrue'>,
    agents: Pick<AgentStore, 'get'>,
  ) {
    this.#inner = inner;
    this.#ledger = ledger;
    this.#agents = agents;
  }

  async append(event: Parameters<AgentEventLog['append']>[0]): Promise<AgentEvent> {
    const stored = await this.#inner.append(event);
    if (stored.kind === 'fill') {
      try {
        await this.#accrue(stored);
      } catch (error) {
        this.#logger.error(
          `creator share of fill ${String(stored.detail['txHash'])} (agent ${stored.agentId}) ` +
            `not recorded: ${String(error)}`,
        );
      }
    }
    return stored;
  }

  list(agentId: string, query?: Parameters<AgentEventLog['list']>[1]): Promise<AgentEvent[]> {
    return this.#inner.list(agentId, query);
  }

  truncation(agentId: string): ReturnType<AgentEventLog['truncation']> {
    return this.#inner.truncation(agentId);
  }

  async #accrue(fill: AgentEvent): Promise<void> {
    const { venue, senteFee, senteFeeAsset, txHash } = fill.detail;
    if (venue !== 'kuru' || typeof senteFee !== 'string' || typeof txHash !== 'string') return;
    // The fee is in whatever the fill received: the base on a buy (cbBTC,
    // WETH, MON…), USDC on a sell (SEN-195). Each asset accrues on its own.
    const token = feeToken(senteFeeAsset);
    if (!token) {
      throw new Error(`Sente fee asset ${String(senteFeeAsset)} is not a Kuru token`);
    }
    const feeAtoms = toUnits(senteFee, token.decimals, 'senteFee');
    if (feeAtoms === 0n) return;

    const agent = await this.#agents.get(fill.agentId);
    if (!agent?.forkedFrom) return;
    const source = await this.#agents.get(agent.forkedFrom);
    // Forking your own agent earns you nothing from yourself.
    if (!source || source.userId === agent.userId) return;

    const recorded = this.#ledger.accrue({
      creatorUserId: source.userId,
      agentId: agent.id,
      sourceAgentId: source.id,
      asset: token.symbol,
      decimals: token.decimals,
      feeAtoms,
      txHash,
      at: new Date(fill.at),
    });
    if (recorded) {
      this.#logger.log(
        `creator ${source.userId} owed ${recorded.amountAtoms} ${token.symbol} atoms ` +
          `from agent ${agent.id}'s fill ${txHash}`,
      );
    }
  }
}

/** A Kuru token by symbol, from either deployment (a symbol has the same decimals on both). */
function feeToken(symbol: unknown): KuruToken | undefined {
  return Object.values(KURU_DEPLOYMENTS)
    .flatMap((d) => Object.values(d.tokens))
    .find((t) => t.symbol === symbol);
}
