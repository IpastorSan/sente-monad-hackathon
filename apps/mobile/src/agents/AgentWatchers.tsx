/**
 * The Watchers section of the agent page (SEN-182): the conditions Sente
 * checks for the agent between runs without the model, each read as a
 * sentence, with when it last woke the agent. The owner can remove one, or
 * add and edit the common kinds (price, RSI, MACD cross, P&L) in a sheet;
 * anything richer the agent set can be read and removed, not edited.
 *
 * Each watcher sits on a board point: an empty intersection until it has
 * fired, a stone once it has woken the agent.
 *
 * Reads `GET /agents/:id/watchers` every 30 s while the screen is focused and
 * the app in the foreground. An API without the route renders nothing.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  AgentsApiError,
  describeAgentsError,
  type Agent,
  type AgentWatchersDto,
  type WatcherDto,
} from '@/agents/api';
import {
  bodyOf,
  emptyForm,
  firedLine,
  FORM_COOLDOWNS,
  FORM_KINDS,
  FORM_TIMEFRAMES,
  formOf,
  formOps,
  marketChoices,
  newWatcherId,
  triggerLine,
  watcherParts,
  watchersSummary,
  type WatcherForm,
} from '@/agents/watchers';
import { usePolling } from '@/markets/usePolling';
import { useSession } from '@/session';
import {
  Button,
  ButtonRow,
  Chip,
  Chips,
  Field,
  Notice,
  Section,
  SectionLink,
  Sheet,
} from '@/ui/kit';
import { color, font, text } from '@/ui/theme';

const POLL_MS = 30_000;
const WATCHER_REASONS = new Set(['invalid_input', 'market_not_allowed', 'venue_not_allowed']);

type Problem = { title: string; detail: string };

function describeWatcherError(error: unknown): Problem {
  if (error instanceof AgentsApiError && error.reason && WATCHER_REASONS.has(error.reason)) {
    return { title: 'That watcher wasn’t saved', detail: error.message };
  }
  return describeAgentsError(error);
}

/**
 * The agent's watchers, polled like every other screen section; `null` until
 * read, or when the API has no such route. A save's answer is shown at once
 * and stands until the next poll replaces the data it was saved over.
 */
function useWatchers(agentId: string) {
  const { agents: api } = useSession();
  const polled = usePolling(
    api ? `agent.watchers:${agentId}` : null,
    () => api!.watchers(agentId),
    {
      intervalMs: POLL_MS,
      // The answer carries no server time; it is as fresh as the request.
      asOf: () => Date.now(),
      stale: () => false,
    },
  );
  const [saved, setSaved] = useState<{
    over: AgentWatchersDto | null;
    dto: AgentWatchersDto;
  } | null>(null);
  const dto = saved && saved.over === polled.data ? saved.dto : polled.data;
  const setDto = (next: AgentWatchersDto) => setSaved({ over: polled.data, dto: next });
  return { dto, setDto };
}

export function AgentWatchers({ agent }: { agent: Agent }) {
  const { agents: api } = useSession();
  const { dto, setDto } = useWatchers(agent.id);
  const [editing, setEditing] = useState<WatcherDto | 'new' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const active = agent.status === 'active';

  if (!dto) return null;
  const now = Date.now();

  const remove = async (watcher: WatcherDto) => {
    if (!api || removing) return;
    setRemoving(watcher.id);
    setProblem(null);
    try {
      setDto(await api.deleteWatcher(agent.id, watcher.id));
    } catch (error) {
      setProblem(describeWatcherError(error));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Section
      label="Watchers"
      aside={active ? <SectionLink label="Add" onPress={() => setEditing('new')} /> : undefined}
    >
      <Text style={[text.caption, styles.summary]}>{watchersSummary(dto)}</Text>
      {dto.watchers.map((watcher, i) => (
        <WatcherRow
          key={watcher.id}
          watcher={watcher}
          first={i === 0}
          now={now}
          busy={removing === watcher.id}
          onEdit={active && formOf(watcher) ? () => setEditing(watcher) : undefined}
          onRemove={active ? () => void remove(watcher) : undefined}
        />
      ))}
      {problem ? <Notice tone="error" title={problem.title} detail={problem.detail} /> : null}
      {editing !== null ? (
        <WatcherSheet
          agent={agent}
          existing={dto.watchers}
          watcher={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setDto(next);
            setEditing(null);
          }}
        />
      ) : null}
    </Section>
  );
}

/** An intersection on the board; a stone on it once the watcher has woken the agent. */
function BoardPoint({ fired }: { fired: boolean }) {
  return (
    <View style={styles.point} accessibilityElementsHidden importantForAccessibility="no">
      <View style={styles.pointH} />
      <View style={styles.pointV} />
      {fired ? <View style={styles.stone} /> : null}
    </View>
  );
}

function WatcherRow({
  watcher,
  first,
  now,
  busy,
  onEdit,
  onRemove,
}: {
  watcher: WatcherDto;
  first: boolean;
  now: number;
  busy: boolean;
  onEdit: (() => void) | undefined;
  onRemove: (() => void) | undefined;
}) {
  return (
    <View style={[styles.row, !first && styles.rowRule]}>
      <BoardPoint fired={watcher.fireCount > 0} />
      <View style={styles.rowBody}>
        <Text style={text.voice} numberOfLines={2}>
          {watcher.label}
        </Text>
        <Text style={[text.body, styles.sentence]}>
          {watcherParts(watcher).map((part, i) => (
            <Text key={i} style={part.value ? styles.value : undefined}>
              {part.text}
            </Text>
          ))}
        </Text>
        <Text style={text.caption}>
          {firedLine(watcher, now)} · {triggerLine(watcher)}
          {watcher.setBy === 'owner' ? ' · added by you' : ''}
        </Text>
        {watcher.lastError ? (
          <Text style={text.caption}>Last check couldn’t read it: {watcher.lastError}</Text>
        ) : null}
        {onEdit || onRemove ? (
          <View style={styles.actions}>
            {onEdit ? <RowAction label="Edit" onPress={onEdit} /> : null}
            {onRemove ? (
              <RowAction label={busy ? 'Removing…' : 'Remove'} onPress={onRemove} quiet />
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function RowAction({
  label,
  onPress,
  quiet = false,
}: {
  label: string;
  onPress: () => void;
  quiet?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" hitSlop={8} onPress={onPress}>
      <Text style={[styles.action, quiet && styles.actionQuiet]}>{label}</Text>
    </Pressable>
  );
}

function WatcherSheet({
  agent,
  existing,
  watcher,
  onClose,
  onSaved,
}: {
  agent: Agent;
  existing: readonly WatcherDto[];
  watcher: WatcherDto | null;
  onClose: () => void;
  onSaved: (dto: AgentWatchersDto) => void;
}) {
  const { agents: api } = useSession();
  const markets = useMemo(() => marketChoices(agent.mandate), [agent.mandate]);
  // Only a watcher `formOf` can read opens here: the row hides Edit otherwise.
  const [form, setForm] = useState<WatcherForm>(
    () => (watcher && formOf(watcher)) || emptyForm(markets),
  );
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<WatcherForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const save = async () => {
    if (!api || saving) return;
    const built = bodyOf(form, markets);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const id = watcher?.id ?? newWatcherId(existing, Date.now());
      onSaved(await api.saveWatcher(agent.id, id, built.body));
    } catch (caught) {
      setProblem(describeWatcherError(caught));
    } finally {
      setSaving(false);
    }
  };

  const title = watcher ? 'Edit watcher' : 'New watcher';

  const ops = formOps(form.kind);
  const pickKind = (kind: WatcherForm['kind']) =>
    set({
      kind,
      op: formOps(kind)[0]!.value,
      value: kind === form.kind ? form.value : '',
      ...(kind === 'pnl'
        ? { market: markets.find((m) => m.venue === 'perpl')?.symbol ?? form.market }
        : {}),
    });

  return (
    <Sheet visible title={title} onClose={onClose}>
      <Field
        label="What it’s for"
        value={form.label}
        onChangeText={(label) => set({ label })}
        placeholder="BTC breaks out of its range"
        maxLength={120}
      />
      <Picker label="Watch">
        {FORM_KINDS.map((kind) => (
          <Chip
            key={kind.value}
            label={kind.label}
            selected={form.kind === kind.value}
            onPress={() => pickKind(kind.value)}
          />
        ))}
      </Picker>
      <Picker label="Market">
        {markets
          .filter((m) => form.kind !== 'pnl' || m.venue === 'perpl')
          .map((m) => (
            <Chip
              key={m.symbol}
              label={m.symbol}
              selected={form.market === m.symbol}
              onPress={() => set({ market: m.symbol })}
            />
          ))}
      </Picker>
      {form.kind === 'rsi' || form.kind === 'macd' ? (
        <Picker label="Candles">
          {FORM_TIMEFRAMES.map((tf) => (
            <Chip
              key={tf}
              label={tf}
              selected={form.timeframe === tf}
              onPress={() => set({ timeframe: tf })}
            />
          ))}
        </Picker>
      ) : null}
      <Picker label="When">
        {ops.map((op) => (
          <Chip
            key={op.value}
            label={op.label}
            selected={form.op === op.value}
            onPress={() => set({ op: op.value })}
          />
        ))}
      </Picker>
      {form.kind !== 'macd' ? (
        <Field
          label={
            form.kind === 'pnl' ? 'P&L, % of margin' : form.kind === 'rsi' ? 'RSI level' : 'Price'
          }
          value={form.value}
          onChangeText={(value) => set({ value })}
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          suffix={form.kind === 'pnl' ? '%' : undefined}
        />
      ) : null}
      <Picker label="Rest after it fires">
        {FORM_COOLDOWNS.map((c) => (
          <Chip
            key={c.minutes}
            label={c.label}
            selected={form.cooldownMinutes === c.minutes}
            onPress={() => set({ cooldownMinutes: c.minutes })}
          />
        ))}
      </Picker>
      {error ? <Text style={[text.dim, text.danger]}>{error}</Text> : null}
      {problem ? <Notice tone="error" title={problem.title} detail={problem.detail} /> : null}
      <View style={styles.footer}>
        <ButtonRow>
          <Button label="Cancel" onPress={onClose} />
          <Button
            label={watcher ? 'Save watcher' : 'Add watcher'}
            kind="primary"
            busy={saving}
            onPress={() => void save()}
          />
        </ButtonRow>
      </View>
    </Sheet>
  );
}

function Picker({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.picker}>
      <Text style={text.label}>{label}</Text>
      <Chips>{children}</Chips>
    </View>
  );
}

const POINT = 18;

const styles = StyleSheet.create({
  summary: { marginBottom: 4 },
  row: { flexDirection: 'row', gap: 14, paddingVertical: 14 },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  rowBody: { flex: 1, gap: 4 },
  sentence: { color: color.textDim },
  value: { fontFamily: font.medium, color: color.purpleHi, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 20, marginTop: 4 },
  action: { fontFamily: font.medium, fontSize: 13, color: color.text },
  actionQuiet: { color: color.textDim },
  point: {
    width: POINT,
    height: POINT,
    marginTop: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pointH: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: color.lineStrong },
  pointV: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: color.lineStrong },
  stone: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: color.purple,
    shadowColor: color.purple,
    shadowOpacity: 0.5,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  picker: { gap: 8, paddingTop: 12 },
  footer: { marginTop: 16 },
});
