import type { AuthorizationPayload } from '@sente/mandate';

import type { EnclaveRequest } from './agent-wallet.provider';
import {
  PREPARED_APPROVAL_TTL_MS,
  PreparedApprovals,
  type PreparedApproval,
  type PreparedApprovalKind,
} from './prepared-approval';

/** A fixed clock: every expiry below is exact, never "roughly five minutes". */
const T0 = new Date('2026-09-27T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function approval(
  over: Partial<Pick<PreparedApproval<null>, 'id' | 'userId' | 'subject' | 'createdAt'>> & {
    kind?: PreparedApprovalKind;
  } = {},
): PreparedApproval<null> {
  const createdAt = over.createdAt ?? T0;
  return {
    id: over.id ?? 'prep-1',
    kind: over.kind ?? 'mandate_amend',
    userId: over.userId ?? 'alice',
    subject: over.subject ?? 'agent-a',
    // The store never looks inside these; it only hands them back.
    request: { method: 'PATCH', path: '/v1/policies/p', body: {} } as unknown as EnclaveRequest,
    payload: {} as AuthorizationPayload,
    context: null,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + PREPARED_APPROVAL_TTL_MS),
  };
}

describe('PreparedApprovals (SEN-44, SEN-130)', () => {
  // SEN-130: the audit found `take` tested only at expiresAt + 1, so `<=` → `<`
  // survived. Consent given at T0 is not consent at T0 + TTL.
  it('expires at exactly expiresAt, and not a millisecond before', () => {
    const early = new PreparedApprovals<null>();
    early.put(approval());
    expect(early.take('prep-1', 'alice', at(PREPARED_APPROVAL_TTL_MS - 1))?.id).toBe('prep-1');

    const exact = new PreparedApprovals<null>();
    exact.put(approval());
    expect(exact.take('prep-1', 'alice', at(PREPARED_APPROVAL_TTL_MS))).toBeUndefined();
  });

  it('spends an expired prepare too: it cannot come back with a later clock', () => {
    const store = new PreparedApprovals<null>();
    store.put(approval());
    expect(store.take('prep-1', 'alice', at(PREPARED_APPROVAL_TTL_MS))).toBeUndefined();
    expect(store.take('prep-1', 'alice', T0)).toBeUndefined();
  });

  it('is single-use', () => {
    const store = new PreparedApprovals<null>();
    store.put(approval());
    expect(store.take('prep-1', 'alice', T0)?.id).toBe('prep-1');
    expect(store.take('prep-1', 'alice', T0)).toBeUndefined();
  });

  it('hides another user’s prepare, and a wrong-user guess does not spend it', () => {
    const store = new PreparedApprovals<null>();
    store.put(approval());
    expect(store.take('prep-1', 'bob', T0)).toBeUndefined();
    expect(store.take('prep-1', 'alice', T0)?.id).toBe('prep-1');
  });

  it('keeps one live prepare per user and subject, whatever its kind', () => {
    const store = new PreparedApprovals<null>();
    store.put(approval({ id: 'amend' }));
    // A revoke prepared on the same agent drops the amend: this is what keeps an
    // amend signed before a revocation from being committed after it (SEN-130).
    store.put(approval({ id: 'revoke', kind: 'mandate_revoke' }));
    expect(store.take('amend', 'alice', T0)).toBeUndefined();
    expect(store.take('revoke', 'alice', T0)?.kind).toBe('mandate_revoke');
  });

  it('keeps prepares for different subjects, or different users, side by side', () => {
    const store = new PreparedApprovals<null>();
    store.put(approval({ id: 'on-a', subject: 'agent-a' }));
    store.put(approval({ id: 'on-b', subject: 'agent-b' }));
    store.put(approval({ id: 'bobs-a', userId: 'bob', subject: 'agent-a' }));
    // Each comes back as prepared, subject intact: the subject is what the
    // commit route compares against the agent it was asked to change.
    expect(store.take('on-a', 'alice', T0)?.subject).toBe('agent-a');
    expect(store.take('on-b', 'alice', T0)?.subject).toBe('agent-b');
    expect(store.take('bobs-a', 'bob', T0)?.subject).toBe('agent-a');
  });

  it('sweeps what has expired when something new is put', () => {
    const store = new PreparedApprovals<null>();
    store.put(approval({ id: 'old', subject: 'agent-a' }));
    store.put(approval({ id: 'new', subject: 'agent-b', createdAt: at(PREPARED_APPROVAL_TTL_MS) }));
    // Even a clock that runs backwards cannot find the swept entry.
    expect(store.take('old', 'alice', T0)).toBeUndefined();
    expect(store.take('new', 'alice', at(PREPARED_APPROVAL_TTL_MS))?.id).toBe('new');
  });
});
