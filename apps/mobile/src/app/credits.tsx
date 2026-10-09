/**
 * Credits (SEN-183): the AI credits a user's agents spend. Sente gives every
 * user a free tier — 10 USD of model credits a month on their own OpenRouter
 * key — and this screen says how much of it is left, when it refills, and
 * where it went, by agent and by run.
 *
 * The free tier is drawn as a row of stones, one per dollar: white while
 * unspent, hollow once spent. The breakdown under it is an estimate (the
 * server keeps only each agent's last runs) and says so; the figure in the
 * headline is OpenRouter's own meter.
 *
 * Buying more is built but closed: the packs, the custom amount and auto
 * top-up are shown as they will be, disabled, with the server's reason. The
 * shop opens when `GET /credits/plans` says `purchasesEnabled`, and even then
 * this build only shows it; the purchase flow is not in the app yet.
 */
import { Redirect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { modelLabel } from '@/agents/api';
import { stopLabel } from '@/agents/terminal';
import { relativeAge } from '@/agents/usage';
import {
  CLOSED_PLANS,
  CreditsApi,
  CreditsApiError,
  type CreditPlans,
  type CreditsOverview,
} from '@/credits/api';
import {
  autoTopUpLine,
  formatUsd,
  freeTierLine,
  paymentLine,
  planCard,
  resetLine,
  runCost,
  runsLabel,
  spentShare,
  stoneRow,
} from '@/credits/view';
import { useSession } from '@/session';
import { Icon } from '@/ui/icons';
import { Button, Card, Loading, Notice, Screen, Section, TopBar } from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; overview: CreditsOverview; plans: CreditPlans }
  | { kind: 'failed'; title: string; detail: string };

export default function Credits() {
  const router = useRouter();
  const { auth, api } = useSession();
  const credits = useMemo(() => new CreditsApi({ auth: api }), [api]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [overview, plans] = await Promise.all([
        credits.overview(),
        credits.plans().catch(() => CLOSED_PLANS),
      ]);
      setState({ kind: 'ready', overview, plans });
    } catch (error) {
      setState({ kind: 'failed', ...describeCreditsError(error) });
    } finally {
      setNow(Date.now());
    }
  }, [credits]);

  useEffect(() => {
    void load();
  }, [load]);

  if (auth.status !== 'ready') return <Redirect href="/welcome" />;

  const back = () => (router.canGoBack() ? router.back() : router.replace('/account'));
  const refresh = () => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  };

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <TopBar back={{ label: 'Back', onPress: back }} />
      <View style={styles.head}>
        <Text style={text.display}>Credits</Text>
      </View>

      {state.kind === 'loading' ? <Loading /> : null}
      {state.kind === 'failed' ? (
        <Notice tone="error" title={state.title} detail={state.detail} />
      ) : null}
      {state.kind === 'ready' ? (
        <>
          <FreeTier overview={state.overview} />
          <ByAgent
            overview={state.overview}
            now={now}
            onAgent={(id) => router.push(`/agents/${id}`)}
          />
          <RecentRuns
            overview={state.overview}
            now={now}
            onAgent={(id) => router.push(`/agents/${id}`)}
          />
          <AddCredits plans={state.plans} />
        </>
      ) : null}
    </Screen>
  );
}

// ─── The free tier ──────────────────────────────────────────────────────────

function FreeTier({ overview }: { overview: CreditsOverview }) {
  const { limitUsd, remainingUsd, usedUsd } = overview;
  const empty = remainingUsd !== null && remainingUsd <= 0;
  return (
    <Card style={styles.tier}>
      <View style={styles.tierHead}>
        <Text style={text.label}>Free tier</Text>
        <Text style={[text.caption, text.num]}>
          {formatUsd(usedUsd)} used{overview.reset.period === 'monthly' ? ' this month' : ''}
        </Text>
      </View>

      {limitUsd !== null && remainingUsd !== null ? (
        <>
          <View style={styles.figure}>
            <Text style={[text.hero, empty && styles.heroEmpty]}>{formatUsd(remainingUsd)}</Text>
            <Text style={[text.dim, styles.of]}>left of {formatUsd(limitUsd)}</Text>
          </View>
          <Stones remainingUsd={remainingUsd} limitUsd={limitUsd} />
        </>
      ) : (
        <Text style={[text.title, styles.figure]}>No limit on this key</Text>
      )}

      <Text style={[text.body, styles.gift]}>
        {freeTierLine(overview.freeTierUsd, overview.reset.period)}
      </Text>
      <Text style={text.caption}>{resetLine(overview)}</Text>
      {!overview.provisioned ? (
        <Text style={[text.caption, styles.after]}>
          Nothing spent yet: your first agent run starts the meter.
        </Text>
      ) : null}
      {overview.mode === 'shared' ? (
        <Notice
          title="This server shares one key"
          detail="It is a development server: every user draws on the same credits, so these numbers are everyone’s."
        />
      ) : null}
      {empty ? (
        <Notice
          tone="error"
          title="This month’s credits are used up"
          detail="Your agents can’t run until the credits refill."
        />
      ) : null}
    </Card>
  );
}

/**
 * The free tier as stones on a line: one per dollar, white while unspent,
 * hollow once spent, the stone the meter is in part-white. The lilac tick
 * after the last is the limit, as on a mandate gauge.
 */
function Stones({ remainingUsd, limitUsd }: { remainingUsd: number; limitUsd: number }) {
  const { fills, perStone } = stoneRow(remainingUsd, limitUsd);
  const spent = Math.round(spentShare({ limitUsd, remainingUsd }) * 100);
  return (
    <View
      style={styles.stones}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${formatUsd(remainingUsd)} of ${formatUsd(limitUsd)} left`}
      accessibilityValue={{ min: 0, max: 100, now: 100 - spent }}
    >
      <View style={styles.line} />
      {fills.map((fill, i) => (
        <View key={i} style={styles.slot}>
          <View style={[styles.stone, fill === 0 && styles.stoneSpent]}>
            {fill > 0 ? <View style={[styles.stoneFill, { width: `${fill * 100}%` }]} /> : null}
          </View>
        </View>
      ))}
      <View style={styles.cap} />
      {perStone !== 1 ? (
        <Text style={[text.caption, styles.perStone]}>one stone = {formatUsd(perStone)}</Text>
      ) : null}
    </View>
  );
}

// ─── Where it went ──────────────────────────────────────────────────────────

function ByAgent({
  overview,
  now,
  onAgent,
}: {
  overview: CreditsOverview;
  now: number;
  onAgent: (id: string) => void;
}) {
  const { byAgent, unattributedUsd, note } = overview.usage;
  const leftover = unattributedUsd !== null && unattributedUsd >= 0.0001 ? unattributedUsd : null;
  return (
    <Section
      label={overview.reset.period === 'monthly' ? 'By agent, this month' : 'By agent'}
      aside={<Text style={text.caption}>Estimated</Text>}
    >
      {byAgent.length === 0 && leftover === null ? (
        <Text style={text.dim}>
          No agent has run in this window yet. Each run’s model cost shows up here.
        </Text>
      ) : null}
      {byAgent.map((agent) => (
        <LineRow
          key={agent.agentId}
          title={agent.name}
          detail={`${runsLabel(agent.runs)} · last ${relativeAge(agent.lastRunAt, now)} ago`}
          value={formatUsd(agent.costUsd)}
          onPress={() => onAgent(agent.agentId)}
        />
      ))}
      {leftover !== null ? (
        <LineRow
          title="Not itemised"
          detail="Older runs Sente no longer keeps, or calls that reported no cost."
          value={formatUsd(leftover)}
          quiet
        />
      ) : null}
      {note ? <Text style={[text.caption, styles.after]}>{note}</Text> : null}
    </Section>
  );
}

function RecentRuns({
  overview,
  now,
  onAgent,
}: {
  overview: CreditsOverview;
  now: number;
  onAgent: (id: string) => void;
}) {
  const runs = overview.usage.recentRuns;
  if (runs.length === 0) return null;
  return (
    <Section label="Recent runs" aside={<Text style={text.caption}>Cost per run</Text>}>
      {runs.map((run) => (
        <LineRow
          key={run.runId}
          title={run.agentName}
          detail={[
            `${relativeAge(run.startedAt, now)} ago`,
            run.trigger === 'manual' ? 'run by you' : 'scheduled',
            modelLabel(run.model),
            run.stopReason ? stopLabel(run.stopReason) : run.status,
          ].join(' · ')}
          value={runCost(run.costUsd)}
          dimValue={run.costUsd === null}
          onPress={() => onAgent(run.agentId)}
        />
      ))}
    </Section>
  );
}

function LineRow({
  title,
  detail,
  value,
  onPress,
  quiet = false,
  dimValue = false,
}: {
  title: string;
  detail: string;
  value: string;
  onPress?: () => void;
  quiet?: boolean;
  dimValue?: boolean;
}) {
  const body = (
    <>
      <View style={styles.grow}>
        <Text style={quiet ? text.dim : text.strong} numberOfLines={1}>
          {title}
        </Text>
        <Text style={text.caption} numberOfLines={2}>
          {detail}
        </Text>
      </View>
      <Text style={[dimValue ? text.caption : text.body, text.num, styles.value]}>{value}</Text>
    </>
  );
  if (!onPress) return <View style={styles.lineRow}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.lineRow, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

// ─── Buying more ────────────────────────────────────────────────────────────

function AddCredits({ plans }: { plans: CreditPlans }) {
  const open = plans.purchasesEnabled;
  const threshold = plans.autoTopUp.thresholdsUsd[1] ?? plans.autoTopUp.thresholdsUsd[0] ?? 2;
  const amount = plans.autoTopUp.amountsUsd[0] ?? 10;
  // This build has no purchase flow: an open shop is shown, never sold through.
  const note = open ? 'Buying credits isn’t in this version of the app yet.' : plans.note;
  return (
    <Section label="Add credits">
      <View style={styles.closed}>
        <Icon name="key" size={16} color={color.textDim} />
        <Text style={[text.dim, styles.grow]}>{note}</Text>
      </View>

      <View style={styles.plans} accessibilityState={{ disabled: true }}>
        {plans.plans.map((plan) => {
          const card = planCard(plan, plans.custom);
          return (
            <View
              key={plan.id}
              style={styles.plan}
              accessible
              accessibilityLabel={`${card.title} ${card.detail}, unavailable`}
              accessibilityState={{ disabled: true }}
            >
              <Text style={styles.planTitle}>{card.title}</Text>
              <Text style={text.caption}>{card.detail}</Text>
            </View>
          );
        })}
      </View>
      <Button label="Buy credits" kind="primary" disabled onPress={() => undefined} />
      {plans.paymentAssets.length > 0 ? (
        <Text style={[text.caption, styles.after]}>{paymentLine(plans.paymentAssets)}</Text>
      ) : null}

      <View style={[styles.lineRow, styles.topUp]}>
        <View style={styles.grow}>
          <Text style={[text.body, styles.disabledText]}>Top up automatically</Text>
          <Text style={text.caption}>{autoTopUpLine(threshold, amount)}</Text>
        </View>
        <Switch
          value={false}
          disabled
          accessibilityLabel="Top up automatically, unavailable"
          trackColor={{ false: color.line, true: color.purple }}
          thumbColor={color.textFaint}
          ios_backgroundColor={color.line}
        />
      </View>
    </Section>
  );
}

// ─── Errors ─────────────────────────────────────────────────────────────────

function describeCreditsError(error: unknown): { title: string; detail: string } {
  if (error instanceof CreditsApiError) {
    switch (error.reason) {
      case 'credits_unconfigured':
        return {
          title: 'AI credits aren’t set up on this server',
          detail: 'It has no OpenRouter key, so agents can’t run here yet.',
        };
      case 'status_unavailable':
        return {
          title: 'OpenRouter didn’t answer',
          detail: 'Your credits are safe; the meter couldn’t be read. Pull down to try again.',
        };
      default:
        return { title: `The API answered ${error.status}`, detail: error.message };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return { title: 'Couldn’t reach the API', detail: `${message}. Pull down to try again.` };
}

const STONE = 26;

const styles = StyleSheet.create({
  head: { height: 48, justifyContent: 'flex-end' },
  tier: { marginTop: 20, gap: 4 },
  tierHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  figure: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 14 },
  heroEmpty: { color: color.textDim },
  of: { flexShrink: 1 },
  stones: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 18,
    marginBottom: 18,
    paddingRight: 10,
  },
  // The board line the stones sit on.
  line: {
    position: 'absolute',
    left: 0,
    right: 10,
    top: STONE / 2,
    height: 1,
    backgroundColor: color.line,
  },
  slot: { flex: 1, alignItems: 'center', minWidth: 10, paddingHorizontal: 3 },
  stone: {
    width: '100%',
    maxWidth: STONE,
    aspectRatio: 1,
    borderRadius: STONE,
    borderWidth: 1,
    borderColor: '#FFFFFF',
    backgroundColor: color.board,
    overflow: 'hidden',
  },
  stoneSpent: { borderColor: color.lineStrong, borderWidth: 1.5 },
  stoneFill: { height: '100%', backgroundColor: '#ECE8FB' },
  cap: {
    position: 'absolute',
    right: 0,
    top: STONE / 2 - 9,
    width: 3,
    height: 18,
    borderRadius: 2,
    backgroundColor: color.purpleSoft,
  },
  perStone: { width: '100%', marginTop: 6 },
  gift: { marginTop: 2 },
  after: { marginTop: 10 },
  grow: { flex: 1, minWidth: 0 },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  pressed: { opacity: 0.6 },
  value: { textAlign: 'right' },
  closed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
  plans: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12, marginBottom: 12 },
  plan: {
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: 84,
    padding: 14,
    borderRadius: RADIUS.well,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.lineStrong,
    justifyContent: 'flex-end',
    gap: 2,
    opacity: 0.6,
  },
  planTitle: {
    fontFamily: font.display,
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.6,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  topUp: { marginTop: 12, borderTopWidth: 1, borderTopColor: color.line },
  disabledText: { color: color.textDim },
});
