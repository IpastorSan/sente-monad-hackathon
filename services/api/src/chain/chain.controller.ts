// The decorators below read Reflect metadata at module-load time, so the
// polyfill loads with them — same first-line import as main.ts and agent.dto.ts.
import 'reflect-metadata';

import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';

import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ConsensusService, type CommitState, type CommitTimes } from './consensus.service';

/** A block's consensus record on the wire. */
export interface ConsensusBlockResponseDto {
  blockNumber: number;
  /**
   * Monad's consensus id, present once the socket has reported this height.
   * Absent while only the HTTP fallback has seen it (SEN-35).
   */
  blockId?: string;
  /** The execution hash, from the HTTP fallback. A different value from `blockId`. */
  blockHash?: string;
  /** `Proposed` | `Voted` | `Finalized` | `Verified`. */
  state: CommitState;
  /** Epoch ms each state was first observed, keyed `proposed`/`voted`/… */
  at: CommitTimes;
}

/**
 * AUTH: the same seam as `wallet/` and `agents/` — `SessionAuthGuard` (SEN-37)
 * populates the request principal from the caller's verified session token.
 *
 * Nothing on this route is user-scoped: consensus state is public chain data,
 * and there is no per-user view of it. The guard is here for consistency (the
 * whole API is behind one auth story), not because the answer depends on who
 * is asking.
 *
 * The height is parsed with Nest's own `ParseIntPipe` rather than a
 * class-validator DTO: there is one field, and a pipe that cannot silently
 * no-op is worth more here than the whitelist a DTO would bring.
 */
@Controller('chain')
@UseGuards(SessionAuthGuard)
export class ChainController {
  private readonly consensus: ConsensusService;

  constructor(consensus: ConsensusService) {
    this.consensus = consensus;
  }

  /**
   * Where a block is in Monad's commit process — what the Agent Ledger's
   * consensus ramp polls for the `blockNumber` an SEN-20 order or fill event
   * carries.
   *
   * - 200 with the record: the height, whichever ids have been observed for it
   *   (`blockId` from the socket, `blockHash` from the HTTP fallback — never
   *   the same value, so a reader compares each against its own kind), its
   *   furthest state, and `at`, the epoch ms at which each state was first
   *   seen. A gap
   *   between two entries means the block never reported that state — a block
   *   that skips `Voted` shows `proposed` and `finalized` and nothing between.
   * - 400 `height_invalid`: not a non-negative integer.
   * - 404 `block_not_tracked`: the height is outside the window the service
   *   keeps (the most recent 512 blocks, ~4 minutes on testnet). An old trade's
   *   ramp has nothing left to show; it is not an error.
   */
  @Get('blocks/:n/consensus')
  async blockConsensus(@Param('n', ParseIntPipe) n: number): Promise<ConsensusBlockResponseDto> {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new BadRequestException({
        statusCode: 400,
        reason: 'height_invalid',
        message: `${n} is not a block height`,
      });
    }

    const record = this.consensus.stateOf(n);
    if (!record) {
      throw new NotFoundException({
        statusCode: 404,
        reason: 'block_not_tracked',
        message:
          `No consensus state for block ${n}: the service tracks the most recent ` +
          `${this.consensus.window} blocks, and only while it is running`,
      });
    }
    return {
      blockNumber: record.blockNumber,
      ...(record.blockId !== undefined ? { blockId: record.blockId } : {}),
      ...(record.blockHash !== undefined ? { blockHash: record.blockHash } : {}),
      state: record.state,
      at: { ...record.at },
    };
  }
}
