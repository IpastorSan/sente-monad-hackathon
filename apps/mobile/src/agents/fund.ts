/**
 * Funding an agent: a plain transfer from the user's smart account to the
 * agent's wallet, sent through `useSmartAccount().sendCalls` like any other
 * batch. Nothing server-side ever moves user funds (SEN-5 notes).
 *
 * Plain node, no React Native, so `fund.test.ts` can decode what it builds.
 */
import { encodeFunctionData, erc20Abi, isAddressEqual, type Address } from 'viem';

import type { Erc7579CallRequest } from '../wallet/api.ts';
import { AUSD, KURU_TOKENS, type Token } from './mandate.ts';

const NATIVE_MON = '0x0000000000000000000000000000000000000000';

/**
 * What an agent can be funded with: Kuru's quote asset first, then Perpl's
 * collateral, then native MON (which the agent's wallet needs for gas), then
 * the Kuru base assets.
 */
export const FUNDING_TOKENS: readonly Token[] = (() => {
  const bySymbol = (symbol: string) => KURU_TOKENS.find((token) => token.symbol === symbol);
  const head = [bySymbol('USDC'), AUSD, bySymbol('MON')].filter(
    (token): token is Token => token !== undefined,
  );
  return [...head, ...KURU_TOKENS.filter((token) => !head.includes(token))];
})();

export function isNativeToken(token: Token): boolean {
  return isAddressEqual(token.address, NATIVE_MON);
}

/** One call: ERC-20 `transfer(recipient, atoms)`, or a native value send for MON. */
export function buildFundCall(token: Token, recipient: Address, atoms: bigint): Erc7579CallRequest {
  if (atoms <= 0n) throw new RangeError('A fund amount must be above zero');
  if (isNativeToken(token)) return { to: recipient, value: atoms };
  return {
    to: token.address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, atoms],
    }),
  };
}
