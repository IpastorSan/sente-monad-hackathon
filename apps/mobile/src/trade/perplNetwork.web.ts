/**
 * Web twin of `perplNetwork.ts`: Perpl testnet through Sente's proxy on the API
 * host (SEN-175), because Perpl refuses a browser on sente.lol. See
 * `perplProxy.ts` for why, and README "Status and limits" for what the proxy
 * could do with an open trading socket.
 */
import type { PerplNetwork } from '@sente/venues/perpl';

import { API_URL } from '../wallet/api.ts';
import { perplProxyNetwork } from './perplProxy.ts';

export const PERPL_NETWORK: PerplNetwork = perplProxyNetwork(API_URL);
