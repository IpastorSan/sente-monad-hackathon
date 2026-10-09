// What the headless "phone" scripts share (`trade-live.ts`, `live-flows.ts`):
// the identity, signing in with it, Kuru sizing, and reading a user operation's
// own outcome off the chain (CLAUDE.md gotcha 8).
//
// The identity is two keys: `authKey`, the secp256k1 key that signs in (the
// passkey wallet key's stand-in), and `deviceKey`, the P-256 key that owns the
// user's Privy wallet. Neither is ever printed.

import { p256 } from '@noble/curves/nist.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { KuruMarketConfig } from '@sente/venues/kuru';
import { decodeEventLog, parseAbi, type Address, type Hash, type PublicClient } from 'viem';
import { generatePrivateKey, type PrivateKeyAccount } from 'viem/accounts';

import type { SessionAuth } from '../src/wallet/api.ts';

export type PhoneKeys = { authKey: `0x${string}`; deviceKey: string };

export function newPhoneKeys(): PhoneKeys {
  return { authKey: generatePrivateKey(), deviceKey: bytesToHex(p256.utils.randomSecretKey()) };
}

/** `session/auth.ts` minus React: challenge, personal_sign, exchange. */
export function sessionAuth(api: string, account: PrivateKeyAccount): SessionAuth {
  let token: string | null = null;
  const post = async (path: string, body: unknown): Promise<Record<string, string>> => {
    const response = await fetch(`${api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} → ${response.status}: ${text}`);
    return JSON.parse(text) as Record<string, string>;
  };
  return {
    token: () => token,
    async refresh() {
      const challenge = await post('/auth/challenge', { address: account.address });
      const signature = await account.signMessage({ message: challenge['message']! });
      token = (await post('/auth/session', { address: account.address, signature }))['token']!;
      return token;
    },
  };
}

/** Size units whose quote notional at `price` is at least `notionalAtoms`. */
export function sizeForNotional(m: KuruMarketConfig, price: bigint, notionalAtoms: bigint): bigint {
  // notionalAtoms = price * size * 10^quoteDec / (pricePrecision * sizePrecision)
  const denominator = price * 10n ** BigInt(m.quote.decimals);
  const numerator = notionalAtoms * m.pricePrecision * m.sizePrecision;
  return (numerator + denominator - 1n) / denominator;
}

export function notionalAtoms(m: KuruMarketConfig, price: bigint, size: bigint): bigint {
  return (price * size * 10n ** BigInt(m.quote.decimals)) / (m.pricePrecision * m.sizePrecision);
}

export const USER_OPERATION_EVENT = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

export type LandedUserOp = { entryPoint: Address; block: bigint; success: boolean };

/**
 * Where `userOpHash` landed inside `transactionHash`, and whether IT succeeded:
 * the carrying transaction's status says nothing about one operation in it.
 */
export async function landedAt(
  client: PublicClient,
  transactionHash: Hash,
  userOpHash: Hash,
): Promise<LandedUserOp> {
  const receipt = await client.getTransactionReceipt({ hash: transactionHash });
  for (const log of receipt.logs) {
    try {
      const event = decodeEventLog({
        abi: USER_OPERATION_EVENT,
        data: log.data,
        topics: log.topics,
      });
      if (event.args.userOpHash === userOpHash) {
        return { entryPoint: log.address, block: receipt.blockNumber, success: event.args.success };
      }
    } catch {
      // not a UserOperationEvent
    }
  }
  throw new Error(`no UserOperationEvent for ${userOpHash} in ${transactionHash}`);
}
