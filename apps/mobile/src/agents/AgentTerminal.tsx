/**
 * The agent terminal (SEN-178): one run's transcript as a small terminal —
 * what the agent was shown, what it thought, said and called, and what each
 * call came back with — tailed live while the run is going.
 *
 * Self-contained: give it an agent and a run id and it reads the transcript
 * itself, polling every 1.5 s while the run is live and stopping once it ends.
 * The logic (merging, cadence, line text) is `terminal.ts`, tested in node.
 *
 * It follows the newest line until the reader scrolls up, then holds still
 * and counts what arrived; "Jump to latest" picks the tail back up.
 *
 * Colour follows the Goban rules: the agent's own words in its voice colour
 * (`purpleSoft`), a tool call's name in purple (a call is a move), a result
 * that held in mint, a refusal in `purpleSoft` — the mandate or the enclave
 * working, never an error — and only a real failure in berry. Thinking and
 * bookkeeping sit back in the faint tones.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { AgentsApiError, modelLabel } from '@/agents/api';
import {
  EMPTY_VIEW,
  formatCost,
  formatEntries,
  formatTokens,
  pollRun,
  stopLabel,
  type LineTone,
  type RunView,
  type TerminalLine,
} from '@/agents/terminal';
import { useSession } from '@/session';
import { Pill } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import { useWide } from '@/ui/kit';
import { color, font, RADIUS } from '@/ui/theme';

/** How close to the bottom still counts as following the tail. */
const FOLLOW_SLACK = 24;

export function AgentTerminal({
  agentId,
  runId,
  initiallyOpen = true,
}: {
  agentId: string;
  runId: string;
  initiallyOpen?: boolean;
}) {
  const { agents: api } = useSession();
  const wide = useWide();
  const [view, setView] = useState<RunView>(EMPTY_VIEW);
  const [open, setOpen] = useState(initiallyOpen);

  useEffect(() => {
    setView(EMPTY_VIEW);
    if (!api) return;
    return pollRun({
      fetchPage: (after) => api.runTranscript(agentId, runId, after),
      onView: setView,
      isGone: (error) => error instanceof AgentsApiError && error.status === 404,
    });
  }, [api, agentId, runId]);

  const run = view.run;
  const lines = useMemo(() => formatEntries(view.entries, run?.startedAt), [view.entries, run]);
  const live = run?.status === 'running';

  const status = !run
    ? null
    : live
      ? { label: 'Live', tone: 'live' as const }
      : run.status === 'interrupted'
        ? { label: 'Cut off', tone: 'held' as const }
        : { label: capitalise(stopLabel(run.stopReason)), tone: 'idle' as const };

  return (
    <View style={styles.panel}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? 'Collapse the run terminal' : 'Expand the run terminal'}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.head, pressed && styles.pressed]}
      >
        <View style={styles.headText}>
          <Text style={styles.headTitle} numberOfLines={1}>
            {run ? `${modelLabel(run.model)} · ${run.runId.slice(4, 12)}` : 'Run'}
          </Text>
          {run ? (
            <Text style={styles.headTotals} numberOfLines={1}>
              {[
                `${run.iterations} turn${run.iterations === 1 ? '' : 's'}`,
                `${formatTokens(run.inputTokens + run.outputTokens)} tok`,
                formatCost(run.costUsd),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          ) : null}
        </View>
        {status ? <Pill label={status.label} tone={status.tone} /> : null}
        <View style={[styles.chevron, open && styles.chevronOpen]}>
          <Icon name="chevron" size={14} color={color.textFaint} />
        </View>
      </Pressable>
      {open ? (
        <Tail
          lines={lines}
          height={wide ? 420 : 300}
          live={live}
          placeholder={
            view.gone
              ? 'This run is no longer kept. The server holds the last ten runs.'
              : view.error && lines.length === 0
                ? `Couldn’t read the run: ${view.error}. Retrying.`
                : !view.loaded
                  ? 'Connecting to the run…'
                  : null
          }
          error={view.error && lines.length > 0 && !view.gone ? view.error : null}
        />
      ) : null}
    </View>
  );
}

function capitalise(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function Tail({
  lines,
  height,
  live,
  placeholder,
  error,
}: {
  lines: TerminalLine[];
  height: number;
  live: boolean;
  placeholder: string | null;
  error: string | null;
}) {
  const scroller = useRef<ScrollView>(null);
  const following = useRef(true);
  const [pausedAt, setPausedAt] = useState<number | null>(null);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const gap = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const atEnd = gap <= FOLLOW_SLACK;
    if (atEnd === following.current) return;
    following.current = atEnd;
    setPausedAt(atEnd ? null : lines.length);
  };

  const jump = () => {
    following.current = true;
    setPausedAt(null);
    scroller.current?.scrollToEnd({ animated: true });
  };

  const unseen = pausedAt === null ? 0 : Math.max(0, lines.length - pausedAt);

  return (
    <View>
      <ScrollView
        ref={scroller}
        style={[styles.tail, { height }]}
        contentContainerStyle={styles.tailContent}
        nestedScrollEnabled
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={() => {
          if (following.current) scroller.current?.scrollToEnd({ animated: false });
        }}
      >
        {placeholder ? <Text style={[styles.line, styles.placeholder]}>{placeholder}</Text> : null}
        {lines.map((line) => (
          <Line key={line.key} line={line} />
        ))}
        {live && !placeholder ? <Text style={[styles.line, styles.cursor]}>▍</Text> : null}
      </ScrollView>
      {error ? (
        <Text style={styles.status} numberOfLines={1}>
          Connection trouble: {error}. Retrying.
        </Text>
      ) : null}
      {pausedAt !== null ? (
        <Pressable
          accessibilityRole="button"
          onPress={jump}
          style={({ pressed }) => [styles.jump, pressed && styles.pressed]}
        >
          <Text style={styles.jumpText}>
            {unseen > 0 ? `${unseen} new · ` : 'Paused · '}Jump to latest ↓
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Line({ line }: { line: TerminalLine }) {
  const ink = INK[line.tone];
  return (
    <View style={[styles.row, line.turnStart !== undefined && styles.turnRule]}>
      <Text style={styles.gutter}>{line.elapsed}</Text>
      <Text style={[styles.glyph, { color: ink.glyph }]}>{line.glyph}</Text>
      <Text style={styles.body} selectable>
        <Text style={[styles.line, { color: ink.text }]}>{line.text}</Text>
        {line.detail ? (
          <Text style={[styles.line, { color: ink.detail }]}>{`  ${line.detail}`}</Text>
        ) : null}
      </Text>
    </View>
  );
}

const INK: Record<LineTone, { glyph: string; text: string; detail: string }> = {
  meta: { glyph: color.textFaint, text: color.textDim, detail: color.textFaint },
  thinking: { glyph: color.textFaint, text: color.textFaint, detail: color.textFaint },
  say: { glyph: color.purpleSoft, text: color.purpleSoft, detail: color.textDim },
  call: { glyph: color.purpleHi, text: color.purpleHi, detail: color.text },
  ok: { glyph: color.mint, text: color.textDim, detail: color.textFaint },
  refused: { glyph: color.purpleSoft, text: color.purpleSoft, detail: color.textDim },
  error: { glyph: color.berry, text: color.berry, detail: color.textDim },
  usage: { glyph: color.lineStrong, text: color.textFaint, detail: color.textFaint },
  end: { glyph: color.text, text: color.text, detail: color.textDim },
};

/** A shade under `ink`: the terminal is a well cut into the board, not another card. */
const TERMINAL_GROUND = '#08061A';

const styles = StyleSheet.create({
  panel: {
    borderRadius: RADIUS.well,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: TERMINAL_GROUND,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: color.board,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  headText: { flex: 1, minWidth: 0 },
  headTitle: { fontFamily: font.chain, fontSize: 12, lineHeight: 16, color: color.text },
  headTotals: { fontFamily: font.chain, fontSize: 11, lineHeight: 15, color: color.textFaint },
  chevron: { transform: [{ rotate: '0deg' }] },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  pressed: { opacity: 0.7 },
  tail: { backgroundColor: TERMINAL_GROUND },
  tailContent: { paddingVertical: 10, paddingRight: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 1 },
  turnRule: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  gutter: {
    width: 56,
    paddingLeft: 10,
    fontFamily: font.chain,
    fontSize: 10,
    lineHeight: 18,
    color: color.lineStrong,
    fontVariant: ['tabular-nums'],
  },
  glyph: { width: 16, fontFamily: font.chain, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  body: { flex: 1, minWidth: 0 },
  line: { fontFamily: font.chain, fontSize: 12, lineHeight: 18 },
  placeholder: { paddingLeft: 12, color: color.textFaint },
  cursor: { paddingLeft: 72, color: color.purpleHi },
  status: {
    fontFamily: font.chain,
    fontSize: 11,
    color: color.berry,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  jump: {
    position: 'absolute',
    bottom: 10,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: RADIUS.stone,
    backgroundColor: color.well,
    borderWidth: 1,
    borderColor: color.lineStrong,
  },
  jumpText: { fontFamily: font.medium, fontSize: 12, color: color.purpleHi },
});
