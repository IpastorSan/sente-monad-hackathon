/** A hired agent for specs, with a mandate built from the real Kuru testnet tables. */
import { parseMandate } from '@sente/mandate';
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import { getAddress } from 'viem';

import type { AgentRecord } from '../../store/agent-store';

export const MON_USDC = 'MON-USDC';
export const MON_USDC_BOOK = KURU_TESTNET_MARKETS.find((m) => m.symbol === MON_USDC)!.address;
/** Listed on Kuru, but not in the test mandate. */
export const WETH_USDC = 'WETH-USDC';
export const BTC_PERP = 'BTC-PERP';

export const EXPIRES_AT = 2_000_000_000;
/** Inside the mandate. */
export const NOW = 1_789_000_000;

/**
 * As it arrives over JSON: MON-USDC only on Kuru, up to 1,000 USDC per
 * deposit; BTC-PERP on Perpl at up to 5x; no order over 250 USDC.
 */
export function testMandateInput(): Record<string, unknown> {
  return {
    version: 1,
    chainId: 10143,
    expiresAt: EXPIRES_AT,
    venues: ['kuru', 'perpl'],
    kuru: {
      markets: [MON_USDC_BOOK],
      maxDepositAtoms: { [KURU_TESTNET_TOKENS.USDC.address]: '1000000000' },
    },
    perpl: { maxCollateralAtoms: '500000000', maxLeverage: 5, markets: [BTC_PERP] },
    maxOrderNotional: '250',
  };
}

export function testAgent(patch: Partial<AgentRecord> = {}): AgentRecord {
  const now = new Date();
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'alice',
    name: 'Momentum',
    systemPrompt: 'Trade carefully.',
    strategy: 'Buy strength.',
    model: 'anthropic/claude-sonnet-5',
    mandate: parseMandate(testMandateInput()),
    walletId: 'wallet-1',
    address: getAddress(`0x${'4'.repeat(40)}`),
    policyId: 'policy-1',
    mcpTokenHash: 'a'.repeat(64),
    status: 'active',
    policyCleared: false,
    // Private by default: a fixture only publishes its prompt when a spec says so.
    public: false,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}
