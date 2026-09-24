/**
 * What an agent can be funded WITH. How the funding happens lives in
 * `wallet/send.ts`.
 *
 * Until SEN-42 this file also built the call: funding was a Kernel
 * UserOperation batch through `useSmartAccount().sendCalls`. It is now one
 * Privy-sponsored transfer out of the user's own wallet, signed by the phone's
 * device key — so the call shape belongs next to the signature that authorises
 * it, and what is left here is the token list and the one question about a token
 * that the send needs answered.
 *
 * Plain node, no React Native, so `fund.test.ts` runs without a device.
 */
import { isAddressEqual } from 'viem';

import { AUSD, KURU_TOKENS, type Token } from './mandate.ts';

const NATIVE_MON = '0x0000000000000000000000000000000000000000';

/**
 * What an agent can be funded with: Kuru's quote asset first, then Perpl's
 * collateral, then native MON (which the agent's wallet needs for gas), then
 * the Kuru base assets.
 *
 * The API keeps the same list (`services/api/src/wallet/send/sponsored-send.ts`
 * `SENDABLE_TOKENS`) and refuses anything outside it, so a token added here and
 * not there is refused at prepare rather than signed and lost.
 */
export const FUNDING_TOKENS: readonly Token[] = (() => {
  const bySymbol = (symbol: string) => KURU_TOKENS.find((token) => token.symbol === symbol);
  const head = [bySymbol('USDC'), AUSD, bySymbol('MON')].filter(
    (token): token is Token => token !== undefined,
  );
  return [...head, ...KURU_TOKENS.filter((token) => !head.includes(token))];
})();

/**
 * Is this native MON rather than an ERC-20?
 *
 * The one branch every send has: native MON moves as the transaction's `value`,
 * everything else as `transfer` calldata, and an absent field and a zero one are
 * different signed bytes (`wallet/send.ts`).
 */
export function isNativeToken(token: Token): boolean {
  return isAddressEqual(token.address, NATIVE_MON);
}
