import { getAddress, type Address } from 'viem';

import type {
  EnclaveApproval,
  EnclaveRequest,
  PreparedEnclaveRequest,
} from '../agents/agent-wallet.provider';
import { createUserWallet } from '../agents/privy/user-wallet';
import type { PrivyClient } from '../agents/privy/privy.client';
import {
  readSendResponse,
  sponsoredSendBody,
  walletRpcPath,
  type SponsoredSendOutcome,
} from './send/sponsored-send';
import { WalletRefusedError } from './wallet.errors';

/** DI token for whatever provisions the user's wallet. */
export const USER_WALLETS = Symbol('USER_WALLETS');

export interface ProvisionUserWalletInput {
  /** base64 SPKI DER of the phone's `device` P-256 key. Becomes the OWNER. */
  devicePublicKey: string;
  displayName: string;
}

export interface ProvisionedUserWallet {
  walletId: string;
  address: Address;
  ownerQuorumId: string;
}

export interface PrepareSendInput {
  walletId: string;
  /** Privy's `params.transaction` — `send/sponsored-send.ts` builds it. */
  transaction: Record<string, unknown>;
}

/**
 * Provisioning and the two halves of a send — and still no `sign`, which is the
 * design (see `agents/privy/user-wallet.ts`). The server creates the wallet, can
 * COMPOSE a send for it, and can never authorise one: the owner key is on the
 * phone, and Privy checks the owner's signature on its side.
 *
 * `prepareSend` and `commitSend` keep that true in the shape SEN-44 settled on
 * for mandates. `prepareSend` reaches nothing — a prepare that hit Privy would
 * be a transfer without an approval, which is the one thing this pair exists to
 * prevent — and `commitSend` sends the STORED request rather than rebuilding it,
 * because the signature covers its bytes and a second composition is a second
 * chance for the approved request and the sent one to differ.
 */
export interface UserWalletProvider {
  readonly name: string;
  provision(input: ProvisionUserWalletInput): Promise<ProvisionedUserWallet>;

  /** The `eth_sendTransaction` that would move the funds, and what its owner signs. */
  prepareSend(input: PrepareSendInput): Promise<PreparedEnclaveRequest>;

  /**
   * Sends a prepared transfer with the phone's signature attached.
   *
   * Unlike `AgentWalletProvider.commitPrepared`, this answers with what came
   * back: a sponsored send returns a USER OPERATION hash (gotcha 8), and the
   * caller needs it to read the right receipt.
   */
  commitSend(request: EnclaveRequest, approval: EnclaveApproval): Promise<SponsoredSendOutcome>;
}

/** Privy server wallets, owned by a 1-key quorum holding the device key. */
export class PrivyUserWalletProvider implements UserWalletProvider {
  readonly name = 'privy';
  readonly #client: PrivyClient;

  constructor(client: PrivyClient) {
    this.#client = client;
  }

  async provision(input: ProvisionUserWalletInput): Promise<ProvisionedUserWallet> {
    const { wallet, ownerQuorumId } = await createUserWallet(this.#client, input);
    // Privy's casing is its own; every address that leaves this API is EIP-55.
    return { walletId: wallet.id, address: getAddress(wallet.address), ownerQuorumId };
  }

  prepareSend(input: PrepareSendInput): Promise<PreparedEnclaveRequest> {
    const path = walletRpcPath(input.walletId);
    const body = sponsoredSendBody(input.transaction);
    return Promise.resolve({
      // `subject` is the wallet, not a policy: this request spends, it does not
      // re-bound anything. Carried so a refusal can name what it was about.
      request: { method: 'POST', path, body, subject: input.walletId },
      // Built by the same client that will send it, so the two cannot drift.
      payload: this.#client.authorizationPayload('POST', path, body),
    });
  }

  async commitSend(
    request: EnclaveRequest,
    approval: EnclaveApproval,
  ): Promise<SponsoredSendOutcome> {
    const response = await this.#client.request<unknown>(
      request.method,
      request.path,
      request.body,
      // The phone's signature, forwarded verbatim and alone. There is no
      // `approvals` key here and there must never be one: a server key on this
      // request would be a server that can spend the user's funds.
      { signatures: [approval.signature] },
    );
    return readSendResponse(response);
  }
}

/**
 * What the API binds when Privy is not configured, so it still boots — the same
 * call `paymaster/` and `agents/` make. Refusing loudly beats a module that
 * silently is not there.
 */
export class UnconfiguredUserWalletProvider implements UserWalletProvider {
  readonly name = 'unconfigured';

  provision(): Promise<ProvisionedUserWallet> {
    return Promise.reject(this.#unconfigured('no user wallet can be created'));
  }

  prepareSend(): Promise<PreparedEnclaveRequest> {
    return Promise.reject(this.#unconfigured('no send can be prepared'));
  }

  commitSend(): Promise<SponsoredSendOutcome> {
    return Promise.reject(this.#unconfigured('no send can be submitted'));
  }

  #unconfigured(what: string): WalletRefusedError {
    return new WalletRefusedError(
      'user_wallets_unconfigured',
      `Privy is not configured, so ${what}. Set PRIVY_APP_ID and PRIVY_APP_SECRET.`,
    );
  }
}
