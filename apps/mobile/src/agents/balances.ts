/** On-chain balances for the fund sheet and the agent page. Read-only. */
import { erc20Abi, type Address } from 'viem';

import { publicClient } from '@/chain';

import { FUNDING_TOKENS, isNativeToken } from './fund';
import type { Token } from './mandate';

export function readBalance(token: Token, owner: Address): Promise<bigint> {
  return isNativeToken(token)
    ? publicClient.getBalance({ address: owner })
    : publicClient.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });
}

/** Every funding token's balance, keyed by symbol. */
export async function readBalances(owner: Address): Promise<Record<string, bigint>> {
  const entries = await Promise.all(
    FUNDING_TOKENS.map(async (token) => [token.symbol, await readBalance(token, owner)] as const),
  );
  return Object.fromEntries(entries);
}
