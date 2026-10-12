/**
 * An agent's public page (SEN-193): `GET /public/agents/:id`, which needs no
 * session, and the link that opens it. Pure apart from `fetch`, so the parse
 * runs under plain node.
 *
 * The parse is strict on what the page draws and leaves the rest out: an
 * answer missing its mandate or its name is an error, never a half page.
 */
import { unboundFetch } from '../platform/fetch.ts';
import { API_URL } from '../wallet/api.ts';
import { fromWireMandate, type AgentMandate, type WireMandate } from './api.ts';

/** Where a shared link points when the app is not running in a browser. */
export const PUBLIC_ORIGIN = 'https://sente.lol';

export type PublicAgentStatus = 'active' | 'revoked' | 'expired';

export type PublicFill = {
  venue: 'kuru' | 'perpl';
  symbol: string;
  side: 'buy' | 'sell' | null;
  price: string | null;
  size: string;
  txHash: string | null;
  at: number;
};

export type PublicRefusal = {
  layer: 'enclave' | 'sente';
  code: string | null;
  message: string | null;
  at: number;
};

export type PublicMandateAnchor = {
  mandateHash: string | null;
  txHash: string;
  chainId: number;
  registry: string;
  agentTokenId: string;
};

export type PublicAgent = {
  id: string;
  name: string;
  sigilSeed: string;
  owner: { name: string | null; avatarSeed: string };
  model: string;
  status: PublicAgentStatus;
  address: string;
  chainId: number;
  erc8004AgentId: string | null;
  mandate: AgentMandate;
  returnsToOwner: boolean;
  mandateSince: string;
  mandateAnchor: PublicMandateAnchor | null;
  createdAt: string;
  revokedAt: string | null;
  preset: { id: string; name: string; customized: boolean } | null;
  forkedFrom: string | null;
  copies: number;
  prompt: { systemPrompt: string; strategy: string } | null;
  pnl: { allTime: string; last24h: string; allTimePartial: boolean };
  counts: { trades: number; held: number; theses: number };
  balance: { approxUsd: string; note: string } | null;
  fills: PublicFill[];
  refusals: PublicRefusal[];
  generatedAt: string;
};

export class PublicAgentError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'PublicAgentError';
  }
}

/** The page's own address: the browser's origin on the web, sente.lol elsewhere. */
export function publicAgentUrl(id: string, origin?: string): string {
  const base =
    origin ??
    (typeof window !== 'undefined' && typeof window.location?.origin === 'string'
      ? window.location.origin
      : PUBLIC_ORIGIN);
  return `${base.replace(/\/+$/, '')}/a/${encodeURIComponent(id)}`;
}

export async function fetchPublicAgent(
  id: string,
  {
    baseUrl = API_URL,
    fetchImpl = unboundFetch,
  }: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<PublicAgent> {
  const url = `${baseUrl.replace(/\/+$/, '')}/public/agents/${encodeURIComponent(id)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
  } catch {
    throw new PublicAgentError(0, 'Couldn’t reach Sente. Check the connection and try again.');
  }
  if (response.status === 404) throw new PublicAgentError(404, 'No agent at this address.');
  if (response.status === 429) {
    throw new PublicAgentError(429, 'Too many requests from here. Try again in a minute.');
  }
  if (!response.ok)
    throw new PublicAgentError(response.status, `Sente answered ${response.status}.`);
  return parsePublicAgent(await response.json());
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function need<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined) {
    throw new PublicAgentError(200, `Malformed public agent: ${field}`);
  }
  return value;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parsePublicAgent(body: unknown): PublicAgent {
  if (!isObject(body)) throw new PublicAgentError(200, 'Malformed public agent');
  const owner = isObject(body['owner']) ? body['owner'] : {};
  const pnl = isObject(body['pnl']) ? body['pnl'] : {};
  const counts = isObject(body['counts']) ? body['counts'] : {};
  const status = body['status'];
  const id = need(str(body['id']), 'id');
  if (!isObject(body['mandate']))
    throw new PublicAgentError(200, 'Malformed public agent: mandate');
  let mandate: AgentMandate;
  try {
    mandate = fromWireMandate(body['mandate'] as WireMandate);
  } catch {
    throw new PublicAgentError(200, 'Malformed public agent: mandate');
  }
  return {
    id,
    name: need(str(body['name']), 'name'),
    sigilSeed: str(body['sigilSeed']) ?? id,
    owner: { name: str(owner['name']), avatarSeed: str(owner['avatarSeed']) ?? `owner/${id}` },
    model: str(body['model']) ?? '',
    status: status === 'revoked' || status === 'expired' ? status : 'active',
    address: need(str(body['address']), 'address'),
    chainId: num(body['chainId']) ?? mandate.chainId,
    erc8004AgentId: str(body['erc8004AgentId']),
    mandate,
    returnsToOwner: body['returnsToOwner'] === true,
    mandateSince: str(body['mandateSince']) ?? '',
    mandateAnchor: parseAnchor(body['mandateAnchor']),
    createdAt: str(body['createdAt']) ?? '',
    revokedAt: str(body['revokedAt']),
    preset: isObject(body['preset'])
      ? {
          id: str(body['preset']['id']) ?? '',
          name: str(body['preset']['name']) ?? '',
          customized: body['preset']['customized'] === true,
        }
      : null,
    forkedFrom: str(body['forkedFrom']),
    copies: num(body['copies']) ?? 0,
    prompt: isObject(body['prompt'])
      ? {
          systemPrompt: str(body['prompt']['systemPrompt']) ?? '',
          strategy: str(body['prompt']['strategy']) ?? '',
        }
      : null,
    pnl: {
      allTime: str(pnl['allTime']) ?? '0',
      last24h: str(pnl['last24h']) ?? '0',
      allTimePartial: pnl['allTimePartial'] === true,
    },
    counts: {
      trades: num(counts['trades']) ?? 0,
      held: num(counts['held']) ?? 0,
      theses: num(counts['theses']) ?? 0,
    },
    balance:
      isObject(body['balance']) && str(body['balance']['approxUsd']) !== null
        ? {
            approxUsd: str(body['balance']['approxUsd'])!,
            note: str(body['balance']['note']) ?? '',
          }
        : null,
    fills: (Array.isArray(body['fills']) ? body['fills'] : []).flatMap(parseFill),
    refusals: (Array.isArray(body['refusals']) ? body['refusals'] : []).flatMap(parseRefusal),
    generatedAt: str(body['generatedAt']) ?? '',
  };
}

function parseFill(raw: unknown): PublicFill[] {
  if (!isObject(raw)) return [];
  const symbol = str(raw['symbol']);
  const size = str(raw['size']);
  const at = num(raw['at']);
  if (symbol === null || size === null || at === null) return [];
  const side = raw['side'];
  return [
    {
      venue: raw['venue'] === 'perpl' ? 'perpl' : 'kuru',
      symbol,
      side: side === 'buy' || side === 'sell' ? side : null,
      price: str(raw['price']),
      size,
      txHash: str(raw['txHash']),
      at,
    },
  ];
}

function parseRefusal(raw: unknown): PublicRefusal[] {
  if (!isObject(raw)) return [];
  const at = num(raw['at']);
  if (at === null) return [];
  return [
    {
      layer: raw['layer'] === 'enclave' ? 'enclave' : 'sente',
      code: str(raw['code']),
      message: str(raw['message']),
      at,
    },
  ];
}

function parseAnchor(raw: unknown): PublicMandateAnchor | null {
  if (!isObject(raw)) return null;
  const txHash = str(raw['txHash']);
  const chainId = num(raw['chainId']);
  const registry = str(raw['registry']);
  const agentTokenId = str(raw['agentTokenId']);
  if (txHash === null || chainId === null || registry === null || agentTokenId === null)
    return null;
  return { mandateHash: str(raw['mandateHash']), txHash, chainId, registry, agentTokenId };
}

/**
 * The status pill: what it says and how it is drawn. Expired is idle, not red:
 * a mandate that ran out is the limit working.
 */
export function statusPill(status: PublicAgentStatus): {
  label: string;
  tone: 'live' | 'idle' | 'revoked';
} {
  switch (status) {
    case 'active':
      return { label: 'Active', tone: 'live' };
    case 'expired':
      return { label: 'Mandate expired', tone: 'idle' };
    case 'revoked':
      return { label: 'Revoked', tone: 'revoked' };
  }
}

/** A signed decimal string as money: `+12.50`, `−3.10`, `0.00`. */
export function signedMoney(decimal: string): { text: string; tone: 'up' | 'down' | null } {
  const value = Number(decimal);
  if (!Number.isFinite(value) || value === 0) return { text: '0.00', tone: null };
  const abs = Math.abs(value).toFixed(2);
  return value > 0 ? { text: `+${abs}`, tone: 'up' } : { text: `−${abs}`, tone: 'down' };
}

/** Where "Hire a copy" goes: the fork flow, behind Welcome when signed out. */
export function hireCopyHref(
  agent: Pick<PublicAgent, 'id' | 'name'>,
  signedIn: boolean,
): { pathname: string; params: Record<string, string> } {
  const fork = { pathname: '/agents/new', params: { fork: agent.id, from: agent.name } };
  if (signedIn) return fork;
  const query = Object.entries(fork.params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return { pathname: '/welcome', params: { next: `${fork.pathname}?${query}` } };
}

/**
 * Where Welcome may send someone after sign-in: an in-app path only, so a
 * crafted `?next=` cannot bounce a fresh session to another site.
 */
export function safeNext(next: unknown): string | null {
  if (typeof next !== 'string') return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null;
  return next;
}
