import { BadRequestException, HttpException, ParseIntPipe } from '@nestjs/common';

import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ChainController, type ConsensusBlockResponseDto } from './chain.controller';
import {
  ConsensusService,
  type PollTag,
  type TaggedBlock,
  type TaggedBlockReader,
} from './consensus.service';

const BLOCK = 63_310_247;
const ID_A = `0x${'a'.repeat(64)}`;

const quiet = { log: () => undefined, warn: () => undefined };

/**
 * The controller's own spec. The socket, the transitions, the reorg and the
 * fallback are `consensus.service.spec.ts`'s business; here a block is simply
 * put in the map through the service's other real entry point, the tag reader.
 */
function setup() {
  const tags: TaggedBlockReader & { byTag: Map<PollTag, TaggedBlock> } = {
    byTag: new Map<PollTag, TaggedBlock>(),
    getBlockByTag: (tag) => Promise.resolve(tags.byTag.get(tag)),
  };
  const service = new ConsensusService({
    wsUrl: 'wss://example.invalid',
    readBlock: tags,
    logger: quiet,
    // Nothing is started: the controller reads the map, it does not fill it.
    autoStart: false,
  });
  return { service, tags, controller: new ChainController(service) };
}

async function httpError(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof HttpException)) {
    throw new Error(`expected HttpException, got ${String(error)}`);
  }
  return { status: error.getStatus(), body: error.getResponse() };
}

describe('ChainController', () => {
  describe('GET /chain/blocks/:n/consensus', () => {
    it('answers with the block, its state and the ms each state was seen at', async () => {
      const { controller, service, tags } = setup();
      tags.byTag.set('finalized', { number: BLOCK, id: ID_A });
      await service.pollOnce();

      const response: ConsensusBlockResponseDto = await controller.blockConsensus(BLOCK);
      expect(response).toEqual({
        blockNumber: BLOCK,
        blockId: ID_A,
        state: 'Finalized',
        at: { finalized: expect.any(Number) },
      });
      // The ramp polls this, so it has to survive JSON: no bigints, no Dates.
      expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    });

    it('404s a height it is not tracking, and says how far back it goes', async () => {
      const { controller } = setup();
      const { status, body } = await httpError(controller.blockConsensus(BLOCK));
      expect(status).toBe(404);
      expect(body).toMatchObject({ statusCode: 404, reason: 'block_not_tracked' });
      expect((body as { message: string }).message).toContain('512');
    });

    it('is behind the same session auth guard as every other route', () => {
      // Nest's own metadata keys (GUARDS_METADATA / PATH_METADATA in
      // @nestjs/common/constants), spelled out rather than deep-imported.
      const guards = Reflect.getMetadata('__guards__', ChainController) as unknown[];
      expect(guards).toContain(SessionAuthGuard);
      expect(Reflect.getMetadata('path', ChainController)).toBe('chain');
      expect(Reflect.getMetadata('path', ChainController.prototype.blockConsensus)).toBe(
        'blocks/:n/consensus',
      );
    });

    it('refuses a height that is not a non-negative integer', async () => {
      const { controller, service, tags } = setup();
      tags.byTag.set('finalized', { number: BLOCK, id: ID_A });
      await service.pollOnce();

      // What ParseIntPipe does with the raw path segment, before the handler.
      for (const bad of ['latest', '1e3', '', '-']) {
        await expect(
          new ParseIntPipe().transform(bad, { type: 'param', data: 'n' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(
        new ParseIntPipe().transform('63310247', { type: 'param', data: 'n' }),
      ).resolves.toBe(BLOCK);

      // And the handler's own bound, for a height that parses but cannot be one.
      for (const bad of [-1, 2 ** 53]) {
        expect(await httpError(controller.blockConsensus(bad))).toMatchObject({
          status: 400,
          body: { statusCode: 400, reason: 'height_invalid' },
        });
      }
    });
  });
});
