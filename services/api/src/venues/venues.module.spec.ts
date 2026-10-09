/**
 * VenuesModule boots with its network readers overridden (SEN-75): the
 * providers resolve, `MarketDataService` is exported with both venues wired,
 * and shutting the module down closes the Perpl book feed.
 */
import { Test } from '@nestjs/testing';
import { KuruVenue } from '@sente/venues/kuru';
import { PerplMarketData } from '@sente/venues/perpl';

import { MarketDataService } from './market-data.service';
import { PerplBookFeed } from './perpl/perpl-book-feed';
import { VenuesModule } from './venues.module';
import { VenuesService } from './venues.service';

describe('VenuesModule', () => {
  it('boots, serves both venues and closes the feed on shutdown', async () => {
    const kuru = {
      market: jest.fn(),
      // Kuru's catalog listing none of the pinned books is a stale deployment
      // (SEN-185): reported, never read as an empty, healthy venue.
      listedMarkets: jest.fn(() => Promise.resolve({ markets: [], missing: ['MON-USDC'] })),
      getDepth: jest.fn(),
      getKlines: jest.fn(),
      bookSnapshot: jest.fn(),
    };
    const perplData = {
      context: jest.fn(() => Promise.reject(new Error('offline in specs'))),
      getKlines: jest.fn(),
    };
    const feed = { book: jest.fn(), close: jest.fn() };

    const moduleRef = await Test.createTestingModule({ imports: [VenuesModule] })
      .overrideProvider(KuruVenue)
      .useValue(kuru)
      .overrideProvider(PerplMarketData)
      .useValue(perplData)
      .overrideProvider(PerplBookFeed)
      .useValue(feed)
      .compile();

    const markets = await moduleRef.get(MarketDataService).markets();
    expect(markets.venues).toEqual([
      { venue: 'kuru', ok: false, error: 'MON-USDC not in Kuru catalog', missing: ['MON-USDC'] },
      { venue: 'perpl', ok: false, error: expect.stringContaining('offline in specs') },
    ]);
    expect(perplData.context).toHaveBeenCalled();
    expect(moduleRef.get(VenuesService).describe()).toEqual({
      module: 'venues',
      implemented: true,
      venues: ['kuru'],
    });

    await moduleRef.close();
    expect(feed.close).toHaveBeenCalledTimes(1);
  });
});
