/**
 * Configure a preset, then hire it (SEN-116, plan U-9; agents.html → "Hire
 * Range Trader": Strategy, Mandate, Review & fund).
 *
 * Goban's four hire steps become three. The preset writes the instructions,
 * so there is no prompt to type; naming moves into Review, prefilled.
 *
 * - Strategy: one control per `ParamSpec` (`presets/params.ts`), validated by
 *   `resolveParams` — the check the API runs on hire — and read back in the
 *   agent's voice. Every price level says whether it is a real order resting
 *   on the venue or a line the agent only watches between runs.
 * - Mandate: the shared `MandateStep`, prefilled from the preset's suggested
 *   mandate. It only fills the form: the mandate sent is still
 *   `mandateToSend`'s, byte for byte what the same form sends from
 *   `agents/new`. Soft rules are shown as the agent's, never the enclave's.
 * - Review: name, model, cadence, and an amount to fund with. Hiring sends
 *   `{preset: {id, version, params}, schedule}` and no strategy text, so the
 *   API renders the same text this phone previewed (and refuses if the
 *   catalog version moved — so the version and specs come from
 *   `GET /presets`, not the bundle; see `presets/served.ts`, SEN-160).
 *   Funding is then the same passkey-approved
 *   sponsored transfer the agent page's Fund sheet sends.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import type { Params, ParamSpec, PresetDefinition } from '@sente/presets';

import { formatAtoms, parseAmount } from '@/agents/amounts';
import {
  AGENT_LIMITS,
  AGENT_MODELS,
  AgentsApiError,
  describeAgentsError,
  type AgentMandate,
  type HireAgentResult,
} from '@/agents/api';
import { readBalance } from '@/agents/balances';
import { DepositPinStatus } from '@/agents/DepositPin';
import { needsDepositPin, secureDeposits, type DepositPinState } from '@/agents/depositPin';
import { FUNDING_TOKENS } from '@/agents/fund';
import { MandateStep } from '@/agents/MandateStep';
import { defaultMandateForm, type MandateErrors, type MandateForm } from '@/agents/mandate';
import { mandateToSend, resolveExpiry, type PresetChoice } from '@/agents/presets';
import { readBack } from '@/agents/readback';
import { usePolling } from '@/markets/usePolling';
import { useMarkets } from '@/markets/hooks';
import { cadenceLabel } from '@/presets/cards';
import {
  checkParams,
  controlFor,
  defaultAgentName,
  draftMarket,
  formatParam,
  fundingAssets,
  guardianLines,
  initialDraft,
  prefillDraft,
  LEVEL_NOTE,
  presetHireRequest,
  LEVEL_TAG,
  readBackParams,
  runsLabel,
  scheduleFor,
  snapToStep,
  SOFT_RULE_NOTE,
  suggestedFunding,
  suggestedValues,
  tierValues,
  type Draft,
  type LevelKind,
  type ParamControl,
} from '@/presets/params';
import { useHirePreset } from '@/presets/usePresets';
import { useSession } from '@/session';
import { shortAddress } from '@/ui/format';
import { Icon } from '@/ui/icons';
import {
  Button,
  Card,
  Chip,
  Chips,
  Field,
  IconButton,
  Notice,
  Row,
  Screen,
  Section,
  Segmented,
  ToggleRow,
  TopBar,
} from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';
import { describeSendError, sendSponsored } from '@/wallet/send';

type StepId = 'strategy' | 'mandate' | 'review';
const STEPS: readonly StepId[] = ['strategy', 'mandate', 'review'];
const STEP_NAMES: Record<StepId, string> = {
  strategy: 'Strategy',
  mandate: 'Mandate',
  review: 'Review',
};

const TIER_LABEL = { cautious: 'Cautious', standard: 'Standard', wide: 'Wide' } as const;

/** Guardian's price refresh; the lines are prefilled once, so this only needs to be recent. */
const TICKER_MS = 5_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);

type ErrorCopy = { title: string; detail: string };
type FundOutcome = { tone: 'ok' | 'info' | 'error'; title: string; detail?: string };

export default function ConfigurePresetScreen() {
  const router = useRouter();
  const { id, market, amount } = useLocalSearchParams<{
    id: string;
    market?: string;
    amount?: string;
  }>();
  // SEN-160: the version and specs come from `GET /presets`, so a preset bump
  // on the server doesn't turn every hire from this build into a refusal.
  const { state, reload } = useHirePreset(id);

  if (state.kind === 'ready') {
    // SEN-179: a ticket's "Protect it with a Guardian agent" hands over its market and amount.
    return <Configure def={state.def} reload={reload} prefill={{ market, amount }} />;
  }
  const back = { label: 'Presets', onPress: () => router.back() };
  return (
    <Screen
      {...(state.kind === 'error'
        ? { footer: <Button label="Try again" kind="primary" onPress={reload} /> }
        : {})}
    >
      <TopBar back={back} />
      {state.kind === 'loading' ? (
        <Text style={[text.caption, styles.after]}>Loading the preset…</Text>
      ) : state.kind === 'error' ? (
        <Notice tone="error" title="The preset catalog didn’t load" detail={state.message} />
      ) : state.kind === 'update-app' ? (
        <Notice
          title={`Update the app to hire ${state.dto.name}`}
          detail={`${state.dto.name} changed on Sente (version ${state.dto.version}) in a way this version of the app can’t show. Update the app to configure and hire it; nothing has been sent.`}
        />
      ) : (
        <Notice
          tone="error"
          title="No such preset"
          detail="It may have left the catalog. Go back and pick another."
        />
      )}
    </Screen>
  );
}

function Configure({
  def,
  reload,
  prefill,
}: {
  def: PresetDefinition;
  reload: () => void;
  prefill: Readonly<Record<string, string | undefined>>;
}) {
  const router = useRouter();
  const { agents: api, auth, wallet, walletApi, markets: marketsApi } = useSession();

  const [index, setIndex] = useState(0);
  const step = STEPS[index] ?? 'review';
  const [showErrors, setShowErrors] = useState(false);

  // ─── Strategy ────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState<Draft>(() => prefillDraft(def, initialDraft(def), prefill));
  /** Keys the person has set by hand: a live-price prefill never overwrites them. */
  const touched = useRef(new Set<string>());
  const setParam = (key: string, value: Draft[string]) => {
    touched.current.add(key);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const served = useMarkets();
  const perps = useMemo(
    () =>
      (served.data?.markets ?? [])
        .filter((market) => market.venue === 'perpl')
        .map((market) => market.symbol),
    [served.data],
  );
  const controls = useMemo(
    () => def.params.map((spec) => ({ spec, control: controlFor(spec, def.id, perps) })),
    [def, perps],
  );

  // Guardian's defaults (0.05 / 0.01) are placeholders sized for MON: its
  // lines start from the live price instead, until the person sets them.
  // Polled only for Guardian; no other preset reads a price here.
  const guardian = def.id === 'guardian';
  const market = draftMarket(draft);
  const ticker = usePolling(
    guardian && marketsApi && market ? `preset-ticker:kuru:${market}` : null,
    () => marketsApi!.ticker('kuru', market ?? ''),
    { intervalMs: TICKER_MS },
  );
  const livePrice = ticker.data ? (ticker.data.mid ?? ticker.data.last ?? ticker.data.bid) : null;
  const [linesFrom, setLinesFrom] = useState<{ market: string; price: string } | null>(null);
  useEffect(() => {
    if (!guardian || !market || livePrice === null) return;
    if (linesFrom?.market === market) return;
    if (touched.current.has('sellAbove') || touched.current.has('sellBelow')) return;
    const lines = guardianLines(livePrice);
    if (!lines) return;
    setDraft((current) => ({ ...current, ...lines }));
    setLinesFrom({ market, price: livePrice });
  }, [guardian, market, livePrice, linesFrom]);

  const checked = checkParams(def, draft);
  const params: Params | null = checked.ok ? checked.params : null;
  const paramErrors = !checked.ok ? checked.errors : {};
  const cadenceSeconds = params ? def.suggestedCadenceSeconds(params) : null;
  const suggested = params ? def.suggestedMandate(params) : null;

  // ─── Mandate ─────────────────────────────────────────────────────────────
  const returnTo = wallet.address;
  const [form, setForm] = useState<MandateForm>(() => defaultMandateForm(nowSeconds()));
  const [expiryDays, setExpiryDays] = useState<number | null>(7);
  const [tier, setTier] = useState<PresetChoice>('standard');
  /** The params the mandate was last prefilled from; new params prefill it again. */
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);

  useEffect(() => {
    if (!returnTo) return;
    setForm((current) => (current.returnTo === returnTo ? current : { ...current, returnTo }));
  }, [returnTo]);

  const prefillMandate = () => {
    if (!params || !suggested) return;
    const key = JSON.stringify(params);
    if (key === prefilledFor) return;
    const values = suggestedValues(suggested, nowSeconds(), returnTo ?? undefined);
    setForm(values.form);
    setExpiryDays(values.expiryDays);
    setTier(suggested.tier);
    setPrefilledFor(key);
  };

  const patch = (change: Partial<MandateForm>) => {
    setForm((current) => ({ ...current, ...change }));
    setTier('custom');
  };
  const chooseExpiry = (days: number | null) => {
    setExpiryDays(days);
    setTier('custom');
  };
  /** A tier chip keeps the preset's venues and markets; only the limits move. */
  const chooseTier = (choice: PresetChoice) => {
    setTier(choice);
    if (choice === 'custom' || !suggested) return;
    const values = tierValues(choice, suggested, nowSeconds(), form.returnTo);
    setForm(values.form);
    setExpiryDays(values.expiryDays);
  };

  const expiresAt = resolveExpiry(form, expiryDays, nowSeconds());
  const mandateResult = mandateToSend(form, expiryDays, nowSeconds());
  const mandateErrors: MandateErrors = showErrors && !mandateResult.ok ? mandateResult.errors : {};

  // ─── Review ──────────────────────────────────────────────────────────────
  const [name, setName] = useState(() => defaultAgentName(def.id, def.name));
  const [model, setModel] = useState<string>(AGENT_MODELS[0].id);
  const assets = suggested ? fundingAssets(suggested) : ['USDC'];
  const fundOptions = FUNDING_TOKENS.filter((token) => assets.includes(token.symbol));
  const [fundSymbol, setFundSymbol] = useState<string | null>(null);
  const fundToken =
    fundOptions.find((token) => token.symbol === fundSymbol) ?? fundOptions[0] ?? FUNDING_TOKENS[0];
  const [fundAmount, setFundAmount] = useState<string | null>(null);
  const amountText =
    fundAmount ?? (params && suggested ? suggestedFunding(def.id, params, suggested) : '');
  const [available, setAvailable] = useState<bigint | null>(null);
  const from = wallet.address;

  useEffect(() => {
    if (step !== 'review' || !from || !fundToken) return;
    let cancelled = false;
    setAvailable(null);
    readBalance(fundToken, from).then(
      (balance) => {
        if (!cancelled) setAvailable(balance);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [step, fundToken, from]);

  const fundAtoms =
    fundToken && amountText.trim() !== '' ? parseAmount(amountText, fundToken.decimals) : 0n;
  const fundInvalid = fundAtoms === null;
  const fundTooMuch = fundAtoms !== null && available !== null && fundAtoms > available;
  const walletId = wallet.wallet?.walletId;
  const funding = fundAtoms !== null && fundAtoms > 0n;
  const walletReady = wallet.status === 'ready' && walletId !== undefined;
  const schedule = cadenceSeconds !== null ? scheduleFor(cadenceSeconds) : null;

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ErrorCopy | null>(null);
  const [hired, setHired] = useState<{ result: HireAgentResult; fund: FundOutcome | null } | null>(
    null,
  );
  /** SEN-188: the pinning amend after the hire, and the mandate it keeps. */
  const [pin, setPin] = useState<DepositPinState | null>(null);
  const [hiredMandate, setHiredMandate] = useState<AgentMandate | null>(null);

  const stepValid = (id: StepId): boolean => {
    switch (id) {
      case 'strategy':
        return params !== null;
      case 'mandate':
        return mandateResult.ok;
      case 'review':
        return (
          params !== null &&
          mandateResult.ok &&
          name.trim().length > 0 &&
          name.length <= AGENT_LIMITS.name &&
          !fundInvalid &&
          !fundTooMuch &&
          (!funding || walletReady)
        );
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
    if (step === 'strategy') prefillMandate();
    setIndex(index + 1);
  };

  const fund = async (address: HireAgentResult['agent']['address']): Promise<FundOutcome> => {
    if (!fundToken || fundAtoms === null || fundAtoms === 0n || walletId === undefined) {
      return { tone: 'info', title: 'Not funded yet' };
    }
    const label = `${formatAtoms(fundAtoms, fundToken.decimals)} ${fundToken.symbol}`;
    try {
      const sent = await sendSponsored(
        walletApi,
        { walletId, token: fundToken, to: address, atoms: fundAtoms },
        auth.signPrivyAuthorization,
      );
      const status = sent.confirmation?.status ?? sent.status;
      if (status === 'included') return { tone: 'ok', title: `Sent ${label}` };
      if (status === 'reverted') {
        // Gotcha 8: reverted inside a transaction that may well have landed.
        // Nothing moved, and the screen must not say otherwise.
        return {
          tone: 'error',
          title: 'The transfer reverted',
          detail: 'It was included on chain but didn’t execute, so nothing moved.',
        };
      }
      return {
        tone: 'info',
        title: `Sending ${label}`,
        detail: `Submitted, not confirmed yet (${status}). The balance updates once it lands.`,
      };
    } catch (error) {
      return { tone: 'error', ...describeSendError(error) };
    }
  };

  const secure = (agent: HireAgentResult['agent'], mandate: AgentMandate) =>
    api
      ? secureDeposits({
          api,
          agent,
          mandate,
          ownWallet: returnTo,
          sign: auth.signPrivyAuthorization,
        })
      : Promise.resolve<DepositPinState>({
          kind: 'failed',
          title: 'Sign in first',
          detail: 'Agents belong to your passkey account.',
        });

  const retrySecure = async () => {
    if (!hired || !hiredMandate || pin?.kind === 'securing') return;
    setPin({ kind: 'securing' });
    setPin(await secure(hired.result.agent, hiredMandate));
  };

  const submit = async () => {
    if (!api || !params || !mandateResult.ok || !stepValid('review')) {
      setShowErrors(true);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const mandate = mandateResult.mandate;
      const result = await api.hire(
        presetHireRequest(def, draft, params, { name, model, mandate }),
      );
      // The agent exists from here on; a failed pin or transfer is reported on
      // the hired screen, never as a failed hire.
      setHiredMandate(mandate);
      if (needsDepositPin(result.agent)) {
        // SEN-188: pin its Kuru deposits to its own wallet before anything else.
        setHired({ result, fund: null });
        setPin({ kind: 'securing' });
        setPin(await secure(result.agent, mandate));
      }
      const funded = funding ? await fund(result.agent.address) : null;
      setHired({ result, fund: funded });
    } catch (error) {
      if (error instanceof AgentsApiError && error.reason === 'preset_invalid') {
        // SEN-160: the catalog may have moved since this screen loaded it.
        // Ask again; the draft stays, now checked against what came back.
        reload();
      }
      setSubmitError(describeAgentsError(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (hired) {
    return (
      <Hired
        result={hired.result}
        fund={hired.fund}
        pin={pin}
        onSecure={() => void retrySecure()}
      />
    );
  }

  const primary =
    step === 'review' ? (
      <>
        <Button
          label={`Hire ${name.trim() || 'agent'}`}
          kind="primary"
          {...(funding ? { icon: 'key' as const } : {})}
          busy={submitting}
          disabled={!api}
          onPress={() => void submit()}
        />
        <Text style={[text.caption, styles.disclose]}>
          {funding && fundToken && fundAtoms !== null
            ? `Your passkey approves sending ${formatAtoms(fundAtoms, fundToken.decimals)} ${fundToken.symbol} to ${name.trim() || 'the agent'}’s new wallet once it is created. You can return funds or revoke at any time.`
            : 'Hiring creates the agent’s wallet with this mandate attached. It starts empty: fund it from the agent’s page.'}
        </Text>
      </>
    ) : (
      <Button
        label={step === 'strategy' ? 'Draw the lines' : 'Review the hire'}
        kind="primary"
        onPress={next}
      />
    );

  const footer =
    step === 'strategy' ? (
      <>
        <Text style={[text.voice, styles.readBack]}>
          {params
            ? `“${readBackParams(def, params)}”`
            : (Object.values(paramErrors)[0] ?? 'Check the settings above.')}
        </Text>
        {primary}
      </>
    ) : step === 'mandate' ? (
      <>
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
        <Text style={text.caption}>{def.name}</Text>
        <View style={styles.stepBarSpacer} />
      </View>
      <View style={styles.rail} accessibilityElementsHidden importantForAccessibility="no">
        {STEPS.map((id, i) => (
          <View key={id} style={[styles.railSegment, i <= index && styles.railOn]} />
        ))}
      </View>
      <View style={styles.stepNames}>
        {STEPS.map((id, i) => (
          <Text key={id} style={[text.caption, i === index && styles.stepNameOn]}>
            {STEP_NAMES[id]}
          </Text>
        ))}
      </View>

      {step === 'strategy' ? (
        <>
          <Text style={[text.display, styles.title]}>Set how it plays</Text>
          {guardian ? (
            <Text style={[text.caption, styles.after]}>
              {linesFrom
                ? `Lines start 10% either side of ${linesFrom.market} at ${linesFrom.price}. Set your own.`
                : 'Waiting for a live price to start the lines from. Until then they are placeholders: set your own.'}
            </Text>
          ) : null}
          {controls.map(({ spec, control }) => (
            <ParamField
              key={spec.key}
              spec={spec}
              control={control}
              value={draft[spec.key]}
              onChange={(value) => setParam(spec.key, value)}
              error={
                showErrors || touched.current.has(spec.key) ? paramErrors[spec.key] : undefined
              }
            />
          ))}
        </>
      ) : null}

      {step === 'mandate' ? (
        <>
          <Text style={[text.display, styles.title]}>Draw the lines</Text>
          <Text style={[text.dim, styles.subtitle]}>
            The strategy is advice. These are limits: the enclave won’t sign anything outside them,
            however the agent is prompted.
          </Text>
          <MandateStep
            form={form}
            patch={patch}
            errors={mandateErrors}
            expiresAt={expiresAt}
            expiryDays={expiryDays}
            setExpiryDays={chooseExpiry}
            preset={tier}
            choosePreset={chooseTier}
            canKeepExpiry={false}
          />
          {suggested ? (
            <Text style={[text.caption, styles.after]}>
              Suggested · {def.name} was written for {TIER_LABEL[suggested.tier]}, narrowed to its
              markets and sized for its orders.
            </Text>
          ) : null}
          {suggested && suggested.softRules.length > 0 ? (
            <SoftRules rules={suggested.softRules} />
          ) : null}
        </>
      ) : null}

      {step === 'review' && params ? (
        <>
          <Field
            label="Name"
            value={name}
            onChangeText={setName}
            max={AGENT_LIMITS.name}
            placeholder="Name your agent"
            autoCapitalize="words"
            error={showErrors && name.trim() === '' ? 'Give the agent a name.' : undefined}
          />

          <Section
            label={def.name}
            aside={
              <Text style={[text.caption, styles.link]} onPress={() => setIndex(0)}>
                Edit
              </Text>
            }
          >
            <Card>
              <Text style={[text.voice, styles.reviewVoice]}>{readBackParams(def, params)}</Text>
              {controls
                .filter(({ control }) => control.level !== undefined)
                .map(({ spec, control }) => (
                  <LevelRow
                    key={spec.key}
                    label={spec.label}
                    value={formatParam(spec, params[spec.key])}
                    level={control.level as LevelKind}
                  />
                ))}
              <Row
                label="Mandate"
                value={mandateResult.ok ? readBack(form, expiresAt) : 'Not valid yet'}
              />
            </Card>
          </Section>

          {suggested && suggested.softRules.length > 0 ? (
            <SoftRules rules={suggested.softRules} />
          ) : null}

          <Section label="Model">
            <Segmented
              options={AGENT_MODELS.map((option) => ({ value: option.id, label: option.label }))}
              value={model}
              onChange={setModel}
            />
          </Section>

          <Section label="Runs">
            {cadenceSeconds !== null && schedule ? (
              <Text style={text.dim}>
                {cadenceLabel(cadenceSeconds)} · {runsLabel(cadenceSeconds)}. Each run is billed to
                your OpenRouter credits.
              </Text>
            ) : (
              <Notice
                title="It won’t run on its own"
                detail={`${cadenceSeconds !== null ? cadenceLabel(cadenceSeconds) : 'This cadence'} is outside what agents can be scheduled at (once a minute to once a week), so it is hired without a schedule. Start each run from its page.`}
              />
            )}
          </Section>

          <Section
            label="Fund now"
            aside={
              from && fundToken ? (
                <Text style={[text.caption, text.num]}>
                  {available === null ? '…' : formatAtoms(available, fundToken.decimals)}{' '}
                  {fundToken.symbol} available
                </Text>
              ) : undefined
            }
          >
            {fundOptions.length > 1 ? (
              <Chips>
                {fundOptions.map((token) => (
                  <Chip
                    key={token.symbol}
                    label={token.symbol}
                    selected={token.symbol === fundToken?.symbol}
                    onPress={() => {
                      setFundSymbol(token.symbol);
                      setFundAmount('');
                    }}
                  />
                ))}
              </Chips>
            ) : null}
            <Field
              label="Amount"
              value={amountText}
              onChangeText={setFundAmount}
              keyboardType="decimal-pad"
              {...(fundToken ? { suffix: fundToken.symbol } : {})}
              placeholder="0"
              error={
                fundInvalid
                  ? `Enter an amount with at most ${fundToken?.decimals ?? 0} decimals.`
                  : fundTooMuch
                    ? 'More than your account holds.'
                    : undefined
              }
              hint={fundHint(
                def.id,
                fundOptions.map((token) => token.symbol),
              )}
            />
            {funding && !walletReady ? (
              <Notice
                tone="error"
                title="Your wallet isn’t ready"
                detail={
                  wallet.error?.message ??
                  'Sign in on the home screen and wait for it to register, or hire with 0 and fund it later.'
                }
              />
            ) : null}
          </Section>

          {!returnTo ? (
            <Notice
              tone="error"
              title="No way back for funds yet"
              detail="Your wallet hasn’t registered, so this mandate would compile with no return address. Wait for it on the home screen first."
            />
          ) : null}
          {!api ? (
            <Notice title="Sign in first" detail="Agents belong to your passkey account." />
          ) : null}
          {submitError ? (
            <Notice tone="error" title={submitError.title} detail={submitError.detail} />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

function fundHint(presetId: string, symbols: string[]): string {
  if (presetId === 'guardian') return 'The coins it guards. It never sells more than you hand it.';
  if (symbols.length > 1) {
    return `It trades with ${symbols.join(' and ')}. This sends one; send the other from its page.`;
  }
  return `It trades with ${symbols[0] ?? 'USDC'}. You can add more or take it back later.`;
}

// ─── Strategy controls ──────────────────────────────────────────────────────

function ParamField({
  spec,
  control,
  value,
  onChange,
  error,
}: {
  spec: ParamSpec;
  control: ParamControl;
  value: Draft[string] | undefined;
  onChange: (value: Draft[string]) => void;
  error: string | undefined;
}) {
  const head = (
    <View style={styles.paramHead}>
      <Text style={text.strong}>{control.label}</Text>
      {control.kind === 'slider' ? (
        <Text style={[text.strong, text.num]}>{formatParam(spec, value)}</Text>
      ) : null}
    </View>
  );
  const foot = (
    <>
      {control.level ? <LevelNote level={control.level} /> : null}
      {control.help && !isLevelHelp(control.help) ? (
        <Text style={text.caption}>{control.help}</Text>
      ) : null}
      {error ? <Text style={[text.dim, text.danger]}>{error}</Text> : null}
    </>
  );

  switch (control.kind) {
    case 'segmented':
    case 'chips': {
      const current = String(value);
      const pick = (next: string) => onChange(spec.type === 'number' ? Number(next) : next);
      return (
        <View style={styles.param}>
          {head}
          {control.kind === 'segmented' ? (
            <Segmented options={control.options} value={current} onChange={pick} />
          ) : (
            <Chips>
              {control.options.map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  selected={option.value === current}
                  onPress={() => pick(option.value)}
                />
              ))}
            </Chips>
          )}
          {foot}
        </View>
      );
    }
    case 'market': {
      const chosen = Array.isArray(value) ? value : [String(value)];
      const toggle = (symbol: string) => {
        if (!control.multiple) return onChange(symbol);
        onChange(
          chosen.includes(symbol) ? chosen.filter((m) => m !== symbol) : [...chosen, symbol],
        );
      };
      return (
        <View style={styles.param}>
          {head}
          <Chips>
            {control.options.map((symbol) => (
              <Chip
                key={symbol}
                label={symbol}
                selected={chosen.includes(symbol)}
                onPress={() => toggle(symbol)}
              />
            ))}
          </Chips>
          {foot}
        </View>
      );
    }
    case 'toggle':
      return (
        <View style={styles.param}>
          <ToggleRow
            title={control.label}
            value={value === true}
            onValueChange={(next) => onChange(next)}
          />
          {foot}
        </View>
      );
    case 'slider':
      return (
        <View style={styles.param}>
          {head}
          <Slider
            value={typeof value === 'number' ? value : control.min}
            min={control.min}
            max={control.max}
            step={control.step}
            label={control.label}
            onChange={onChange}
          />
          {foot}
        </View>
      );
    case 'amount':
      return (
        <View style={styles.param}>
          <Field
            label={control.label}
            value={typeof value === 'number' ? String(value) : String(value ?? '')}
            onChangeText={onChange}
            keyboardType="decimal-pad"
            {...(control.unit ? { suffix: control.unit } : {})}
            placeholder="0"
            error={error}
          />
          {control.level ? <LevelNote level={control.level} /> : null}
          {control.help && !isLevelHelp(control.help) ? (
            <Text style={text.caption}>{control.help}</Text>
          ) : null}
        </View>
      );
  }
}

/** The package's own help repeats the level note; show it once, as the tag. */
function isLevelHelp(help: string): boolean {
  return help.startsWith('Agent-watched') || help.startsWith('Rests on');
}

/** A thumb-sized slider on the spec's grid: tap or drag the track, or nudge a step. */
function Slider({
  value,
  min,
  max,
  step,
  label,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  onChange: (value: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const fraction = max > min ? (value - min) / (max - min) : 0;
  const at = (event: GestureResponderEvent) => {
    if (width <= 0) return;
    const x = Math.min(width, Math.max(0, event.nativeEvent.locationX));
    const next = snapToStep(min + (x / width) * (max - min), min, max, step);
    if (next !== value) onChange(next);
  };
  const nudge = (direction: 1 | -1) =>
    onChange(snapToStep(value + direction * step, min, max, step));
  return (
    <View style={styles.sliderRow}>
      <IconButton icon="back" label={`Lower ${label}`} onPress={() => nudge(-1)} />
      <View
        style={styles.track}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={at}
        onResponderMove={at}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) =>
          nudge(event.nativeEvent.actionName === 'increment' ? 1 : -1)
        }
      >
        <View style={styles.trackLine} pointerEvents="none">
          <View style={[styles.trackFill, { width: `${fraction * 100}%` }]} />
        </View>
        <View
          pointerEvents="none"
          style={[styles.thumb, { left: Math.max(0, fraction * width - THUMB / 2) }]}
        />
      </View>
      <IconButton icon="chevron" label={`Raise ${label}`} onPress={() => nudge(1)} />
    </View>
  );
}

const THUMB = 20;

function LevelNote({ level }: { level: LevelKind }) {
  return (
    <View style={styles.levelNote}>
      <LevelTag level={level} />
      <Text style={text.caption}>{LEVEL_NOTE[level]}</Text>
    </View>
  );
}

function LevelTag({ level }: { level: LevelKind }) {
  const watched = level === 'watched';
  return (
    <View style={[styles.levelTag, watched ? styles.levelWatched : styles.levelResting]}>
      {watched ? <Icon name="stop" size={11} color={color.textDim} strokeWidth={2} /> : null}
      <Text style={[styles.levelText, !watched && styles.levelTextResting]}>
        {LEVEL_TAG[level]}
      </Text>
    </View>
  );
}

function LevelRow({ label, value, level }: { label: string; value: string; level: LevelKind }) {
  return (
    <View style={styles.levelRow}>
      <View style={styles.levelRowLabel}>
        <Text style={text.dim}>{label}</Text>
        <LevelTag level={level} />
      </View>
      <Text style={[text.body, text.num]}>{value}</Text>
    </View>
  );
}

function SoftRules({ rules }: { rules: readonly string[] }) {
  return (
    <Section label="Its own rules">
      {rules.map((rule) => (
        <View key={rule} style={styles.softRule}>
          <Text style={text.body}>{rule[0]?.toUpperCase() + rule.slice(1)}</Text>
          <Text style={text.caption}>{SOFT_RULE_NOTE}</Text>
        </View>
      ))}
    </Section>
  );
}

// ─── Hired ──────────────────────────────────────────────────────────────────

function Hired({
  result,
  fund,
  pin,
  onSecure,
}: {
  result: HireAgentResult;
  fund: FundOutcome | null;
  /** SEN-188: the pinning amend after the hire; `null` when there was nothing to pin. */
  pin: DepositPinState | null;
  onSecure: () => void;
}) {
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
      {pin ? <DepositPinStatus state={pin} onRetry={onSecure} /> : null}
      <Section label="Wallet">
        <Row label="Address" value={shortAddress(agent.address)} mono />
        {fund ? (
          <Notice
            tone={fund.tone}
            title={fund.title}
            {...(fund.detail ? { detail: fund.detail } : {})}
          />
        ) : (
          <Text style={text.dim}>Empty for now. Fund it from the agent’s page.</Text>
        )}
        {fund?.tone === 'error' ? (
          <Text style={[text.dim, styles.after]}>
            The agent exists either way. Fund it from its page when you’re ready.
          </Text>
        ) : null}
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
  stepBar: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepBarSpacer: { width: 36 },
  rail: { flexDirection: 'row', gap: 6, marginTop: 4 },
  railSegment: { flex: 1, height: 3, borderRadius: 3, backgroundColor: color.line },
  railOn: { backgroundColor: color.purple },
  stepNames: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  stepNameOn: { color: color.purpleHi },
  title: { marginTop: 16, fontSize: 28, lineHeight: 32 },
  subtitle: { marginTop: 8 },
  after: { marginTop: 10 },
  readBack: { fontSize: 15, lineHeight: 22, color: color.textDim },
  disclose: { textAlign: 'center' },
  link: { color: color.purpleHi },
  param: { marginTop: 18, gap: 8 },
  paramHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  track: { flex: 1, height: 36, justifyContent: 'center' },
  trackLine: {
    height: 4,
    borderRadius: 2,
    backgroundColor: color.line,
    overflow: 'hidden',
  },
  trackFill: { height: 4, backgroundColor: color.purple },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: color.purpleHi,
    borderWidth: 2,
    borderColor: color.ink,
  },
  levelNote: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  levelTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: RADIUS.stone,
    borderWidth: 1,
  },
  levelWatched: { borderColor: color.lineStrong, borderStyle: 'dashed' },
  levelResting: { borderColor: color.purple, backgroundColor: 'rgba(131, 110, 249, 0.12)' },
  levelText: { fontFamily: font.medium, fontSize: 11, lineHeight: 14, color: color.textDim },
  levelTextResting: { color: color.purpleSoft },
  levelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },
  levelRowLabel: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  reviewVoice: { fontSize: 15, lineHeight: 22, marginBottom: 6 },
  softRule: { marginTop: 8, gap: 2 },
  token: { color: color.text },
});
