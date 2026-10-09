/**
 * `kuruRetired` on the agent response (SEN-185). An agent hired before Kuru's
 * 2026-09-25 redeploy stores, and its live policy pins, the retired books: the
 * owner must be told in words and handed the amend that moves it, not left to
 * read a bare `policy_violation` off a refused trade.
 */
import {
  KURU_RETIRED_DEPLOYMENT,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
} from '@sente/venues/kuru';
import { getAddress, type Address } from 'viem';

import { testAgent } from '../tools/testing/agent-fixture';
import { toAgentResponse } from './agent.dto';

const retired = (symbol: string): Address =>
  KURU_RETIRED_DEPLOYMENT.markets.find((m) => m.symbol === symbol)!.address;
const retiredUsdc = KURU_RETIRED_DEPLOYMENT.tokens.find((t) => t.symbol === 'USDC')!.address;
const current = (symbol: string): Address =>
  KURU_TESTNET_MARKETS.find((m) => m.symbol === symbol)!.address;

function setCAgent() {
  const agent = testAgent();
  return testAgent({
    mandate: {
      ...agent.mandate,
      kuru: {
        markets: [retired('MON-USDC'), retired('cbBTC-USDC')],
        maxDepositAtoms: { [retiredUsdc]: 1_000_000_000n },
      },
    },
  });
}

describe('toAgentResponse: kuruRetired (SEN-185)', () => {
  it('is absent for a mandate on the current books', () => {
    expect(toAgentResponse(testAgent())).not.toHaveProperty('kuruRetired');
  });

  it('names the retired books, says to amend, and carries the moved mandate', () => {
    const response = toAgentResponse(setCAgent());
    expect(response.kuruRetired?.message).toBe(
      "This agent's mandate names markets Kuru retired — amend it to move to the new markets " +
        '(MON-USDC, cbBTC-USDC → WBTC-USDC). Until then it cannot trade on Kuru.',
    );
    expect(response.kuruRetired?.moves.map((m) => [m.fromSymbol, m.toSymbol])).toEqual([
      ['MON-USDC', 'MON-USDC'],
      ['cbBTC-USDC', 'WBTC-USDC'],
      ['USDC', 'USDC'],
    ]);
    const moved = response.kuruRetired!.mandate;
    expect(moved.kuru.markets).toEqual([current('MON-USDC'), current('WBTC-USDC')]);
    expect(moved.kuru.maxDepositAtoms).toEqual({
      [getAddress(KURU_TESTNET_TOKENS.USDC.address)]: '1000000000',
    });
  });

  it('says nothing for a revoked agent, which has nothing left to amend', () => {
    const revoked = { ...setCAgent(), status: 'revoked' as const };
    expect(toAgentResponse(revoked)).not.toHaveProperty('kuruRetired');
  });
});
