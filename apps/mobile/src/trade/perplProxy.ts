/**
 * Where the WEB build reaches Perpl: through Sente's own proxy (SEN-175).
 *
 * Perpl testnet refuses browser origins. Its trading WebSocket answers a
 * handshake carrying `Origin: https://sente.lol` with 403, and its REST API
 * sends no CORS headers, so a page on sente.lol can neither trade nor read the
 * market context it signs against. `infra/Caddyfile` therefore proxies
 * `<api>/perpl/*` to `https://testnet.perpl.xyz/*` with Perpl's own Origin and
 * CORS for sente.lol. The Android app is not a browser and goes direct
 * (`perplNetwork.ts`).
 *
 * Pure, so the derivation is testable under node without the web twin's
 * bundle-time `EXPO_PUBLIC_API_URL`.
 */
import { PERPL_NETWORKS, type PerplNetwork } from '@sente/venues/perpl';

/**
 * The testnet network as seen through the proxy on `apiUrl`, e.g.
 * `https://api.sente.lol` → REST `https://api.sente.lol/perpl/api`, sockets
 * under `wss://api.sente.lol/perpl` (the adapter appends `/ws/v1/…`).
 */
export function perplProxyNetwork(apiUrl: string): PerplNetwork {
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`the API URL must be http(s), got ${apiUrl}`);
  }
  if (url.search || url.hash) {
    throw new Error(`the API URL must have no query or fragment, got ${apiUrl}`);
  }
  const base = `${url.host}${url.pathname.replace(/\/+$/, '')}/perpl`;
  const secure = url.protocol === 'https:';
  return {
    restUrl: `${secure ? 'https' : 'http'}://${base}/api`,
    wsUrl: `${secure ? 'wss' : 'ws'}://${base}`,
    // The proxy reaches testnet only, and the sign-in frame signs this.
    chainId: PERPL_NETWORKS.testnet.chainId,
  };
}
