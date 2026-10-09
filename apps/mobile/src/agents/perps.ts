/**
 * The agent's own Perpl account, as the agent page says it (SEN-187).
 *
 * Sente opens it: once an agent whose mandate includes Perpl holds Perpl's
 * opening minimum of AUSD, the API sends approve → createAccount →
 * allowOrderForwarding from the agent's wallet and enrolls its key. Until
 * then the agent cannot trade a perp, and the page has to say why, in the
 * owner's terms: fund it, give it gas, or raise the mandate's cap.
 *
 * Pure, no React Native, so `perps.test.ts` pins every line under plain node.
 */
import { formatAtoms } from './amounts.ts';
import { AUSD, PERPL_MIN_OPEN_ATOMS, type Token } from './mandate.ts';

/** `GET /agents/:id/perpl`, as the API sends it: atoms and wei as decimal strings. */
export type PerpsStatusDto = {
  state:
    | 'not_in_mandate'
    | 'revoked'
    | 'cap_below_minimum'
    | 'needs_funds'
    | 'opening'
    | 'needs_gas'
    | 'failed'
    | 'ready'
    | 'unavailable';
  minimumAtoms?: string;
  capAtoms?: string;
  walletAtoms?: string;
  needWei?: string;
  haveWei?: string;
  accountId?: string;
  collateralAtoms?: string;
  message?: string;
  retryAt?: number;
};

export type PerpsTone = 'live' | 'held' | 'idle';

/** One line for the agent page: a pill, a sentence, and the fix when there is one. */
export type PerpsLine = {
  tone: PerpsTone;
  title: string;
  detail: string;
  /** The Fund sheet, opened on AUSD, fixes it. */
  fund?: 'AUSD' | 'MON';
};

const ausd = (atoms: string | undefined) => formatAtoms(BigInt(atoms ?? '0'), AUSD.decimals);

/** `null`: nothing worth a line (no Perpl in the mandate, revoked, or not known). */
export function perpsLine(status: PerpsStatusDto | null): PerpsLine | null {
  if (!status) return null;
  switch (status.state) {
    case 'opening':
      return {
        tone: 'live',
        title: 'Perps: opening account…',
        detail: 'Sente is opening the agent’s Perpl account and enrolling its key.',
      };
    case 'needs_funds': {
      const minimum = ausd(status.minimumAtoms);
      return {
        tone: 'held',
        title: `Perps need at least ${minimum} AUSD — fund it`,
        detail:
          `Perpl opens an account with ${minimum} AUSD or more. The agent holds ` +
          `${ausd(status.walletAtoms)} AUSD; Sente opens the account once it has enough.`,
        fund: 'AUSD',
      };
    }
    case 'cap_below_minimum':
      return {
        tone: 'held',
        title: 'Perps can’t open under this mandate',
        detail:
          `The mandate lets at most ${ausd(status.capAtoms)} AUSD into Perpl, under the ` +
          `${ausd(status.minimumAtoms)} AUSD Perpl needs to open an account. Amend the mandate.`,
      };
    case 'needs_gas':
      return {
        tone: 'held',
        title: 'Perps need gas',
        detail: status.message ?? 'The agent needs MON to pay for opening its Perpl account.',
        fund: 'MON',
      };
    case 'failed':
      return {
        tone: 'held',
        title: 'Perps couldn’t open yet',
        detail: `${status.message ?? 'Opening the Perpl account failed.'} Sente tries again shortly.`,
      };
    case 'ready':
      return {
        tone: 'idle',
        title: 'Perps ready',
        detail: `Perpl account ${status.accountId ?? '—'} · ${ausd(status.collateralAtoms)} AUSD collateral`,
      };
    default:
      return null;
  }
}

/** While the account is opening, ask again soon; otherwise only on focus. */
export function perpsPollMs(status: PerpsStatusDto | null): number | null {
  return status?.state === 'opening' ? 3_000 : null;
}

/**
 * What the Fund sheet says under the amount when the mandate trades perps:
 * AUSD is what opens the account, and how much it takes.
 */
export function perpsFundHint(
  venues: readonly string[],
  token: Token,
  atoms: bigint | null,
): string | null {
  if (!venues.includes('perpl')) return null;
  const minimum = formatAtoms(PERPL_MIN_OPEN_ATOMS, AUSD.decimals);
  if (token.symbol !== AUSD.symbol) {
    return `Perps trade with AUSD: send at least ${minimum} AUSD to open the agent’s Perpl account.`;
  }
  if (atoms !== null && atoms > 0n && atoms < PERPL_MIN_OPEN_ATOMS) {
    return `Perpl opens an account with at least ${minimum} AUSD, so this alone won’t open it.`;
  }
  return `Sente opens the agent’s Perpl account with this AUSD, up to the mandate’s cap.`;
}
