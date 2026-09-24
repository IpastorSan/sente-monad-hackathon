/**
 * ---------------------------------------------------------------------------
 * GETTING THE MONEY BACK OUT (SEN-17)
 *
 * `POST /agents/:id/return` — the owner asks, and the agent's own wallet sends
 * its funds home. Two legs per asset, in this order and never the other way
 * round:
 *
 * 1. `AccountCore.withdraw`, which pays the caller, so Kuru collateral lands in
 *    the agent's own wallet. There is no recipient parameter to get wrong.
 * 2. An ERC-20 `transfer` to `mandate.returnTo` — the owner's Privy wallet,
 *    resolved server-side at hire (`return-address.ts`).
 *
 * Both are the RECOVERY rules of the compiled mandate (SEN-15), so both are
 * signed by the agent's own enclave key and neither needs the owner's signature:
 * the policy already says the money may only move toward the owner, and the
 * enclave enforces it whatever this server asks for. That is why this route is
 * server-driven and not a prepare/commit pair — there is nothing here the owner
 * could usefully approve that the policy does not already pin.
 *
 * It works on a REVOKED agent, which is the point: recovery rules carry no
 * expiry and a revoke leaves them in place (`compileRevocationRules`). An agent
 * that has stopped, or whose mandate has lapsed, can still be emptied.
 *
 * WHAT IT CANNOT DO: move native MON. No rule allows a value transfer, because
 * one to `returnTo` would also let the agent call the owner's account with any
 * calldata, so an agent's leftover gas stays with the agent.
 * ---------------------------------------------------------------------------
 */
import { Inject, Injectable, Logger, type Provider } from '@nestjs/common';
import { returnableTokens } from '@sente/mandate';
import type { Decimal } from '@sente/venues';
import {
  erc20TransferCall,
  fromUnits,
  KURU_ACCOUNT_CORE_BALANCE_ABI,
  KURU_MEASURED_GAS,
  KURU_TESTNET_CONTRACTS,
  KURU_TESTNET_TOKENS,
  toUnits,
} from '@sente/venues/kuru';
import { PERPL_COLLATERAL_DECIMALS } from '@sente/venues/perpl';
import {
  erc20Abi,
  formatEther,
  getAddress,
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import type { Principal } from '../../auth/principal';
import { AgentsService } from '../agents.service';
import { AgentRefusedError } from '../agents.errors';
import type { AgentRecord } from '../store/agent-store';
import { KeyedMutex } from '../tools/keyed-mutex';
import { AgentTransactionSender, type AgentIdentity } from '../venues/agent-transactions';
import { AgentVenues } from '../venues/agent-venues';
import { AGENT_PUBLIC_CLIENT } from '../venues/agent-venues.providers';

/** `POST /agents/:id/return`. Both fields optional: no body means "everything". */
export interface ReturnFundsCommand {
  /**
   * One token symbol, e.g. `USDC`. Omitted, every asset an agent wallet can
   * hold is swept — the honest reading of "give me my money back".
   */
  asset?: string;
  /** Human units, e.g. `1.5`. Only meaningful with `asset`; omitted means all of it. */
  amount?: string;
}

/** What happened to one asset. Every amount is human units, never atoms. */
export interface ReturnedAsset {
  asset: string;
  /** The Kuru collateral leg, when the agent had free collateral in AccountCore. */
  withdrawn?: { amount: string; transactionHash: Hex; success: boolean };
  /** The transfer leg: what actually left for the owner. */
  returned?: { amount: string; transactionHash: Hex; success: boolean };
  /** Why nothing moved. Present exactly when both legs are absent. */
  skipped?: string;
}

export interface ReturnOutcome {
  agentId: string;
  /** Where it went: the owner's wallet, as the enclave policy pins it. */
  returnTo: Address;
  /** One entry per asset considered, in the order they were handled. */
  assets: ReturnedAsset[];
  /** MON the agent paid for the whole thing, as a decimal string. */
  monSpent: string;
}

/**
 * The chain reads a return needs, as four functions rather than a viem client,
 * so a spec fakes four lines (the shape `AgentChainClient` uses).
 *
 * `collateral` reads ONE token's free balance out of AccountCore rather than
 * going through `KuruVenue.getBalances`, which reads two functions for every
 * token Kuru lists. Monad's public RPC refuses more than 15 requests a second,
 * and a sweep of five assets plus a ten-call balance read is over that line.
 */
export interface ReturnChainReader {
  monBalance(address: Address): Promise<bigint>;
  tokenBalance(token: Address, holder: Address): Promise<bigint>;
  /** Free Kuru collateral: what `AccountCore.withdraw` could pay out now. */
  collateral(token: Address, holder: Address): Promise<bigint>;
  maxFeePerGas(): Promise<bigint>;
}

export function returnChainReader(client: PublicClient): ReturnChainReader {
  return {
    monBalance: (address) => client.getBalance({ address }),
    tokenBalance: (token, holder) =>
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [holder],
      }),
    collateral: (token, holder) =>
      client.readContract({
        address: KURU_TESTNET_CONTRACTS.accountCore,
        abi: KURU_ACCOUNT_CORE_BALANCE_ABI,
        functionName: 'getBalance',
        args: [holder, token],
      }) as Promise<bigint>,
    maxFeePerGas: async () => {
      const fees = await client.estimateFeesPerGas();
      if (fees.maxFeePerGas === undefined) throw new Error('the RPC returned no EIP-1559 fees');
      return fees.maxFeePerGas;
    },
  };
}

/** DI token for {@link ReturnChainReader}. */
export const RETURN_CHAIN = Symbol('RETURN_CHAIN');

/** The slice of the agent's Kuru venue this needs: taking its collateral back. */
export interface ReturnKuruVenue {
  withdraw(asset: string, amount: Decimal): Promise<{ transactionHash: Hex; success: boolean }>;
}

/** The slice of {@link AgentVenues} this needs. */
export interface ReturnVenues {
  forAgent(agent: AgentIdentity): Promise<{ kuru: ReturnKuruVenue }>;
}

/** The slice of {@link AgentTransactionSender} this needs. */
export type ReturnSender = Pick<AgentTransactionSender, 'sendAll'>;

/** The slice of {@link AgentsService} this needs: ownership, and nothing else. */
export type ReturnAgents = Pick<AgentsService, 'get'>;

/** An ERC-20 the compiled mandate has a return rule for, with what it takes to move it. */
interface ReturnableAsset {
  symbol: string;
  address: Address;
  decimals: number;
  /** Whether Kuru's AccountCore can hold it, and so whether a withdraw leg exists. */
  kuru: boolean;
}

/**
 * The assets a return walks, read off the mandate compiler's own list so the
 * route and the policy rules can never disagree about what is returnable.
 */
export function returnableAssets(): ReturnableAsset[] {
  return returnableTokens().map((token) => {
    const kuru = Object.values(KURU_TESTNET_TOKENS).find((t) =>
      isAddressEqual(t.address, token.address),
    );
    return {
      symbol: token.symbol,
      address: getAddress(token.address),
      decimals: kuru?.decimals ?? PERPL_COLLATERAL_DECIMALS,
      kuru: kuru !== undefined,
    };
  });
}

/** One asset's plan: how much to pull off Kuru, and how much to send home. */
interface AssetPlan {
  asset: ReturnableAsset;
  withdrawAtoms: bigint;
  transferAtoms: bigint;
}

@Injectable()
export class ReturnFundsService {
  private readonly logger = new Logger(ReturnFundsService.name);
  /**
   * One return at a time per agent. Two concurrent returns would both read the
   * same balance and plan the same transfer, and the second would revert on
   * chain — having been charged its gas limit anyway (gotcha 4).
   */
  private readonly locks = new KeyedMutex();

  constructor(
    @Inject(AgentsService) private readonly agents: ReturnAgents,
    @Inject(AgentVenues) private readonly venues: ReturnVenues,
    @Inject(AgentTransactionSender) private readonly sender: ReturnSender,
    @Inject(RETURN_CHAIN) private readonly chain: ReturnChainReader,
  ) {}

  /**
   * Sends an agent's funds to its owner and reports what moved.
   *
   * Nothing here is all-or-nothing, and it must not pretend to be: an agent
   * wallet is a plain EOA, so each leg is its own transaction (gotcha 8's
   * corollary), and a withdraw that landed stays landed even if the transfer
   * after it fails. So every leg reports its own hash and success flag, and the
   * balance is re-read between the two rather than assumed.
   */
  returnFunds(
    principal: Principal,
    agentId: string,
    command: ReturnFundsCommand = {},
  ): Promise<ReturnOutcome> {
    return this.locks.run(agentId, async () => {
      const agent = await this.agents.get(principal, agentId);
      const returnTo = this.exitOrRefuse(agent);
      const assets = this.assetsOrRefuse(command.asset);
      const limit = this.amountOrRefuse(command, assets);

      const identity: AgentIdentity = {
        agentId: agent.id,
        walletId: agent.walletId,
        address: agent.address,
      };
      const plans = await this.plan(agent, assets, limit);
      const monBefore = await this.gasGate(agent, plans);

      // The venue set is only built once something is actually going to be
      // withdrawn: `forAgent` opens (and caches) an agent's venues, and a return
      // that has nothing to take off Kuru has no business doing that.
      const kuru = plans.some((plan) => plan.withdrawAtoms > 0n)
        ? (await this.venues.forAgent(identity)).kuru
        : undefined;
      const results: ReturnedAsset[] = [];
      for (const plan of plans) {
        results.push(await this.move(agent, identity, returnTo, plan, kuru));
      }
      const monAfter = await this.chain.monBalance(agent.address);
      const monSpent = formatEther(monBefore > monAfter ? monBefore - monAfter : 0n);
      this.logger.log(
        `returned funds from agent ${agent.id} to ${returnTo}: ` +
          `${results.map((r) => `${r.returned?.amount ?? '0'} ${r.asset}`).join(', ') || 'nothing'}` +
          ` (${monSpent} MON of the agent's gas)`,
      );
      return { agentId: agent.id, returnTo, assets: results, monSpent };
    });
  }

  /**
   * The one address the agent's policy lets it pay. Absent means the mandate has
   * no transfer rule at all, so the enclave would refuse every transfer — better
   * said here than as a `policy_violation` after the withdraw already spent gas.
   */
  private exitOrRefuse(agent: AgentRecord): Address {
    const returnTo = agent.mandate.returnTo;
    if (returnTo) return returnTo;
    throw new AgentRefusedError(
      'return_address_missing',
      `agent ${agent.id}'s mandate names no returnTo, so its wallet has no transfer rule and the ` +
        'enclave would refuse to send anything' +
        (agent.status === 'active'
          ? '; amend its mandate, which now always carries your wallet, and try again'
          : '; it was hired before return-to-owner existed and is revoked, so only the policy ' +
            'owner key can re-arm it by hand'),
    );
  }

  /** Every returnable asset, or the one that was named. */
  private assetsOrRefuse(asset: string | undefined): ReturnableAsset[] {
    const all = returnableAssets();
    if (asset === undefined) return all;
    const wanted = asset.trim().toUpperCase();
    const found = all.find((a) => a.symbol.toUpperCase() === wanted);
    if (!found) {
      throw new AgentRefusedError(
        'return_asset_not_supported',
        `${asset} is not an asset an agent wallet can return; choose one of ` +
          `${all.map((a) => a.symbol).join(', ')}`,
      );
    }
    return [found];
  }

  /** `amount` in atoms of the single named asset, or `undefined` for "everything". */
  private amountOrRefuse(
    command: ReturnFundsCommand,
    assets: ReturnableAsset[],
  ): bigint | undefined {
    if (command.amount === undefined) return undefined;
    const asset = assets.length === 1 ? assets[0] : undefined;
    if (!asset) {
      throw new AgentRefusedError(
        'return_amount_invalid',
        'amount only means something for one asset: name the asset too, or omit both and send ' +
          'everything home',
      );
    }
    const raw = command.amount.trim();
    if (!/^\d+(\.\d+)?$/.test(raw)) {
      throw new AgentRefusedError(
        'return_amount_invalid',
        `amount must be a positive decimal in ${asset.symbol} units, got ` +
          `${JSON.stringify(command.amount)}`,
      );
    }
    let atoms: bigint;
    try {
      atoms = toUnits(raw, asset.decimals, 'amount');
    } catch (error) {
      throw new AgentRefusedError(
        'return_amount_invalid',
        error instanceof Error ? error.message : `amount is not a ${asset.symbol} amount`,
      );
    }
    if (atoms <= 0n) {
      throw new AgentRefusedError('return_amount_invalid', 'amount must be above zero');
    }
    return atoms;
  }

  /**
   * What each asset would move, read off the chain before anything is signed.
   *
   * Reserved Kuru collateral is deliberately left alone: `AccountCore.getBalance`
   * reports the FREE balance, and what a resting order has reserved is not in it.
   * AccountCore would refuse to withdraw that anyway, and cancelling those orders
   * is the agent's job, not this route's.
   */
  private async plan(
    agent: AgentRecord,
    assets: ReturnableAsset[],
    limit: bigint | undefined,
  ): Promise<AssetPlan[]> {
    const plans: AssetPlan[] = [];
    for (const asset of assets) {
      // Sequential, not `Promise.all`: two reads per asset for five assets is a
      // dozen requests, and the public RPC's 15-a-second ceiling is not far off.
      const free = asset.kuru ? await this.chain.collateral(asset.address, agent.address) : 0n;
      const held = await this.chain.tokenBalance(asset.address, agent.address);
      const budget = limit ?? free + held;
      // Only what the wallet cannot cover is pulled off the venue: a withdraw is
      // a whole transaction, and on Monad an unnecessary one is charged in full
      // at its limit (gotcha 4). With no `amount` the budget is everything, so
      // this is the entire free collateral, as it should be.
      const withdrawAtoms = min(free, budget > held ? budget - held : 0n);
      plans.push({ asset, withdrawAtoms, transferAtoms: min(held + withdrawAtoms, budget) });
    }
    return plans;
  }

  /**
   * Refuses before signing anything when the agent cannot pay for the legs it
   * would take, naming the shortfall and the command that fixes it.
   *
   * Monad charges the gas LIMIT (gotcha 4), so the budget is the measured limits
   * of the legs planned, not an estimate of what they will use. Returns the MON
   * balance it read, which is also the "before" of `monSpent`.
   */
  private async gasGate(agent: AgentRecord, plans: AssetPlan[]): Promise<bigint> {
    const gas = plans.reduce(
      (total, plan) =>
        total +
        (plan.withdrawAtoms > 0n ? KURU_MEASURED_GAS.withdraw : 0n) +
        (plan.transferAtoms > 0n ? KURU_MEASURED_GAS.erc20Transfer : 0n),
      0n,
    );
    const mon = await this.chain.monBalance(agent.address);
    if (gas === 0n) return mon;
    const need = gas * (await this.chain.maxFeePerGas());
    if (mon >= need) return mon;
    throw new AgentRefusedError(
      'return_gas_insufficient',
      `agent ${agent.id} holds ${formatEther(mon)} MON and needs ${formatEther(need)} to send ` +
        `its funds home (${gas} gas, charged at the limit on Monad); fund it with ` +
        `\`pnpm --filter @sente/api run agent:fund -- --to ${agent.address} --mon ` +
        `${formatEther(need - mon)}\` and try again`,
    );
  }

  /** One asset: withdraw, re-read, transfer. */
  private async move(
    agent: AgentRecord,
    identity: AgentIdentity,
    returnTo: Address,
    plan: AssetPlan,
    kuru: ReturnKuruVenue | undefined,
  ): Promise<ReturnedAsset> {
    const { asset } = plan;
    const result: ReturnedAsset = { asset: asset.symbol };
    if (plan.withdrawAtoms === 0n && plan.transferAtoms === 0n) {
      return { ...result, skipped: `the agent holds no ${asset.symbol}` };
    }

    if (plan.withdrawAtoms > 0n && kuru) {
      const amount = fromUnits(plan.withdrawAtoms, asset.decimals);
      const execution = await kuru.withdraw(asset.symbol, amount);
      result.withdrawn = {
        amount,
        transactionHash: execution.transactionHash,
        success: execution.success,
      };
    }

    // Re-read rather than add: a withdraw that reverted is still a transaction,
    // and transferring what it did not deliver would revert too, at full price.
    const held = await this.chain.tokenBalance(asset.address, agent.address);
    const send = min(held, plan.transferAtoms);
    if (send === 0n) {
      return {
        ...result,
        skipped: `the agent's wallet holds no ${asset.symbol} to send${
          result.withdrawn ? ' after the withdraw' : ''
        }`,
      };
    }
    const [receipt] = await this.sender.sendAll(identity, [
      { ...erc20TransferCall(asset.address, returnTo, send), gas: KURU_MEASURED_GAS.erc20Transfer },
    ]);
    if (!receipt) return { ...result, skipped: 'the transfer was not broadcast' };
    return {
      ...result,
      returned: {
        amount: fromUnits(send, asset.decimals),
        transactionHash: receipt.transactionHash,
        success: receipt.success,
      },
    };
  }
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Nest wiring, kept beside the service like `agent-venues.providers.ts`. */
export const returnFundsProviders: Provider[] = [
  {
    provide: RETURN_CHAIN,
    inject: [AGENT_PUBLIC_CLIENT],
    useFactory: (client: PublicClient): ReturnChainReader => returnChainReader(client),
  },
  ReturnFundsService,
];
