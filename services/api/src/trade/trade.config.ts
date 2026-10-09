/**
 * The manual-trading feature flag (SEN-83, plan M-T1, "Architecture §5").
 *
 * `USER_TRADING` turns on the user's own Buy/Sell/Long/Short. It is off by
 * default because trading moves the user's funds on a testnet venue whose
 * contracts we do not control; a deployment has to opt in, never out.
 *
 * `USER_TRADE_ATOMIC_BATCH` packs a trade's steps into one ERC-7579 batch
 * instead of sending them one at a time (plan §2, "Batching"). It is honoured
 * only with `USER_TRADING` on, so turning trading off can never leave a
 * half-enabled mode behind it.
 *
 * `USER_TRADING_PERPL` offers Perpl perps to the app (`venues.perpl` in
 * `GET /trade/capabilities`, SEN-174). Honoured only with `USER_TRADING` on,
 * for the same reason as atomic batching.
 *
 * `kuruBuilder` is Sente's Kuru builder fee (SEN-184, `fees/kuru-builder.config.ts`):
 * `KURU_BUILDER_ADDRESS` and `KURU_BUILDER_FEE_PPS`, `null` when unset. Read
 * whatever `USER_TRADING` says, because agents' orders pay it too; it reaches
 * users' trades only with trading on.
 *
 * `chainId` is pinned rather than read: every address table and the phone's
 * verifier assume Monad testnet, and mainnet is out of scope (threat model,
 * "Mainnet").
 */

import { loadKuruBuilderConfig, type KuruBuilderConfig } from '../fees/kuru-builder.config';

export const TRADE_CONFIG = Symbol('TRADE_CONFIG');

/** Monad testnet — the only chain trading is built for. */
export const TRADE_CHAIN_ID = 10143;

export interface TradeConfig {
  readonly enabled: boolean;
  readonly atomicBatch: boolean;
  readonly perpl: boolean;
  readonly chainId: typeof TRADE_CHAIN_ID;
  /** Absent in older fixtures; read as `null`, no Sente fee. */
  readonly kuruBuilder?: KuruBuilderConfig | null;
}

export function loadTradeConfig(env: NodeJS.ProcessEnv = process.env): TradeConfig {
  const enabled = isOn(env.USER_TRADING);
  return {
    enabled,
    atomicBatch: enabled && isOn(env.USER_TRADE_ATOMIC_BATCH),
    perpl: enabled && isOn(env.USER_TRADING_PERPL),
    chainId: TRADE_CHAIN_ID,
    kuruBuilder: loadKuruBuilderConfig(env),
  };
}

// Only '1' and 'true' count — the same reading `AUTH_PLACEHOLDER` gets — so a
// stray 'yes' or 'on' leaves trading off rather than guessing at intent.
function isOn(raw: string | undefined): boolean {
  const value = raw?.trim();
  return value === '1' || value === 'true';
}
