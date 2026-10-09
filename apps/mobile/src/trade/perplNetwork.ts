/**
 * The Perpl network the phone trades on: testnet, directly.
 *
 * React Native's WebSocket and fetch send no browser Origin, and Perpl accepts
 * those, so the Android app talks to Perpl itself and nothing of Sente's sits
 * between the trade key's socket and the venue. The web build cannot: see the
 * twin, `perplNetwork.web.ts`.
 */
import { PERPL_NETWORKS, type PerplNetwork } from '@sente/venues/perpl';

export const PERPL_NETWORK: PerplNetwork = PERPL_NETWORKS.testnet;
