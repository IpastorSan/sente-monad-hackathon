import { Injectable, Logger, NotFoundException } from '@nestjs/common';
// Proves the shared interface resolves from the API side too. Types only —
// the Kuru and Perpl adapters land in their own issues.
import type { Venue } from '@sente/venues';

@Injectable()
export class VenuesService {
  private readonly logger = new Logger(VenuesService.name);

  /**
   * TODO(MOV-250): stub. Register the Kuru (spot) and Perpl (perps) adapters
   * here once they exist; the registry is what lets a strategy address a venue
   * by id without knowing which implementation answers.
   */
  private readonly registry = new Map<string, Venue>();

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
    return { module: 'venues', implemented: false, venues: this.list() };
  }
}
