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
 *
 * SEN-59 (Goban): each step has a title that says what it is for, the primary
 * button names the step it leads to, and the mandate step starts from a preset
 * and reads the mandate back as one sentence while it is edited. None of that
 * reaches the wire: presets only fill the form, and the mandate sent is still
 * `buildMandate`'s (`presets.ts`, `mandateToSend`).
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
import {
  amendMandateWithApproval,
  describeApprovalError,
  expectedPolicyRules,
  needsApproval,
} from '@/agents/approval';
import { MandateChanges, RulesChange } from '@/agents/MandateChanges';
import { MandateStep } from '@/agents/MandateStep';
import { MandateSummary } from '@/agents/MandateSummary';
import {
  defaultMandateForm,
  formFromMandate,
  type MandateErrors,
  type MandateForm,
} from '@/agents/mandate';
import { mandateToSend, presetValues, resolveExpiry, type PresetChoice } from '@/agents/presets';
import { readBack } from '@/agents/readback';
import { useSession } from '@/session';
import {
  Button,
  Card,
  Field,
  IconButton,
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
type Mode = 'hire' | 'amend' | 'fork';

const nowSeconds = () => Math.floor(Date.now() / 1000);

type ErrorCopy = { title: string; detail: string };

/** What each step is for, in the words of the person doing it. */
function stepCopy(
  mode: Mode,
  step: StepId,
  names: { agent: string; source: string },
): { title: string; subtitle: string } {
  switch (step) {
    case 'identity':
      return {
        title: 'Name your agent',
        subtitle: 'What you’ll call it, and which model does its thinking.',
      };
    case 'instructions':
      return {
        title: 'Tell it how to trade',
        subtitle: 'In your own words. The mandate on the next step bounds all of it.',
      };
    case 'mandate':
      if (mode === 'amend')
        return {
          title: 'Redraw the lines',
          subtitle: `${names.agent}’s current mandate stands until you save a new one.`,
        };
      if (mode === 'fork')
        return {
          title: 'Draw your lines',
          subtitle: `${names.source}’s strategy, held to a mandate of your own.`,
        };
      return {
        title: 'Draw the lines',
        subtitle: 'Outside them its orders are refused, however the agent is prompted.',
      };
    case 'review':
      return {
        title: mode === 'amend' ? 'Review the change' : 'Review the mandate',
        subtitle: 'Read it once more: this is what the agent’s wallet will be held to.',
      };
  }
}

/** The primary button names the step it leads to, not "Continue". */
const NEXT_LABEL: Record<Exclude<StepId, 'review'>, string> = {
  identity: 'Write instructions',
  instructions: 'Draw the lines',
  mandate: 'Review mandate',
};

const SUBMIT_LABEL: Record<Mode, string> = {
  hire: 'Hire agent',
  amend: 'Save mandate',
  fork: 'Fork agent',
};

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
  const mode: Mode = amend ? 'amend' : fork ? 'fork' : 'hire';

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
  /**
   * SEN-59: the chip over the mandate form. A new hire starts on Standard,
   * which IS the default form above; an amend starts on Custom, because the
   * form holds the agent's own mandate. Any edit afterwards turns it Custom.
   */
  const [preset, setPreset] = useState<PresetChoice>(amend ? 'custom' : 'standard');
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
    /** SEN-59: rules the stored mandate compiles to, for "Enclave rules before → after". */
    rulesBefore: number;
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

  const patch = (change: Partial<MandateForm>) => {
    setForm((current) => ({ ...current, ...change }));
    setPreset('custom');
  };

  const chooseExpiry = (days: number | null) => {
    setExpiryDays(days);
    setPreset('custom');
  };

  /**
   * A preset replaces the form wholesale — it is a starting point, not a
   * merge — but never the way out: `returnTo` stays the live wallet's.
   * Custom changes nothing; it only says the fields are yours now.
   */
  const choosePreset = (choice: PresetChoice) => {
    setPreset(choice);
    if (choice === 'custom') return;
    const values = presetValues(choice, nowSeconds(), form.returnTo);
    setForm(values.form);
    setExpiryDays(values.expiryDays);
  };

  const currentMandate = () => mandateToSend(form, expiryDays, nowSeconds());
  const expiresAt = resolveExpiry(form, expiryDays, nowSeconds());
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
          rulesBefore: expectedPolicyRules(target.mandate).length,
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

  if (!api || (amend && !target)) {
    const title = amend
      ? `Amend ${target?.name ?? 'mandate'}`
      : fork
        ? `Fork ${source ?? 'an agent'}`
        : 'Hire an agent';
    return (
      <Screen>
        <View style={styles.stepBar}>
          <IconButton icon="close" label="Close" onPress={() => router.back()} />
        </View>
        <Text style={[text.display, styles.title]}>{title}</Text>
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

  const copy = stepCopy(mode, step, {
    agent: target?.name ?? 'The agent',
    source: source ?? 'The source',
  });
  const last = index === steps.length - 1;
  const primary = last ? (
    <Button
      label={SUBMIT_LABEL[mode]}
      kind="primary"
      busy={submitting}
      disabled={!mandateResult.ok}
      onPress={() => void submit()}
    />
  ) : (
    <Button label={NEXT_LABEL[step as Exclude<StepId, 'review'>]} kind="primary" onPress={next} />
  );
  const footer =
    step === 'mandate' ? (
      <>
        {/* SEN-59: the mandate read back as it is drawn, in the agent's voice. */}
        <Text style={[text.voice, styles.readBack]}>{`“${readBack(form, expiresAt)}”`}</Text>
        {primary}
      </>
    ) : (
      primary
    );

  return (
    <Screen footer={footer}>
      <View style={styles.stepBar}>
        <IconButton
          icon={index === 0 ? 'close' : 'back'}
          label={index === 0 ? 'Close' : 'Back'}
          onPress={back}
        />
        <Text style={[text.caption, text.num]}>
          {index + 1} of {steps.length}
        </Text>
      </View>
      <View style={styles.rail} accessibilityElementsHidden importantForAccessibility="no">
        {steps.map((id, i) => (
          <View key={id} style={[styles.railSegment, i <= index && styles.railOn]} />
        ))}
      </View>
      <Text style={[text.display, styles.title]}>{copy.title}</Text>
      <Text style={[text.dim, styles.subtitle]}>{copy.subtitle}</Text>

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
          <Notice
            title="Nothing written here can raise a limit"
            detail="The mandate on the next step bounds all of this, however it is worded."
          />
        </>
      ) : null}

      {step === 'mandate' ? (
        <MandateStep
          form={form}
          patch={patch}
          errors={mandateErrors}
          expiresAt={expiresAt}
          expiryDays={expiryDays}
          setExpiryDays={chooseExpiry}
          preset={preset}
          choosePreset={choosePreset}
          canKeepExpiry={mode === 'amend'}
          fork={fork && source ? { source, name, setName } : undefined}
        />
      ) : null}

      {step === 'review' ? (
        <>
          {fork ? (
            <Section label="Forked from">
              <Card>
                <Row label="Source" value={source ?? fork} />
                <Row label="Name" value={forkAgentName} />
                <Row label="Copied" value="Strategy and model" />
                <Row
                  label="Not copied"
                  value="The source’s wallet, mandate and track record — and its prompt, unless it is public"
                />
              </Card>
            </Section>
          ) : !amend ? (
            <Section label="Agent">
              <Card>
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
                <Row label="Prompt" value={isPublic ? 'Published' : 'Private'} />
              </Card>
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

      {/*
       * SEN-44: the approval step for a device-owned mandate. SEN-59: it shows
       * the CHANGE — old limits struck through beside the new ones — because
       * that is what the passkey is being asked to approve. The rule count
       * before is what the stored mandate compiles to (`expectedPolicyRules`,
       * the mirror `approval.ts` verifies against); after is the API's own
       * count of the prepared policy.
       */}
      <Sheet
        visible={pending !== null}
        title="Approve the new mandate"
        onClose={() => setPending(null)}
      >
        <Text style={[text.dim, styles.sheetLead]}>
          {target?.name ?? 'Your agent'}’s limits change the moment you approve. Your passkey signs
          the policy change itself: Sente holds no key that can widen this agent’s mandate, and this
          phone checks the change is exactly what you wrote before it signs.
        </Text>
        {pending ? (
          <>
            {target ? (
              <MandateChanges before={target.mandate} after={pending.mandate} />
            ) : (
              <MandateSummary mandate={pending.mandate} />
            )}
            <RulesChange
              before={pending.rulesBefore}
              after={pending.change.summary.ruleCount}
              policyId={pending.change.summary.policyId}
            />
          </>
        ) : null}
        {submitError ? (
          <Notice tone="error" title={submitError.title} detail={submitError.detail} />
        ) : null}
        <View style={styles.approvalActions}>
          <Button
            label="Approve with passkey"
            kind="primary"
            icon="key"
            busy={submitting}
            onPress={() => void approve()}
          />
          <Button label="Keep current mandate" kind="soft" onPress={() => setPending(null)} />
        </View>
      </Sheet>
    </Screen>
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
        <Card>
          <Text style={[text.mono, styles.token]} selectable>
            {mcpToken}
          </Text>
        </Card>
        <Text style={[text.dim, styles.after]}>
          Sente keeps only a hash of it, so this is the only time it appears. You need it only to
          connect an outside MCP client to this agent.
        </Text>
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  after: { marginTop: 10 },
  stepBar: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rail: { flexDirection: 'row', gap: 6, marginTop: 4 },
  railSegment: { flex: 1, height: 3, borderRadius: 3, backgroundColor: color.line },
  railOn: { backgroundColor: color.purple },
  title: { marginTop: 22 },
  subtitle: { marginTop: 8 },
  readBack: { fontSize: 15, lineHeight: 22, color: color.textDim },
  token: { color: color.text },
  sheetLead: { marginTop: 6, marginBottom: 8 },
  approvalActions: { marginTop: 16, gap: 10 },
});
