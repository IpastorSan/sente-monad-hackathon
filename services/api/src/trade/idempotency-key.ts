/**
 * The `privy-idempotency-key` of step `stepIndex`. MUST equal the phone's
 * `tradeIdempotencyKey` (`apps/mobile/src/trade/envelope.ts`) byte for byte:
 * the phone refuses to sign a payload whose key differs, and Privy drops a
 * repeat of the same key for 24h, which is what makes a replayed signature
 * harmless.
 *
 * Its own erasable-syntax module (gotcha 10) rather than part of
 * `trade.service.ts`, so the phone's cross-side contract test (SEN-125,
 * `apps/mobile/src/trade/contract.test.ts`) runs the server's real key under
 * node's type stripping instead of a copy of the template.
 */
export function tradeIdempotencyKey(clientTradeId: string, stepIndex: number): string {
  return `sente-trade:${clientTradeId}:${stepIndex}`;
}
