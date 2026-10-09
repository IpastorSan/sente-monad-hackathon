/**
 * Sente opens an agent's Perpl account for it (SEN-187).
 *
 * Before this, nothing in the API ever called `PerplAgentAccounts.onboard`:
 * only the live scripts did. A user could hire an agent with BTC-PERP in its
 * mandate, fund it with AUSD, and the agent could never trade a perp — its
 * on-demand key enrollment (SEN-148) failed for want of an account.
 *
 * WHAT IT DOES. For an active agent whose mandate includes Perpl, with no
 * account yet and at least Perpl's opening minimum of AUSD in its wallet, it
 * sends approve(exact amount) → createAccount(amount) →
 * allowOrderForwarding(true) through `PerplAgentAccounts.onboard`, signed by
 * the agent's own key inside its mandate policy, then enrolls the agent's
 * Perpl API key at once rather than at the first order. The amount is what
 * the wallet holds, up to the mandate's per-transaction collateral cap; the
 * rest stays in the wallet.
 *
 * WHEN. `kick` after the owner funds the agent (the phone's Fund sheet, the
 * Alchemy deposit webhook) and whenever the agent page reads the status (a
 * balance poll); `ensure` at the start of every run, before its tools. Every
 * path converges on one single flight per agent.
 *
 * SAFE TO REPEAT. It resumes rather than restarts: an account that exists is
 * never opened again, an approve that already covers the amount is not sent
 * again, forwarding is re-granted only when no `onboarding` event recorded it,
 * and enrollment reuses a stored key (`PerplAgentAccounts.credentials`).
 *
 * ONE WRITE AT A TIME. The work runs inside `exclusive(agentId, …)`, which the
 * Nest wiring makes the runner's `WriteSpacer` around the tools' per-agent
 * write lock — the same two the agent's own signing tools go through, in the
 * same order — so onboarding never interleaves with an order, and is spaced
 * from it by `AGENT_WRITE_SPACING_MS`.
 *
 * NEVER SILENT. A gas shortfall, an enclave refusal or a revert is appended to
 * the agent's event log as an `onboarding` event the Ledger shows, and held as
 * the status for `retryMs`, so a polling screen sees why rather than a spinner.
 * The agent pays its own gas (~0.0355 MON at 100 gwei for all three legs);
 * Monad charges the limit (gotcha 4), so the check is the limits times the fee.
 *
 * Erasable syntax and `.ts` specifiers only (CLAUDE.md gotcha 10).
 */
import {
  onboardingParams,
  PERPL_TESTNET_CONTRACTS,
  PERPL_TESTNET_MIN_ACCOUNT_OPEN_ATOMS,
  type PerplContext,
} from '@sente/venues/perpl';
import { erc20Abi, formatEther, formatUnits, type Address, type PublicClient } from 'viem';

import { EnclaveRefusedError } from '../agents.errors.ts';
import type { AgentEventLog } from '../events/agent-event-log.ts';
import type { AgentRecord, AgentStore } from '../store/agent-store.ts';
import type { AgentSecretStore } from './agent-secret-store.ts';
import {
  PerplOnboardingError,
  perplAccountInfo,
  type PerplAccountInfo,
  type PerplAgentAccounts,
  type PerplOnboardingPlan,
} from './perpl-agent.ts';

const AUSD_DECIMALS = 6;

/** Resolves Perpl's live `/v1/pub/context` (`trade/perpl-context.ts#cachedPerplContext`). */
export type PerplContextSource = () => Promise<PerplContext>;

/** DI token for Perpl's live `/v1/pub/context`, cached (the trade module keeps its own). */
export const AGENT_PERPL_CONTEXT = Symbol('AGENT_PERPL_CONTEXT');

/**
 * The account-opening minimum a mandate's collateral cap must reach (SEN-187):
 * the live one, or the testnet constant when Perpl cannot be reached — a hire
 * must not fail because Perpl's REST API blinked.
 */
export async function perplOpeningMinimum(context: PerplContextSource): Promise<bigint> {
  try {
    return onboardingParams(await context()).minAccountOpenAmount;
  } catch {
    return PERPL_TESTNET_MIN_ACCOUNT_OPEN_ATOMS;
  }
}

/** Where a kick came from. Recorded on the event, so the Ledger can say why. */
export type OnboardingTrigger = 'fund' | 'deposit' | 'poll' | 'run';

/** The agent's Perpl account, as the agent page shows it. Atoms and wei are bigints. */
export type PerplOnboardingStatus =
  | { readonly state: 'not_in_mandate' }
  | { readonly state: 'revoked' }
  /** The mandate's collateral cap is under what Perpl needs to open: amend it. */
  | {
      readonly state: 'cap_below_minimum';
      readonly minimumAtoms: bigint;
      readonly capAtoms: bigint;
    }
  /** Waiting for the owner to fund at least `minimumAtoms` of AUSD. */
  | {
      readonly state: 'needs_funds';
      readonly minimumAtoms: bigint;
      readonly walletAtoms: bigint;
      readonly capAtoms: bigint;
    }
  | { readonly state: 'opening' }
  /** The agent cannot pay the gas the next legs cost. */
  | {
      readonly state: 'needs_gas';
      readonly needWei: bigint;
      readonly haveWei: bigint;
      readonly message: string;
    }
  /** The last attempt failed; the next is not before `retryAt` (epoch ms). */
  | { readonly state: 'failed'; readonly message: string; readonly retryAt: number }
  | { readonly state: 'ready'; readonly accountId: bigint; readonly collateralAtoms: bigint }
  /** A read failed (RPC, Perpl's context): nothing is known, nothing was sent. */
  | { readonly state: 'unavailable'; readonly message: string };

export type PerplOnboardingState = PerplOnboardingStatus['state'];

/** The `detail` of an `onboarding` event. JSON-safe: atoms and wei as decimal strings. */
export interface OnboardingEventDetail {
  readonly venue: 'perpl';
  readonly status: 'opened' | 'resumed' | 'enrolled' | 'needs_gas' | 'failed';
  /** One sentence for the Ledger: "Opened Perpl account 505 with 100 AUSD". */
  readonly message: string;
  readonly trigger: OnboardingTrigger;
  readonly accountId?: string;
  /** Decimal AUSD, and the exact atoms beside it. */
  readonly amount?: string;
  readonly amountAtoms?: string;
  readonly asset?: 'AUSD';
  readonly steps?: readonly string[];
  readonly txHashes?: readonly string[];
  /** Set once forwarding is known to be granted: what a later resume reads. */
  readonly forwarding?: true;
  readonly needWei?: string;
  readonly haveWei?: string;
  /** The step that reverted, and its hash. */
  readonly step?: string;
  readonly txHash?: string;
}

/** The chain reads onboarding needs, so specs fake four functions, not viem. */
export interface PerplOnboardingChain {
  account(address: Address): Promise<PerplAccountInfo | null>;
  collateralBalance(address: Address): Promise<bigint>;
  nativeBalance(address: Address): Promise<bigint>;
  maxFeePerGas(): Promise<bigint>;
}

export function perplOnboardingChain(client: PublicClient): PerplOnboardingChain {
  return {
    account: (address) => perplAccountInfo(client, address),
    collateralBalance: (address) =>
      client.readContract({
        address: PERPL_TESTNET_CONTRACTS.collateral,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      }),
    nativeBalance: (address) => client.getBalance({ address }),
    maxFeePerGas: async () => {
      const fees = await client.estimateFeesPerGas();
      if (fees.maxFeePerGas === undefined) throw new Error('the RPC returned no EIP-1559 fees');
      return fees.maxFeePerGas;
    },
  };
}

export type Exclusive = <T>(agentId: string, task: () => Promise<T>) => Promise<T>;

export interface AgentPerplOnboarderOptions {
  readonly accounts: Pick<PerplAgentAccounts, 'onboard' | 'credentials'>;
  readonly secrets: Pick<AgentSecretStore, 'getPerplCredentials'>;
  readonly chain: PerplOnboardingChain;
  readonly events: Pick<AgentEventLog, 'append' | 'list'>;
  /** Re-read inside the flight: an amend or a revoke since the kick applies. */
  readonly agents: Pick<AgentStore, 'get'>;
  /** Perpl's `min_account_open_amount`, read live (atoms). */
  readonly minimum: () => Promise<bigint>;
  /** Serialise with the agent's own writes. Default: run as is. */
  readonly exclusive?: Exclusive;
  /** How long a failure is shown and not retried. Default 60 s. */
  readonly retryMs?: number;
  /** How long a computed status is reused by `status`. Default 10 s. */
  readonly statusTtlMs?: number;
  /** After a fund, how long to keep looking for the AUSD to land. Default 45 s. */
  readonly fundsWaitMs?: number;
  readonly fundsPollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: { log(message: string): void; warn(message: string): void };
}

/** What the agent needs next, before anything is sent. */
type Plan =
  | { readonly kind: 'done'; readonly status: PerplOnboardingStatus }
  | { readonly kind: 'open'; readonly amount: bigint }
  | {
      readonly kind: 'finish';
      readonly account: PerplAccountInfo;
      readonly forwarding: boolean;
      readonly enrolled: boolean;
    };

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export class AgentPerplOnboarder {
  readonly #accounts: AgentPerplOnboarderOptions['accounts'];
  readonly #secrets: AgentPerplOnboarderOptions['secrets'];
  readonly #chain: PerplOnboardingChain;
  readonly #events: AgentPerplOnboarderOptions['events'];
  readonly #agents: AgentPerplOnboarderOptions['agents'];
  readonly #minimum: () => Promise<bigint>;
  readonly #exclusive: Exclusive;
  readonly #retryMs: number;
  readonly #statusTtlMs: number;
  readonly #fundsWaitMs: number;
  readonly #fundsPollMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #logger: AgentPerplOnboarderOptions['logger'];
  /** One flight per agent: every trigger joins it. */
  readonly #flights = new Map<string, Promise<PerplOnboardingStatus>>();
  /** Agents whose post-fund wait is running, so a second kick does not start another. */
  readonly #waiting = new Set<string>();
  /** The last failure per agent, shown until `retryAt`. */
  readonly #failures = new Map<string, PerplOnboardingStatus & { readonly retryAt: number }>();
  /** Agents whose forwarding grant is known to have landed. */
  readonly #forwarding = new Set<string>();
  /** The last failure event appended per agent, so a retry loop does not flood the Ledger. */
  readonly #lastRecorded = new Map<string, string>();
  readonly #cache = new Map<
    string,
    { readonly at: number; readonly status: PerplOnboardingStatus }
  >();

  constructor(options: AgentPerplOnboarderOptions) {
    this.#accounts = options.accounts;
    this.#secrets = options.secrets;
    this.#chain = options.chain;
    this.#events = options.events;
    this.#agents = options.agents;
    this.#minimum = options.minimum;
    this.#exclusive = options.exclusive ?? ((_agentId, task) => task());
    this.#retryMs = options.retryMs ?? 60_000;
    this.#statusTtlMs = options.statusTtlMs ?? 10_000;
    this.#fundsWaitMs = options.fundsWaitMs ?? 45_000;
    this.#fundsPollMs = options.fundsPollMs ?? 3_000;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? sleepFor;
    this.#logger = options.logger;
  }

  /**
   * Where the agent's Perpl account stands. A flight in progress reads
   * `opening`; a recent failure reads as itself until it may be retried.
   * Cached for `statusTtlMs`.
   *
   * A status that finds something to do starts it in the background and
   * answers `opening`: the agent page's poll is how funds sent from anywhere,
   * not only through the Fund sheet, get the account opened.
   */
  async status(agent: AgentRecord): Promise<PerplOnboardingStatus> {
    const quick = this.#quick(agent);
    if (quick) return quick;
    const cached = this.#cache.get(agent.id);
    if (cached && this.#now() - cached.at < this.#statusTtlMs) return cached.status;
    const plan = await this.#plan(agent);
    if (plan.kind === 'done') {
      this.#cache.set(agent.id, { at: this.#now(), status: plan.status });
      return plan.status;
    }
    void this.ensure(agent, 'poll');
    return { state: 'opening' };
  }

  /**
   * Opens and enrolls whatever is missing, and answers with where it ended.
   * Joins a flight already running for the agent. Never throws: a failure is
   * an event and a status.
   */
  ensure(
    agent: AgentRecord,
    trigger: OnboardingTrigger,
    runId?: string,
  ): Promise<PerplOnboardingStatus> {
    const quick = this.#quick(agent);
    if (quick && quick.state !== 'opening') return Promise.resolve(quick);
    let flight = this.#flights.get(agent.id);
    if (!flight) {
      flight = this.#exclusive(agent.id, () => this.#run(agent.id, trigger, runId))
        .catch((error: unknown): PerplOnboardingStatus => {
          const message = messageOf(error);
          this.#logger?.warn(`agent ${agent.id}: Perpl onboarding threw: ${message}`);
          return { state: 'unavailable', message };
        })
        .finally(() => this.#flights.delete(agent.id));
      this.#flights.set(agent.id, flight);
    }
    return flight;
  }

  /**
   * `ensure` in the background. With `awaitFunds` (right after a fund), a
   * `needs_funds` answer is retried every `fundsPollMs` for `fundsWaitMs`: the
   * transfer may not have landed when the phone asks.
   */
  kick(agent: AgentRecord, trigger: OnboardingTrigger, options: { awaitFunds?: boolean } = {}) {
    if (!this.#inMandate(agent) || agent.status !== 'active') return;
    if (!options.awaitFunds) {
      void this.ensure(agent, trigger);
      return;
    }
    if (this.#waiting.has(agent.id)) return;
    this.#waiting.add(agent.id);
    // A fresh fund is new information: drop the cached "needs funds".
    this.#cache.delete(agent.id);
    void (async () => {
      const until = this.#now() + this.#fundsWaitMs;
      for (;;) {
        const status = await this.ensure(agent, trigger);
        if (status.state !== 'needs_funds' || this.#now() >= until) return;
        await this.#sleep(this.#fundsPollMs);
        this.#cache.delete(agent.id);
      }
    })().finally(() => this.#waiting.delete(agent.id));
  }

  /** The answers that need no chain read. */
  #quick(agent: AgentRecord): PerplOnboardingStatus | undefined {
    if (!this.#inMandate(agent)) return { state: 'not_in_mandate' };
    if (agent.status !== 'active') return { state: 'revoked' };
    if (this.#flights.has(agent.id)) return { state: 'opening' };
    const failure = this.#failures.get(agent.id);
    if (failure && this.#now() < failure.retryAt) return failure;
    return undefined;
  }

  #inMandate(agent: AgentRecord): boolean {
    return agent.mandate.venues.includes('perpl');
  }

  async #plan(agent: AgentRecord): Promise<Plan> {
    let account: PerplAccountInfo | null;
    let minimum: bigint;
    try {
      [account, minimum] = await Promise.all([this.#chain.account(agent.address), this.#minimum()]);
    } catch (error) {
      return { kind: 'done', status: { state: 'unavailable', message: messageOf(error) } };
    }

    if (account) {
      const [forwarding, enrolled] = await Promise.all([
        this.#forwardingKnown(agent.id),
        this.#secrets.getPerplCredentials(agent.id).then((held) => held !== undefined),
      ]);
      if (forwarding && enrolled) {
        return {
          kind: 'done',
          status: {
            state: 'ready',
            accountId: account.accountId,
            collateralAtoms: account.balance,
          },
        };
      }
      return { kind: 'finish', account, forwarding, enrolled };
    }

    const cap = collateralCap(agent);
    if (cap < minimum) {
      return {
        kind: 'done',
        status: { state: 'cap_below_minimum', minimumAtoms: minimum, capAtoms: cap },
      };
    }
    let wallet: bigint;
    try {
      wallet = await this.#chain.collateralBalance(agent.address);
    } catch (error) {
      return { kind: 'done', status: { state: 'unavailable', message: messageOf(error) } };
    }
    if (wallet < minimum) {
      return {
        kind: 'done',
        status: { state: 'needs_funds', minimumAtoms: minimum, walletAtoms: wallet, capAtoms: cap },
      };
    }
    return { kind: 'open', amount: wallet < cap ? wallet : cap };
  }

  async #run(
    agentId: string,
    trigger: OnboardingTrigger,
    runId: string | undefined,
  ): Promise<PerplOnboardingStatus> {
    // The agent as it is NOW: an amend or a revoke since the kick applies.
    const agent = await this.#agents.get(agentId);
    if (!agent) return { state: 'unavailable', message: `no agent ${agentId}` };
    if (!this.#inMandate(agent)) return { state: 'not_in_mandate' };
    if (agent.status !== 'active') return { state: 'revoked' };

    const plan = await this.#plan(agent);
    if (plan.kind === 'done') {
      this.#cache.set(agent.id, { at: this.#now(), status: plan.status });
      return plan.status;
    }
    this.#cache.delete(agent.id);
    const record = (detail: Omit<OnboardingEventDetail, 'venue' | 'trigger'>) =>
      this.#record(agent.id, { venue: 'perpl', trigger, ...detail }, runId);
    const identity = { agentId: agent.id, walletId: agent.walletId, address: agent.address };

    let accountId: bigint;
    try {
      if (plan.kind === 'open' || !plan.forwarding) {
        const done = await this.#accounts.onboard(
          identity,
          plan.kind === 'open' ? plan.amount : undefined,
          {
            // An account that exists here has no recorded grant: re-grant it.
            forwarding: false,
            beforeSend: (next) => this.#gasGate(agent, next),
          },
        );
        accountId = done.accountId;
        this.#forwarding.add(agent.id);
        const hashes = done.transactions.map(String);
        if (done.onboarded && done.amount !== undefined) {
          const amount = formatUnits(done.amount, AUSD_DECIMALS);
          await record({
            status: 'opened',
            message: `Opened Perpl account ${accountId} with ${amount} AUSD`,
            accountId: accountId.toString(),
            amount,
            amountAtoms: done.amount.toString(),
            asset: 'AUSD',
            steps: done.steps,
            txHashes: hashes,
            forwarding: true,
          });
        } else {
          await record({
            status: 'resumed',
            message: `Turned on order forwarding for Perpl account ${accountId}`,
            accountId: accountId.toString(),
            steps: done.steps,
            txHashes: hashes,
            forwarding: true,
          });
        }
      } else {
        accountId = plan.account.accountId;
      }
    } catch (error) {
      return this.#fail(agent.id, error, record);
    }

    if (plan.kind !== 'finish' || !plan.enrolled) {
      try {
        await this.#accounts.credentials(identity);
      } catch (error) {
        return this.#fail(agent.id, error, record, 'Perpl account open, but its API key');
      }
      await record({
        status: 'enrolled',
        message: `Enrolled the agent's Perpl API key for account ${accountId}`,
        accountId: accountId.toString(),
      });
    }

    this.#failures.delete(agent.id);
    this.#lastRecorded.delete(agent.id);
    const info = await this.#chain.account(agent.address).catch(() => null);
    const status: PerplOnboardingStatus = {
      state: 'ready',
      accountId,
      collateralAtoms: info?.balance ?? (plan.kind === 'open' ? plan.amount : 0n),
    };
    this.#cache.set(agent.id, { at: this.#now(), status });
    this.#logger?.log(`agent ${agent.id}: Perpl account ${accountId} ready (${trigger})`);
    return status;
  }

  /** Refuses, before anything is signed, legs the agent's MON cannot pay for. */
  async #gasGate(agent: AgentRecord, plan: PerplOnboardingPlan): Promise<void> {
    const [have, fee] = await Promise.all([
      this.#chain.nativeBalance(agent.address),
      this.#chain.maxFeePerGas(),
    ]);
    const need = plan.gas * fee;
    if (have < need) throw new GasShortfallError(need, have, plan);
  }

  async #fail(
    agentId: string,
    error: unknown,
    record: (detail: Omit<OnboardingEventDetail, 'venue' | 'trigger'>) => Promise<void>,
    lead = 'Couldn’t open the Perpl account',
  ): Promise<PerplOnboardingStatus> {
    const retryAt = this.#now() + this.#retryMs;
    let status: PerplOnboardingStatus & { readonly retryAt: number };
    let detail: Omit<OnboardingEventDetail, 'venue' | 'trigger'>;
    if (error instanceof GasShortfallError) {
      const message =
        `${lead}: the agent needs ${formatEther(error.need)} MON for gas ` +
        `(${error.plan.steps.join(', ')}) and holds ${formatEther(error.have)} MON. ` +
        'Fund it with MON.';
      status = { state: 'needs_gas', needWei: error.need, haveWei: error.have, message, retryAt };
      detail = {
        status: 'needs_gas',
        message,
        steps: error.plan.steps,
        needWei: error.need.toString(),
        haveWei: error.have.toString(),
      };
    } else {
      const message = `${lead}: ${describe(error)}`;
      status = { state: 'failed', message, retryAt };
      detail = {
        status: 'failed',
        message,
        ...(error instanceof PerplOnboardingError
          ? { step: error.step, txHash: error.transactionHash }
          : {}),
      };
    }
    this.#failures.set(agentId, status);
    this.#logger?.warn(`agent ${agentId}: ${detail.message}`);
    // The same failure again (a retry loop, a polling screen) is one Ledger row.
    const key = `${detail.status}:${detail.message}`;
    if (this.#lastRecorded.get(agentId) !== key) {
      this.#lastRecorded.set(agentId, key);
      await record(detail);
    }
    return status;
  }

  async #forwardingKnown(agentId: string): Promise<boolean> {
    if (this.#forwarding.has(agentId)) return true;
    const events = await this.#events.list(agentId, { kind: 'onboarding' });
    const known = events.some((event) => event.detail['forwarding'] === true);
    if (known) this.#forwarding.add(agentId);
    return known;
  }

  /** Appends, and never lets the log decide the outcome (as `tools/gate.ts#record`). */
  async #record(agentId: string, detail: OnboardingEventDetail, runId?: string): Promise<void> {
    try {
      await this.#events.append({
        agentId,
        kind: 'onboarding',
        ...(runId ? { runId } : {}),
        detail: { ...detail },
      });
    } catch (error) {
      this.#logger?.warn(`agent ${agentId}: could not record onboarding: ${messageOf(error)}`);
    }
  }
}

/**
 * The most AUSD one transaction may move into the Exchange: the mandate's
 * per-transaction cap, and the rolling cap's when it is on AUSD.
 */
export function collateralCap(agent: Pick<AgentRecord, 'mandate'>): bigint {
  const { perpl, rollingCap } = agent.mandate;
  let cap = perpl.maxCollateralAtoms;
  if (
    rollingCap &&
    rollingCap.token.toLowerCase() === PERPL_TESTNET_CONTRACTS.collateral.toLowerCase() &&
    rollingCap.capAtoms < cap
  ) {
    cap = rollingCap.capAtoms;
  }
  return cap;
}

class GasShortfallError extends Error {
  readonly need: bigint;
  readonly have: bigint;
  readonly plan: PerplOnboardingPlan;

  constructor(need: bigint, have: bigint, plan: PerplOnboardingPlan) {
    super(`needs ${need} wei of gas, holds ${have}`);
    this.name = 'GasShortfallError';
    this.need = need;
    this.have = have;
    this.plan = plan;
  }
}

function describe(error: unknown): string {
  if (error instanceof EnclaveRefusedError) {
    return (
      'the enclave refused to sign it (policy_violation). The agent’s policy may predate ' +
      'this mandate; amending the mandate re-installs it.'
    );
  }
  return messageOf(error);
}

/** The short message: viem's long one carries the RPC URL, which can hold a key. */
function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'shortMessage' in error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === 'string') return short;
  }
  return error instanceof Error ? error.message : String(error);
}
