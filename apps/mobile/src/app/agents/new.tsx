/**
 * Hire an agent, in four steps: identity, instructions, mandate, review.
 *
 * With `?amend=<id>` the same screen amends an existing agent's mandate and
 * shows only the last two steps, so a mandate is always edited and read back
 * in exactly one place.
 *
 * With `?fork=<id>&from=<name>` it forks that agent's strategy (SEN-28) and
 * shows only the last two steps too. There is no strategy field on this path
 * and nothing to retype: the API copies the source's strategy and model into
 * the new agent, and copies its system prompt only if the source's owner
 * published it. The mandate written here is the forker's OWN — it is compiled
 * into the new wallet's policy, and the source's wallet is never touched.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  AGENT_LIMITS,
  AGENT_MODELS,
  describeAgentsError,
  forkName,
  modelLabel,
  type Agent,
  type AgentMandate,
  type HireAgentResult,
  type PreparedMandateChange,
} from '@/agents/api';
import { amendMandateWithApproval, describeApprovalError, needsApproval } from '@/agents/approval';
import { MandateSummary } from '@/agents/MandateSummary';
import {
  AUSD,
  buildMandate,
  defaultMandateForm,
  EXPIRY_PRESETS_DAYS,
  formatExpiry,
  formFromMandate,
  KURU_MARKETS,
  relevantDepositTokens,
  type MandateErrors,
  type MandateForm,
} from '@/agents/mandate';
import { useSession } from '@/session';
import { shortAddress } from '@/ui/format';
import {
  Button,
  ButtonRow,
  Chip,
  Chips,
  Field,
  Loading,
  Notice,
  Row,
  Screen,
  Section,
  SelectRow,
  Sheet,
  ToggleRow,
  TopBar,
} from '@/ui/kit';
import { color, text } from '@/ui/theme';

type StepId = 'identity' | 'instructions' | 'mandate' | 'review';

const STEP_TITLES: Record<StepId, string> = {
  identity: 'Identity',
  instructions: 'Instructions',
  mandate: 'Mandate',
  review: 'Review',
};

const DAY_SECONDS = 86_400;
const nowSeconds = () => Math.floor(Date.now() / 1000);

type ErrorCopy = { title: string; detail: string };

export default function HireAgentScreen() {
  const router = useRouter();
  const { amend, fork, from } = useLocalSearchParams<{
    amend?: string;
    fork?: string;
    from?: string;
  }>();
  const { agents: api, auth, wallet } = useSession();

  /** The agent being forked, named for the copy. Falls back to the raw id. */
  const source = fork ? from?.trim() || fork : undefined;

  const steps: StepId[] =
    amend || fork ? ['mandate', 'review'] : ['identity', 'instructions', 'mandate', 'review'];
  const [index, setIndex] = useState(0);
  const step = steps[index] ?? 'review';

  const [name, setName] = useState(() => (fork && source ? forkName(source) : ''));
  const [model, setModel] = useState<string>(AGENT_MODELS[0].id);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [strategy, setStrategy] = useState('');
  /** SEN-28: publish the prompt so others can fork it. Opt-in, off by default. */
  const [isPublic, setIsPublic] = useState(false);
  const [form, setForm] = useState<MandateForm>(() => defaultMandateForm(nowSeconds()));
  /** A preset counts from the moment of submitting; `null` keeps `form.expiresAt` as is. */
  const [expiryDays, setExpiryDays] = useState<number | null>(7);
  const [showErrors, setShowErrors] = useState(false);

  const [target, setTarget] = useState<Agent | null>(null);
  const [loadError, setLoadError] = useState<ErrorCopy | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ErrorCopy | null>(null);
  const [hired, setHired] = useState<HireAgentResult | null>(null);
  /**
   * SEN-44: on a device-owned agent the amend is not sent from here. The API
   * prepares the enclave PATCH, this holds it, and the sheet below shows what
   * it does before the passkey signs it — the user approves ONE prepared
   * change, the one they read.
   */
  const [pending, setPending] = useState<{
    change: PreparedMandateChange;
    mandate: AgentMandate;
  } | null>(null);

  /**
   * THE WAY OUT (SEN-17). `returnTo` is not a field anyone types: it is the
   * user's own wallet, and the API resolves it from the signed-in account and
   * refuses a mandate naming anything else.
   *
   * The form carries it anyway, because the phone has to SEND the same address
   * the API will resolve: a device-owned amend is checked rule by rule against
   * the mandate this screen sent (`approval.ts`), and a mandate missing the exit
   * would be refused rather than signed. It is read from the live wallet rather
   * than kept from the agent's stored mandate for the same reason — the live one
   * is what the API will compare against.
   *
   * Until the wallet has registered there is no address to send, and the mandate
   * compiles with no exit at all; the review step says so in as many words.
   */
  const returnTo = wallet.address;

  useEffect(() => {
    if (!amend || !api) return;
    let cancelled = false;
    api.get(amend).then(
      (agent) => {
        if (cancelled) return;
        setTarget(agent);
        setForm({ ...formFromMandate(agent.mandate), ...(returnTo ? { returnTo } : {}) });
        setExpiryDays(null);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(describeAgentsError(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [amend, api, returnTo]);

  useEffect(() => {
    if (!returnTo) return;
    setForm((current) => (current.returnTo === returnTo ? current : { ...current, returnTo }));
  }, [returnTo]);

  const patch = (change: Partial<MandateForm>) => setForm((current) => ({ ...current, ...change }));

  const currentMandate = () => {
    const now = nowSeconds();
    const expiresAt = expiryDays === null ? form.expiresAt : now + expiryDays * DAY_SECONDS;
    return buildMandate({ ...form, expiresAt }, now);
  };
  const mandateResult = currentMandate();
  const mandateErrors: MandateErrors = showErrors && !mandateResult.ok ? mandateResult.errors : {};
  /**
   * The name the copy will be stored under: what the user typed, or the same
   * default the API applies to an unnamed fork (`forkName`). Blank is sent as
   * "no name", so the API's own rule is what a cleared field means.
   */
  const forkAgentName = fork && source ? name.trim() || forkName(source) : '';

  const stepValid = (id: StepId): boolean => {
    switch (id) {
      case 'identity':
        return name.trim().length > 0 && name.length <= AGENT_LIMITS.name;
      case 'instructions':
        return (
          systemPrompt.length <= AGENT_LIMITS.systemPrompt &&
          strategy.length <= AGENT_LIMITS.strategy
        );
      case 'mandate':
        return mandateResult.ok;
      case 'review':
        return mandateResult.ok;
    }
  };

  const back = () => {
    setShowErrors(false);
    if (index === 0) router.back();
    else setIndex(index - 1);
  };

  const next = () => {
    if (!stepValid(step)) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setIndex(index + 1);
  };

  const submit = async () => {
    const result = currentMandate();
    if (!api || !result.ok) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (amend && target && needsApproval(target)) {
        // Ask for the change; nothing is amended until it is signed.
        setPending({
          change: await api.prepareAmendMandate(target.id, result.mandate),
          mandate: result.mandate,
        });
      } else if (amend) {
        await api.amendMandate(amend, result.mandate);
        router.back();
      } else if (fork) {
        // No strategy, prompt or model in this body: the API takes them from the
        // source agent, under the name sent here.
        setHired(
          await api.fork(fork, {
            mandate: result.mandate,
            ...(name.trim() !== '' ? { name: name.trim() } : {}),
          }),
        );
      } else {
        setHired(
          await api.hire({
            name: name.trim(),
            systemPrompt,
            strategy,
            model,
            mandate: result.mandate,
            public: isPublic,
          }),
        );
      }
    } catch (error) {
      setSubmitError(describeAgentsError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const approve = async () => {
    if (!api || !target || !pending) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await amendMandateWithApproval(
        api,
        target,
        pending.mandate,
        auth.signPrivyAuthorization,
        pending.change,
      );
      setPending(null);
      router.back();
    } catch (error) {
      setSubmitError(describeApprovalError(error));
      // The prepared change is spent whatever happened: preparing again is one
      // round trip, and a signature that stays usable is one waiting to be
      // replayed.
      setPending(null);
    } finally {
      setSubmitting(false);
    }
  };

  if (hired) return <Hired result={hired} />;

  const title = amend
    ? `Amend ${target?.name ?? 'mandate'}`
    : fork
      ? `Fork ${source ?? 'an agent'}`
      : 'Hire an agent';

  if (!api || (amend && !target)) {
    return (
      <Screen>
        <TopBar back={{ label: 'Cancel', onPress: () => router.back() }} />
        <Text style={text.display}>{title}</Text>
        {!api ? (
          <Notice title="Sign in first" detail="Agents belong to your passkey account." />
        ) : loadError ? (
          <Notice tone="error" title={loadError.title} detail={loadError.detail} />
        ) : (
          <Loading />
        )}
      </Screen>
    );
  }

  const last = index === steps.length - 1;
  const footer = (
    <ButtonRow>
      <Button label={index === 0 ? 'Cancel' : 'Back'} onPress={back} style={styles.grow} />
      {last ? (
        <Button
          label={amend ? 'Save mandate' : fork ? 'Fork agent' : 'Hire agent'}
          kind="primary"
          busy={submitting}
          disabled={!mandateResult.ok}
          onPress={() => void submit()}
          style={styles.grow}
        />
      ) : (
        <Button label="Continue" kind="primary" onPress={next} style={styles.grow} />
      )}
    </ButtonRow>
  );

  return (
    <Screen footer={footer}>
      <TopBar back={{ label: 'Cancel', onPress: () => router.back() }} />
      <Text style={text.display}>{title}</Text>
      <View style={styles.rail}>
        {steps.map((id, i) => (
          <View key={id} style={[styles.railSegment, i <= index && styles.railOn]} />
        ))}
      </View>
      <Text style={[text.label, text.num]}>
        Step {index + 1} of {steps.length} · {STEP_TITLES[step]}
      </Text>

      {step === 'identity' ? (
        <>
          <Field
            label="Name"
            value={name}
            onChangeText={setName}
            max={AGENT_LIMITS.name}
            placeholder="e.g. Night desk"
            autoCapitalize="words"
            error={showErrors && name.trim() === '' ? 'Give the agent a name.' : undefined}
          />
          <Section label="Model">
            {AGENT_MODELS.map((option) => (
              <SelectRow
                key={option.id}
                mode="radio"
                title={option.label}
                detail={option.id}
                selected={model === option.id}
                onPress={() => setModel(option.id)}
              />
            ))}
            <Text style={[text.caption, styles.after]}>
              Runs are billed to your OpenRouter credits.
            </Text>
          </Section>
          <Section label="Sharing">
            <ToggleRow
              title="Publish this agent’s prompt"
              detail="Lets anyone fork this agent with your instructions. The strategy can be forked either way — this is the part it gates. Off by default."
              value={isPublic}
              onValueChange={setIsPublic}
            />
          </Section>
        </>
      ) : null}

      {step === 'instructions' ? (
        <>
          <Field
            label="System prompt"
            value={systemPrompt}
            onChangeText={setSystemPrompt}
            multiline
            max={AGENT_LIMITS.systemPrompt}
            placeholder="Who the agent is and how it should behave."
          />
          <Field
            label="Strategy"
            value={strategy}
            onChangeText={setStrategy}
            multiline
            max={AGENT_LIMITS.strategy}
            placeholder="What it trades, when it acts, and when it stays out."
          />
          <Text style={[text.dim, styles.after]}>
            The mandate on the next step bounds all of this. Nothing written here can raise a limit.
          </Text>
        </>
      ) : null}

      {step === 'mandate' ? (
        <MandateStep
          form={form}
          patch={patch}
          errors={mandateErrors}
          expiryDays={expiryDays}
          setExpiryDays={setExpiryDays}
          fork={fork && source ? { source, name, setName } : undefined}
        />
      ) : null}

      {step === 'review' ? (
        <>
          {fork ? (
            <Section label="Forked from">
              <Row label="Source" value={source ?? fork} />
              <Row label="Name" value={forkAgentName} />
              <Row label="Copied" value="Strategy and model" />
              <Row
                label="Not copied"
                value="The source’s wallet, mandate and track record — and its prompt, unless it is public"
              />
            </Section>
          ) : !amend ? (
            <Section label="Agent">
              <Row label="Name" value={name.trim()} />
              <Row label="Model" value={modelLabel(model)} />
              <Row
                label="System prompt"
                value={`${systemPrompt.length.toLocaleString('en-US')} characters`}
              />
              <Row
                label="Strategy"
                value={`${strategy.length.toLocaleString('en-US')} characters`}
              />
            </Section>
          ) : null}
          <Section label="Mandate">
            {mandateResult.ok ? <MandateSummary mandate={mandateResult.mandate} /> : null}
          </Section>
          <Text style={[text.dim, styles.after]}>
            {amend
              ? 'Saving replaces the wallet’s signing policy. Until that succeeds, the current mandate stands.'
              : fork
                ? 'Forking creates your own agent with this policy attached. The strategy carries over; the source’s wallet, prompt and mandate do not. The new wallet starts empty: fund it from the agent’s page.'
                : 'Hiring creates the agent’s wallet with this policy attached. The wallet starts empty: fund it from the agent’s page.'}
          </Text>
          {submitError ? (
            <Notice tone="error" title={submitError.title} detail={submitError.detail} />
          ) : null}
        </>
      ) : null}

      {/* SEN-44: the approval step for a device-owned mandate. */}
      <Sheet
        visible={pending !== null}
        title={`Approve this mandate for ${target?.name ?? 'your agent'}?`}
        onClose={() => setPending(null)}
      >
        <Text style={text.body}>
          Your passkey signs the policy change itself. Sente holds no key that can widen this
          agent’s mandate — this phone checks that the change is exactly what you wrote and then
          approves it.
        </Text>
        {pending ? (
          <>
            <Row label="Enclave rules after" value={String(pending.change.summary.ruleCount)} />
            <Row label="Policy" value={pending.change.summary.policyId} mono />
            <View style={styles.approvalSummary}>
              <MandateSummary mandate={pending.mandate} />
            </View>
          </>
        ) : null}
        {submitError ? (
          <Notice tone="error" title={submitError.title} detail={submitError.detail} />
        ) : null}
        <View style={styles.approvalActions}>
          <ButtonRow>
            <Button label="Cancel" onPress={() => setPending(null)} style={styles.grow} />
            <Button
              label="Approve with passkey"
              kind="primary"
              busy={submitting}
              onPress={() => void approve()}
              style={styles.grow}
            />
          </ButtonRow>
        </View>
      </Sheet>
    </Screen>
  );
}

function MandateStep({
  form,
  patch,
  errors,
  expiryDays,
  setExpiryDays,
  fork,
}: {
  form: MandateForm;
  patch: (change: Partial<MandateForm>) => void;
  errors: MandateErrors;
  expiryDays: number | null;
  setExpiryDays: (days: number | null) => void;
  /** Set only when forking (SEN-28): the source's name, and the copy's name. */
  fork?: { source: string; name: string; setName: (value: string) => void };
}) {
  const toggleMarket = (address: MandateForm['kuruMarkets'][number]) =>
    patch({
      kuruMarkets: form.kuruMarkets.includes(address)
        ? form.kuruMarkets.filter((market) => market !== address)
        : [...form.kuruMarkets, address],
    });

  const depositTokens = relevantDepositTokens(form.kuruMarkets);
  const expiresAt = expiryDays === null ? form.expiresAt : nowSeconds() + expiryDays * DAY_SECONDS;

  return (
    <>
      {fork ? (
        <Section label="Fork">
          <Text style={text.dim}>
            {fork.source}’s strategy and model are copied into an agent of your own. Its system
            prompt comes with it only if that agent is public, and your copy is private either way.
            Nothing of the source’s wallet, mandate or record comes across.
          </Text>
          <Field
            label="Name"
            value={fork.name}
            onChangeText={fork.setName}
            max={AGENT_LIMITS.name}
            placeholder="Name for your copy"
            autoCapitalize="words"
            hint="Leave it blank and the copy is named after the agent you are forking."
          />
        </Section>
      ) : null}

      <Section label="Venues">
        <ToggleRow
          title="Kuru"
          detail="Spot order books"
          value={form.kuru}
          onValueChange={(kuru) => patch({ kuru })}
        />
        <ToggleRow
          title="Perpl"
          detail="Perpetual futures"
          value={form.perpl}
          onValueChange={(perpl) => patch({ perpl })}
        />
        {errors.venues ? <Text style={[text.dim, text.danger]}>{errors.venues}</Text> : null}
      </Section>

      {form.kuru ? (
        <>
          <Section label="Kuru markets">
            {KURU_MARKETS.map((market) => (
              <SelectRow
                key={market.address}
                title={market.symbol}
                detail={<Text style={text.mono}>{shortAddress(market.address)}</Text>}
                selected={form.kuruMarkets.includes(market.address)}
                onPress={() => toggleMarket(market.address)}
              />
            ))}
            {errors.kuruMarkets ? (
              <Text style={[text.dim, text.danger]}>{errors.kuruMarkets}</Text>
            ) : null}
          </Section>

          {depositTokens.length > 0 ? (
            <Section label="Kuru deposit caps">
              <Text style={text.dim}>
                The most one deposit may move into Kuru, per token. Leave a token blank and the
                agent can’t deposit it.
              </Text>
              {depositTokens.map((token) => (
                <Field
                  key={token.symbol}
                  label={`${token.symbol} per deposit`}
                  value={form.depositCaps[token.symbol] ?? ''}
                  onChangeText={(value) =>
                    patch({ depositCaps: { ...form.depositCaps, [token.symbol]: value } })
                  }
                  keyboardType="decimal-pad"
                  suffix={token.symbol}
                  placeholder="0"
                />
              ))}
              {errors.depositCaps ? (
                <Text style={[text.dim, text.danger, styles.after]}>{errors.depositCaps}</Text>
              ) : null}
            </Section>
          ) : null}
        </>
      ) : null}

      {form.perpl ? (
        <Section label="Perpl">
          <Field
            label="Collateral per transfer"
            value={form.perplCollateral}
            onChangeText={(perplCollateral) => patch({ perplCollateral })}
            keyboardType="decimal-pad"
            suffix={AUSD.symbol}
            placeholder="0"
            error={errors.perplCollateral}
            hint="The most one transfer may move into Perpl."
          />
          <Field
            label="Markets"
            value={form.perplMarkets}
            onChangeText={(perplMarkets) => patch({ perplMarkets })}
            autoCapitalize="characters"
            placeholder="BTC-PERP, ETH-PERP"
            error={errors.perplMarkets}
          />
          <Field
            label="Max leverage"
            value={form.maxLeverage}
            onChangeText={(maxLeverage) => patch({ maxLeverage })}
            keyboardType="decimal-pad"
            suffix="×"
            error={errors.maxLeverage}
          />
        </Section>
      ) : null}

      <Section label="Orders">
        <Field
          label="Largest single order"
          value={form.maxOrderNotional}
          onChangeText={(maxOrderNotional) => patch({ maxOrderNotional })}
          keyboardType="decimal-pad"
          placeholder="0"
          error={errors.maxOrderNotional}
          hint="Notional, in the market’s quote token: USDC on Kuru, AUSD on Perpl."
        />
      </Section>

      <Section label="Expiry">
        <Chips>
          {EXPIRY_PRESETS_DAYS.map((days) => (
            <Chip
              key={days}
              label={days === 1 ? '1 day' : `${days} days`}
              selected={expiryDays === days}
              onPress={() => setExpiryDays(days)}
            />
          ))}
        </Chips>
        <Text style={[text.dim, text.num, styles.after]}>Ends {formatExpiry(expiresAt)}</Text>
        {errors.expiresAt ? <Text style={[text.dim, text.danger]}>{errors.expiresAt}</Text> : null}
      </Section>
    </>
  );
}

function Hired({ result }: { result: HireAgentResult }) {
  const router = useRouter();
  const { agent, mcpToken } = result;
  return (
    <Screen
      footer={
        <Button
          label="Open agent"
          kind="primary"
          onPress={() => router.replace({ pathname: '/agents/[id]', params: { id: agent.id } })}
        />
      }
    >
      <TopBar />
      <Text style={text.display}>{agent.name} is hired</Text>
      <Section label="Wallet">
        <Text style={text.mono} selectable>
          {agent.address}
        </Text>
        <Text style={text.dim}>Empty for now. Fund it from the agent’s page.</Text>
      </Section>
      <Section label="MCP token · shown once">
        <Text style={[text.mono, styles.token]} selectable>
          {mcpToken}
        </Text>
        <Text style={text.dim}>
          Sente keeps only a hash of it, so this is the only time it appears. You need it only to
          connect an outside MCP client to this agent.
        </Text>
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  after: { marginTop: 10 },
  rail: { flexDirection: 'row', gap: 4, marginTop: 16, marginBottom: 10 },
  railSegment: { flex: 1, height: 2, backgroundColor: color.rule },
  railOn: { backgroundColor: color.text },
  token: { color: color.text },
  approvalSummary: { marginTop: 8 },
  approvalActions: { marginTop: 20 },
});
