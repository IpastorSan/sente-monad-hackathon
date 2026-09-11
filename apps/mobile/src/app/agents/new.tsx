/**
 * Hire an agent, in four steps: identity, instructions, mandate, review.
 *
 * With `?amend=<id>` the same screen amends an existing agent's mandate and
 * shows only the last two steps, so a mandate is always edited and read back
 * in exactly one place.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  AGENT_LIMITS,
  AGENT_MODELS,
  describeAgentsError,
  modelLabel,
  type Agent,
  type HireAgentResult,
} from '@/agents/api';
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
  const { amend } = useLocalSearchParams<{ amend?: string }>();
  const { agents: api } = useSession();

  const steps: StepId[] = amend
    ? ['mandate', 'review']
    : ['identity', 'instructions', 'mandate', 'review'];
  const [index, setIndex] = useState(0);
  const step = steps[index] ?? 'review';

  const [name, setName] = useState('');
  const [model, setModel] = useState<string>(AGENT_MODELS[0].id);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [strategy, setStrategy] = useState('');
  const [form, setForm] = useState<MandateForm>(() => defaultMandateForm(nowSeconds()));
  /** A preset counts from the moment of submitting; `null` keeps `form.expiresAt` as is. */
  const [expiryDays, setExpiryDays] = useState<number | null>(7);
  const [showErrors, setShowErrors] = useState(false);

  const [target, setTarget] = useState<Agent | null>(null);
  const [loadError, setLoadError] = useState<ErrorCopy | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ErrorCopy | null>(null);
  const [hired, setHired] = useState<HireAgentResult | null>(null);

  useEffect(() => {
    if (!amend || !api) return;
    let cancelled = false;
    api.get(amend).then(
      (agent) => {
        if (cancelled) return;
        setTarget(agent);
        setForm(formFromMandate(agent.mandate));
        setExpiryDays(null);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(describeAgentsError(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [amend, api]);

  const patch = (change: Partial<MandateForm>) => setForm((current) => ({ ...current, ...change }));

  const currentMandate = () => {
    const now = nowSeconds();
    const expiresAt = expiryDays === null ? form.expiresAt : now + expiryDays * DAY_SECONDS;
    return buildMandate({ ...form, expiresAt }, now);
  };
  const mandateResult = currentMandate();
  const mandateErrors: MandateErrors = showErrors && !mandateResult.ok ? mandateResult.errors : {};

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
      if (amend) {
        await api.amendMandate(amend, result.mandate);
        router.back();
      } else {
        setHired(
          await api.hire({
            name: name.trim(),
            systemPrompt,
            strategy,
            model,
            mandate: result.mandate,
          }),
        );
      }
    } catch (error) {
      setSubmitError(describeAgentsError(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (hired) return <Hired result={hired} />;

  const title = amend ? `Amend ${target?.name ?? 'mandate'}` : 'Hire an agent';

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
          label={amend ? 'Save mandate' : 'Hire agent'}
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
        />
      ) : null}

      {step === 'review' ? (
        <>
          {!amend ? (
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
              : 'Hiring creates the agent’s wallet with this policy attached. The wallet starts empty: fund it from the agent’s page.'}
          </Text>
          {submitError ? (
            <Notice tone="error" title={submitError.title} detail={submitError.detail} />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

function MandateStep({
  form,
  patch,
  errors,
  expiryDays,
  setExpiryDays,
}: {
  form: MandateForm;
  patch: (change: Partial<MandateForm>) => void;
  errors: MandateErrors;
  expiryDays: number | null;
  setExpiryDays: (days: number | null) => void;
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
});
