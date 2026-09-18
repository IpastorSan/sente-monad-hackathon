/**
 * Tests for `ensureAccount`'s address resolution, against a fake context.
 *
 * The defect these pin: `Account.address` came only from the one-shot
 * registration events, and `config.yaml` starts about seven days back, so an
 * account that registered before the window traded inside it with a null
 * address — and `services/api` matches agents with
 * `where: { address: { _in: […] } }` and drops null-address rows, so it was
 * invisible on the leaderboard forever. `kuru-47` in the live fill of
 * docs/indexer.md §proven is exactly such an account: it appears only as a
 * maker record inside somebody else's `TradesPacked` log.
 *
 * The chain read is faked here (it is an Envio effect, and the effect's own
 * calldata and decoding are pinned against real chain answers in
 * accountAddress.test.ts), so these run with no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureAccount, setAccountAddress, type Ctx } from './common.ts';

/** Only the fields these tests read; the rest of the row is Envio's shape. */
type AccountRow = {
  readonly id: string;
  readonly venue: 'KURU' | 'PERPL';
  readonly accountId: bigint;
  readonly address: string | undefined;
};

type EffectInput = { readonly venue: string; readonly accountId: bigint };

/**
 * A context with an Account table and a scripted chain read. `reads` records
 * every resolution attempt, which is how "one RPC call per account, not per
 * fill" is asserted rather than assumed.
 */
function fakeContext(onChain: Readonly<Record<string, string>>): {
  context: Ctx;
  accounts: Map<string, AccountRow>;
  reads: EffectInput[];
} {
  const accounts = new Map<string, AccountRow>();
  const reads: EffectInput[] = [];
  const context = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    isPreload: false,
    chain: { id: 10143, isRealtime: false },
    effect: async (_effect: unknown, input: EffectInput): Promise<string | null> => {
      reads.push(input);
      return onChain[`${input.venue}-${input.accountId}`] ?? null;
    },
    Account: {
      get: (id: string): Promise<AccountRow | undefined> => Promise.resolve(accounts.get(id)),
      getOrThrow: (id: string): Promise<AccountRow> => {
        const row = accounts.get(id);
        if (row === undefined) throw new Error(`no account ${id}`);
        return Promise.resolve(row);
      },
      getWhere: (): Promise<AccountRow[]> => Promise.resolve([]),
      set: (row: AccountRow): void => {
        accounts.set(row.id, row);
      },
    },
  };
  return { context: context as unknown as Ctx, accounts, reads };
}

const MAKER = '0x74443181214751970a785f5675bd372735245c9e';

test('an account that never registered inside the window still gets its address', async () => {
  const { context, accounts, reads } = fakeContext({ 'KURU-47': MAKER });

  await ensureAccount(context, 'kuru-47', 'KURU', 47n, 61_406_913, 1_757_500_000);

  assert.equal(accounts.get('kuru-47')?.address, MAKER);
  assert.deepEqual(reads, [{ venue: 'KURU', accountId: 47n }]);
});

test('the address is read once per account, not once per fill', async () => {
  const { context, reads } = fakeContext({ 'KURU-47': MAKER });

  for (let i = 0; i < 5; i += 1) {
    await ensureAccount(context, 'kuru-47', 'KURU', 47n, 61_406_913 + i, 1_757_500_000);
  }

  assert.equal(reads.length, 1);
});

test('an id the venue does not know stays address-less, never the zero address', async () => {
  const { context, accounts, reads } = fakeContext({});

  await ensureAccount(context, 'perpl-9999', 'PERPL', 9_999n, 63_311_165, 1_757_600_000);

  const row = accounts.get('perpl-9999');
  assert.notEqual(row, undefined);
  assert.equal(row?.address, undefined);
  assert.deepEqual(reads, [{ venue: 'PERPL', accountId: 9_999n }]);
});

test('the registration event still writes the address it carries', async () => {
  // AccountRegistered remains the authority when it IS inside the window: the
  // read is a backfill, not a replacement.
  const { context, accounts } = fakeContext({});
  await ensureAccount(context, 'kuru-62', 'KURU', 62n, 61_406_913, 1_757_500_000);
  assert.equal(accounts.get('kuru-62')?.address, undefined);

  await setAccountAddress(context, 'kuru-62', '0x15BBC549326Dd8D053233C3A546Aa7fDaBB57256');

  assert.equal(accounts.get('kuru-62')?.address, '0x15bbc549326dd8d053233c3a546aa7fdabb57256');
});
