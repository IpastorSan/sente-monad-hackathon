/** Type guard: does this adapter support positions and leverage? */
export function isPerpsVenue(venue) {
  return venue.kind === 'perps';
}
