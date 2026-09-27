import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Venue } from '@sente/venues';
import { KuruVenue } from '@sente/venues/kuru';

@Injectable()
export class VenuesService {
  private readonly logger = new Logger(VenuesService.name);

  /**
   * The read-only venues, by id (SEN-75). Only Kuru is here: its adapter reads
   * without an account, while `PerplVenue` needs an agent's credentials even
   * to read, so Perpl's credential-free reads go through `MarketDataService`
   * instead of a `Venue`.
   */
  private readonly registry = new Map<string, Venue>();

  constructor(@Inject(KuruVenue) kuru: KuruVenue) {
    this.registry.set('kuru', kuru);
  }

  list(): string[] {
    return [...this.registry.keys()];
  }

  get(id: string): Venue {
    const venue = this.registry.get(id);
    if (!venue) {
      this.logger.warn(`No venue adapter registered for "${id}"`);
      throw new NotFoundException(`Unknown venue: ${id}`);
    }
    return venue;
  }

  describe(): { module: string; implemented: boolean; venues: string[] } {
    return { module: 'venues', implemented: true, venues: this.list() };
  }
}
