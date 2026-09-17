import { Logger, Module, type Provider } from '@nestjs/common';

import { PlaceholderGasDripAuthGuard } from '../gas/auth/gas-drip-auth.guard';
import { ChainController } from './chain.controller';
import {
  CONSENSUS_WINDOW_BLOCKS,
  ConsensusService,
  DEFAULT_MONAD_WS_URL,
  createTaggedBlockReader,
  type ConsensusLogger,
  type ConsensusOptions,
} from './consensus.service';

/**
 * Where the WebSocket lives. Deliberately separate from
 * `MONAD_TESTNET_RPC_URL` (the HTTP endpoint everything else uses): the two
 * are different transports at the same node today, and pointing them
 * separately is what lets the socket be moved without touching the HTTP paths
 * that sign and broadcast.
 */
export const DEFAULT_MONAD_HTTP_URL = 'https://testnet-rpc.monad.xyz';

export function loadConsensusOptions(env: NodeJS.ProcessEnv = process.env): ConsensusOptions {
  const wsUrl = env['MONAD_WS_URL']?.trim() || DEFAULT_MONAD_WS_URL;
  const rpcUrl = env['MONAD_TESTNET_RPC_URL']?.trim() || DEFAULT_MONAD_HTTP_URL;
  return {
    wsUrl,
    readBlock: createTaggedBlockReader(rpcUrl),
    windowSize: CONSENSUS_WINDOW_BLOCKS,
  };
}

/**
 * MONAD_NEW_HEADS: one service, subscribed for the life of the process.
 *
 * It has to be eager rather than lazy — a consumer asking about an order's
 * block needs the states that block passed through *before* the question, and
 * a subscription opened on first use would have missed them.
 *
 * Without the subscription the API still answers from the HTTP fallback
 * (`latest` / `safe` / `finalized`), which cannot report `Verified`.
 */
const consensusProvider: Provider = {
  provide: ConsensusService,
  useFactory: (): ConsensusService => {
    const options = loadConsensusOptions();
    const logger: ConsensusLogger = new Logger('Consensus');
    logger.log(
      `following ${options.wsUrl} (${options.windowSize} blocks), ` +
        'falling back to eth_getBlockByNumber while the socket is down',
    );
    return new ConsensusService({ ...options, logger });
  },
};

/**
 * Monad's commit state, and the routes that read it (SEN-21).
 *
 * `ConsensusService` is exported so `AgentsModule` can decorate its SEN-20
 * event page with it.
 */
@Module({
  controllers: [ChainController],
  providers: [consensusProvider, PlaceholderGasDripAuthGuard],
  exports: [ConsensusService],
})
export class ChainModule {}
