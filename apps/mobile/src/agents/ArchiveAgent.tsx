/**
 * Archive a stopped agent from its page (SEN-197), or bring an archived one
 * back. Sits under the revoked or mandate-expired notice. Archiving is soft: it only takes the
 * agent off the owner's lists, so the sheet says plainly that nothing on chain
 * goes away. While funds remain, the sheet turns into "Return funds first" and
 * hands over to the page's own return sheet.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AgentsApiError, describeAgentsError, describeFundsLeft } from '@/agents/api';
import type { Agent, AgentFundsLeft, AgentPortfolioDto } from '@/agents/api';
import { fundsLeftOf, perplCollateralOf } from '@/agents/archive';
import { useSession } from '@/session';
import { isoDate } from '@/ui/format';
import { Button, Notice, Sheet, type NoticeTone } from '@/ui/kit';
import { text } from '@/ui/theme';

type Outcome = { tone: NoticeTone; title: string; detail?: string };

export function ArchiveAgent({
  agent,
  portfolio,
  onReturn,
  onDone,
}: {
  agent: Agent;
  portfolio: AgentPortfolioDto | null | undefined;
  /** Opens the page's return sheet. */
  onReturn: () => void;
  onDone: (outcome: Outcome) => void;
}) {
  const { agents: api } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Outcome | null>(null);
  // What the server said is left, when it refused; it outranks our own read.
  const [refusedLeft, setRefusedLeft] = useState<AgentFundsLeft[] | null>(null);

  if (!api) return null;

  if (agent.archivedAt) {
    const unarchive = async () => {
      setBusy(true);
      try {
        await api.unarchive(agent.id);
        onDone({ tone: 'ok', title: `${agent.name} is back on your agents list` });
      } catch (caught) {
        onDone({ tone: 'error', ...describeAgentsError(caught) });
      } finally {
        setBusy(false);
      }
    };
    return (
      <View style={styles.row}>
        <Text style={[text.caption, styles.grow]}>
          Archived {isoDate(agent.archivedAt)}. Hidden from your lists.
        </Text>
        <Button label="Unarchive" size="sm" busy={busy} onPress={() => void unarchive()} />
      </View>
    );
  }

  const left = refusedLeft ?? fundsLeftOf(portfolio);
  const holding = left !== null && left.length > 0;
  // No return can withdraw from Perpl, so its collateral does not block an
  // archive (SEN-203); the sheet says where it stays.
  const perplKept = perplCollateralOf(portfolio);
  const perplNote =
    perplKept.length > 0 ? (
      <Text style={[text.caption, styles.after]}>
        {`${perplKept.map((f) => `${f.amount} ${f.asset}`).join(', ')} stays in the agent’s Perpl account. Sente cannot withdraw from Perpl, so Return funds does not move it and archiving leaves it there.`}
      </Text>
    ) : null;

  const archive = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.archive(agent.id);
      setOpen(false);
      onDone({
        tone: 'ok',
        title: `${agent.name} is archived`,
        detail: 'Find it under Agents → Yours → Archived.',
      });
    } catch (caught) {
      if (caught instanceof AgentsApiError && caught.reason === 'agent_has_funds') {
        setRefusedLeft(caught.left ?? []);
      } else {
        setError({ tone: 'error', ...describeAgentsError(caught) });
      }
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setOpen(false);
    setError(null);
    setRefusedLeft(null);
  };

  return (
    <>
      <View style={styles.row}>
        <Text style={[text.caption, styles.grow]}>
          Done with it? Archive it to take it off your lists.
        </Text>
        <Button label="Archive agent" size="sm" onPress={() => setOpen(true)} />
      </View>
      <Sheet
        visible={open}
        title={holding ? 'Return funds first' : `Archive ${agent.name}?`}
        onClose={close}
      >
        {holding ? (
          <>
            <Text style={text.body}>
              {left.length > 0
                ? `It still holds ${describeFundsLeft(left)}. Send it home, then archive the agent.`
                : 'It still holds funds. Send them home, then archive the agent.'}
            </Text>
            {perplNote}
            <Button
              label="Return funds"
              kind="primary"
              icon="return"
              onPress={() => {
                close();
                onReturn();
              }}
              style={styles.action}
            />
          </>
        ) : (
          <>
            <Text style={text.body}>
              {agent.name} leaves your agents list, the home screen and the leaderboard.
            </Text>
            <Text style={[text.caption, styles.after]}>
              Nothing on chain is deleted. Its wallet, its on-chain identity and its trade history
              stay as they are, and its public page keeps working. You can unarchive it any time
              from Agents → Yours → Archived.
            </Text>
            {perplNote}
            {error ? <Notice tone={error.tone} title={error.title} detail={error.detail} /> : null}
            <Button
              label="Archive agent"
              kind="primary"
              busy={busy}
              onPress={() => void archive()}
              style={styles.action}
            />
          </>
        )}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  grow: { flex: 1 },
  after: { marginTop: 10 },
  action: { marginTop: 20 },
});
