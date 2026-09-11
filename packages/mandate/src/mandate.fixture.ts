/** Shared test mandate, built from the real Kuru testnet tables. */
import { KURU_TESTNET_MARKETS, KURU_TESTNET_TOKENS } from '@sente/venues/kuru';
import type { Address } from 'viem';

import { parseMandate, type Mandate } from './mandate.ts';

function market(symbol: string): Address {
  const found = KURU_TESTNET_MARKETS.find((m) => m.symbol === symbol);
  if (!found) throw new Error(`no Kuru testnet market ${symbol}`);
  return found.address;
}

export const MON_USDC = market('MON-USDC');
export const WETH_USDC = market('WETH-USDC');
export const CBBTC_USDC = market('cbBTC-USDC');
export const USDC = KURU_TESTNET_TOKENS.USDC.address;
export const WETH = KURU_TESTNET_TOKENS.WETH.address;
export const MON = KURU_TESTNET_TOKENS.MON.address;

export const EXPIRES_AT = 2_000_000_000;
/** 2026-09-11, well inside the mandate. */
export const NOW = 1_789_000_000;

/** A mandate as it arrives over JSON: atoms as decimal strings, addresses lowercase. */
export function demoMandateInput(): Record<string, unknown> {
  return {
    version: 1,
    chainId: 10143,
    expiresAt: EXPIRES_AT,
    venues: ['kuru', 'perpl'],
    kuru: {
      markets: [MON_USDC.toLowerCase(), WETH_USDC.toLowerCase()],
      maxDepositAtoms: {
        [USDC.toLowerCase()]: '1000000000', // 1,000 USDC
        [MON]: '5000000000000000000', // 5 MON
      },
    },
    perpl: { maxCollateralAtoms: '500000000', maxLeverage: 5, markets: ['BTC-PERP', 'ETH-PERP'] },
    maxOrderNotional: '250.5',
  };
}

export function demoMandate(patch: Partial<Mandate> = {}): Mandate {
  return { ...parseMandate(demoMandateInput()), ...patch };
}
