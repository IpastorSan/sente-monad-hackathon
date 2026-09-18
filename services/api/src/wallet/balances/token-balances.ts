import { KURU_TESTNET_TOKENS, NATIVE_TOKEN } from '@sente/venues/kuru';
import { PERPL_COLLATERAL_DECIMALS, PERPL_TESTNET_CONTRACTS } from '@sente/venues/perpl';
import { erc20Abi, formatUnits, isAddressEqual, type Address } from 'viem';

/** DI token for the on-chain balance reader. */
export const TOKEN_BALANCES = Symbol('TOKEN_BALANCES');

export type BalanceToken = {
  readonly symbol: string;
  /** `NATIVE_TOKEN` (the zero address) means native MON, not an ERC-20. */
  readonly address: Address;
  readonly decimals: number;
};

/**
 * What `GET /wallet` reports, in the order the app shows it.
 *
 * The three are not interchangeable and the addresses come from the venue
 * packages rather than from a second copy here, because a drifted constant is
 * how you show a user a confident 0.00:
 *
 * - **MON** — native, pays gas when nobody sponsors it.
 * - **USDC** — Kuru Testnet USDC, the quote asset of every spot market. NOT
 *   Agora's AUSD, however similar the two look on a screen.
 * - **AUSD** — Agora AUSD, Perpl's collateral, 6 decimals (not 18). Showing it
 *   is an Agora bounty requirement, which is why it is on this screen even
 *   before the perps leg is wired to the user wallet.
 */
export const USER_WALLET_TOKENS: readonly BalanceToken[] = [
  { symbol: 'MON', address: NATIVE_TOKEN, decimals: 18 },
  KURU_TESTNET_TOKENS.USDC,
  {
    symbol: 'AUSD',
    address: PERPL_TESTNET_CONTRACTS.collateral,
    decimals: PERPL_COLLATERAL_DECIMALS,
  },
];

export type TokenBalance = {
  symbol: string;
  address: Address;
  decimals: number;
  /** Atoms. A bigint is not JSON — the DTO stringifies it. */
  raw: bigint;
  /** The same number, decimal-shifted. `formatUnits`, so never lossy. */
  amount: string;
};

export interface TokenBalanceReader {
  balances(address: Address): Promise<TokenBalance[]>;
}

/**
 * The slice of a viem public client this needs. Narrow on purpose: it makes the
 * fake in the spec three lines instead of a mocked `PublicClient`, and it says
 * exactly what reading balances is allowed to do — two read methods, nothing
 * that can write.
 */
export interface BalanceReadClient {
  getBalance(args: { address: Address }): Promise<bigint>;
  readContract(args: {
    address: Address;
    abi: typeof erc20Abi;
    functionName: 'balanceOf';
    args: readonly [Address];
  }): Promise<bigint>;
}

/** Reads every {@link USER_WALLET_TOKENS} balance, in parallel, over viem. */
export class ViemTokenBalanceReader implements TokenBalanceReader {
  readonly #client: BalanceReadClient;
  readonly #tokens: readonly BalanceToken[];

  constructor(client: BalanceReadClient, tokens: readonly BalanceToken[] = USER_WALLET_TOKENS) {
    this.#client = client;
    this.#tokens = tokens;
  }

  balances(address: Address): Promise<TokenBalance[]> {
    return Promise.all(
      this.#tokens.map(async (token) => {
        const raw = isAddressEqual(token.address, NATIVE_TOKEN)
          ? await this.#client.getBalance({ address })
          : await this.#client.readContract({
              address: token.address,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [address],
            });
        return {
          symbol: token.symbol,
          address: token.address,
          decimals: token.decimals,
          raw,
          amount: formatUnits(raw, token.decimals),
        };
      }),
    );
  }
}
