/**
 * The addresses an `AccountRegistered` names, on either Kuru deployment
 * (SEN-189). The handler is the same code for `config.yaml` and
 * `config.setc.yaml`, but the event's shape is not:
 *
 * - Set D: `AccountRegistered(uint40 indexed accountId, uint40 indexed
 *   rootAccountId, address indexed rootOwner, uint16 subaccountSeq)` — an id
 *   has no address of its own; a root and its children all belong to
 *   `rootOwner`, the wallet that signs and the one a Sente user is matched on
 *   (the same answer `getAccountOwner(id)` gives, lib/accountAddress.ts).
 * - Set C: `AccountRegistered(address indexed account, uint40 indexed
 *   accountId, uint40 indexed rootAccountId, address owner, uint16
 *   subaccountSeq)` — `account` holds the id and trades; `owner` is a separate
 *   field. Both are stored; neither is inferred from the other.
 */
export function registeredAddresses(params: {
  readonly rootOwner?: string;
  readonly account?: string;
  readonly owner?: string;
}): { address: string | undefined; owner: string | undefined } {
  if (params.rootOwner !== undefined) return { address: params.rootOwner, owner: params.rootOwner };
  return { address: params.account, owner: params.owner };
}
