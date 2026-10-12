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
import { useEffect, useMemo, useState } from 'react';
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
import { readBalance } from '@/agents/balances';
import { DepositPinStatus } from '@/agents/DepositPin';
import { secureDeposits, type DepositPinState } from '@/agents/depositPin';
import { draftKey } from '@/agents/draftStore';
import { FundingStatus, FundNow } from '@/agents/FundNow';
import { HIRE_DRAFT_CODEC, mergeHireDraft, type HireDraftFields } from '@/agents/hireDraft';
import {
  checkFunding,
  fundAgent,
  fundingLayout,
  fundingRequests,
  fundingTokensFor,
  hireThenFund,
  PERPS_FUND_DEFAULT,
  perpsFundNote,
  type FundingCheck,
  type FundingState,
} from '@/agents/initialFunding';
import { MandateChanges, RulesChange } from '@/agents/MandateChanges';
import { MandateExplainer } from '@/agents/MandateExplainer';
import { MandateStep } from '@/agents/MandateStep';
import { MandateSummary } from '@/agents/MandateSummary';
import {
  defaultMandateForm,
  formFromMandate,
  quoteUnit,
  type MandateErrors,
  type MandateForm,
} from '@/agents/mandate';
import { mandateToSend, presetValues, resolveExpiry, type PresetChoice } from '@/agents/presets';
import { readBack } from '@/agents/readback';
import { RiskCard } from '@/agents/Risks';
import { useDraftRestoreBanner, useDraftSync } from '@/agents/useDraftSync';
import { useSession } from '@/session';
import { API_URL } from '@/wallet/api';
import { sendSponsored } from '@/wallet/send';
import {
  Button,
  Card,
  CopyButton,
  DisclosureRow,
  Field,
  IconButton,
  Loading,
  Notice,
  Row,
  Screen,
  Section,
  SectionLink,
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
        subtitle:
          'Whatever it’s told, the agent can’t trade outside these limits. A secure enclave enforces some; Sente checks the rest before each order.',
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
  const { agents: api, auth, wallet, walletApi } = useSession();

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
  /** SEN-177: "How the limits work", opened from the mandate step. */
  const [explaining, setExplaining] = useState(false);

  const [target, setTarget] = useState<Agent | null>(null);
  const [loadError, setLoadError] = useState<ErrorCopy | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ErrorCopy | null>(null);
  const [hired, setHired] = useState<HireAgentResult | null>(null);
  /**
   * SEN-177: "Fund it now" on the review step, and how it went once hired.
   * Kept as a symbol rather than the full `Token` (SEN-190): a `Token` isn't
   * JSON-stable, so a draft can only ever name it this way, and keeping the
   * same shape here means restoring one needs no extra side channel.
   */
  const [fundSymbol, setFundSymbol] = useState<string | null>(null);
  const [fundAmount, setFundAmount] = useState('');
  const [fundBalance, setFundBalance] = useState<bigint | null>(null);
  /**
   * SEN-198: the AUSD amount beside it when the mandate trades perps. `null`
   * until edited, and then it shows Perpl's minimum, `PERPS_FUND_DEFAULT`.
   */
  const [fundAusdAmount, setFundAusdAmount] = useState<string | null>(null);
  const [fundAusdBalance, setFundAusdBalance] = useState<bigint | null>(null);
  /** One state per transfer asked for, in the order they are sent. */
  const [fundings, setFundings] = useState<FundingState[]>([]);
  /**
   * SEN-188: the pinning amend that follows every hire, and the mandate it
   * keeps — the one sent at hire, not a recomputed form (its expiry is
   * resolved against the clock).
   */
  const [pin, setPin] = useState<DepositPinState | null>(null);
  const [hiredMandate, setHiredMandate] = useState<AgentMandate | null>(null);
  /** SEN-177: the risk tick that gates Hire and Fork (not an amend). */
  const [risksAccepted, setRisksAccepted] = useState(false);
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
        // SEN-124: the stored mandate's `returnTo` came from the server, so it
        // is dropped rather than carried: the form only ever holds the live
        // wallet's address, and none at all until the wallet has registered.
        const { returnTo: _stored, ...loaded } = formFromMandate(agent.mandate);
        setForm({ ...loaded, ...(returnTo ? { returnTo } : {}) });
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

  // Funding at hire: a new agent (hire or fork) whose mandate can use a token,
  // from a wallet that is ready to send. Never on an amend.
  const walletId = wallet.wallet?.walletId;
  const fundTokens = !amend && mandateResult.ok ? fundingTokensFor(mandateResult.mandate) : [];
  const canFund = fundTokens.length > 0 && wallet.address !== null && walletId !== undefined;
  // SEN-198: with Perpl in the mandate, AUSD gets its own amount beside the spot one.
  const layout = mandateResult.ok
    ? fundingLayout(mandateResult.mandate, fundTokens)
    : { spot: fundTokens, perps: null };
  const chosenToken =
    layout.spot.find((token) => token.symbol === fundSymbol) ?? layout.spot[0] ?? null;
  const perpsToken = layout.perps;
  const ausdAmount = fundAusdAmount ?? PERPS_FUND_DEFAULT;
  const fundCheck: FundingCheck =
    canFund && chosenToken ? checkFunding(fundAmount, chosenToken, fundBalance) : { kind: 'skip' };
  const ausdCheck: FundingCheck =
    canFund && perpsToken
      ? checkFunding(ausdAmount, perpsToken, fundAusdBalance)
      : { kind: 'skip' };
  const fundingInvalid = fundCheck.kind === 'invalid' || ausdCheck.kind === 'invalid';
  const fundingAsked = [
    ...(chosenToken ? [{ token: chosenToken, check: fundCheck, amount: fundAmount.trim() }] : []),
    ...(perpsToken ? [{ token: perpsToken, check: ausdCheck, amount: ausdAmount.trim() }] : []),
  ].filter((entry) => entry.check.kind === 'ok');
  const startsEmpty = canFund
    ? 'The wallet starts empty unless you fund it here; you can also fund it later from the agent’s page.'
    : 'The wallet starts empty: fund it from the agent’s page.';
  const fundFrom = wallet.address;
  useEffect(() => {
    if (step !== 'review' || !canFund || !chosenToken || !fundFrom) return;
    let cancelled = false;
    setFundBalance(null);
    readBalance(chosenToken, fundFrom).then(
      (balance) => {
        if (!cancelled) setFundBalance(balance);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [step, canFund, chosenToken, fundFrom]);
  useEffect(() => {
    if (step !== 'review' || !canFund || !perpsToken || !fundFrom) return;
    let cancelled = false;
    setFundAusdBalance(null);
    readBalance(perpsToken, fundFrom).then(
      (balance) => {
        if (!cancelled) setFundAusdBalance(balance);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [step, canFund, perpsToken, fundFrom]);

  /**
   * SEN-190: the hire/fork draft. Never on an amend — that edits an existing
   * agent's live mandate, not something typed before the agent exists — and
   * never before the wallet has signed in, since a draft is scoped to it.
   * A fork's draft is kept apart from the blank hire's and from every other
   * source agent's, by `fork`'s own id.
   */
  const draftScopeKey =
    !amend && auth.address
      ? draftKey(auth.address, fork ? { kind: 'fork', source: fork } : { kind: 'hire' })
      : null;

  const draftFields: HireDraftFields = useMemo(
    () => ({
      step,
      name,
      model,
      systemPrompt,
      strategy,
      isPublic,
      preset,
      form,
      expiryDays,
      fundSymbol,
      fundAmount,
      fundAusdAmount,
      risksAccepted,
    }),
    [
      step,
      name,
      model,
      systemPrompt,
      strategy,
      isPublic,
      preset,
      form,
      expiryDays,
      fundSymbol,
      fundAmount,
      fundAusdAmount,
      risksAccepted,
    ],
  );

  const draftSync = useDraftSync(draftScopeKey, draftFields, HIRE_DRAFT_CODEC);

  /** The blank starting point for this mode, used as the merge base and as what Discard resets to. */
  const freshHireDraftFields = (): HireDraftFields => ({
    step: steps[0] ?? 'review',
    name: fork && source ? forkName(source) : '',
    model: AGENT_MODELS[0].id,
    systemPrompt: '',
    strategy: '',
    isPublic: false,
    preset: 'standard',
    form: defaultMandateForm(nowSeconds(), returnTo ?? undefined),
    expiryDays: 7,
    fundSymbol: null,
    fundAmount: '',
    fundAusdAmount: null,
    risksAccepted: false,
  });

  const applyHireDraft = (fields: HireDraftFields) => {
    const stepIndex = steps.indexOf(fields.step);
    setIndex(stepIndex >= 0 ? stepIndex : 0);
    setName(fields.name);
    setModel(fields.model);
    setSystemPrompt(fields.systemPrompt);
    setStrategy(fields.strategy);
    setIsPublic(fields.isPublic);
    setPreset(fields.preset);
    setForm(fields.form);
    setExpiryDays(fields.expiryDays);
    setFundSymbol(fields.fundSymbol);
    setFundAmount(fields.fundAmount);
    setFundAusdAmount(fields.fundAusdAmount ?? null);
    setRisksAccepted(fields.risksAccepted);
    setShowErrors(false);
  };

  const { banner: draftBanner, dismissBanner } = useDraftRestoreBanner(
    draftScopeKey,
    draftSync.restored,
    (restored) => applyHireDraft(mergeHireDraft(freshHireDraftFields(), restored)),
  );

  /** The banner's "Discard": wipe the restored content and start blank. */
  const discardDraft = () => {
    draftSync.discard();
    dismissBanner();
    applyHireDraft(freshHireDraftFields());
  };

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

  /** SEN-177: from the review, back to step 2 with that field focused. */
  const [editing, setEditing] = useState<'systemPrompt' | 'strategy' | null>(null);
  const editInstructions = (field: 'systemPrompt' | 'strategy') => {
    setShowErrors(false);
    setEditing(field);
    setIndex(steps.indexOf('instructions'));
  };

  const next = () => {
    if (!stepValid(step)) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setEditing(null);
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
      } else {
        // No strategy, prompt or model in a fork's body: the API takes them
        // from the source agent, under the name sent here.
        const hire = fork
          ? () =>
              api.fork(fork, {
                mandate: result.mandate,
                ...(name.trim() !== '' ? { name: name.trim() } : {}),
                riskAcknowledged: risksAccepted,
              })
          : () =>
              api.hire({
                name: name.trim(),
                systemPrompt,
                strategy,
                model,
                mandate: result.mandate,
                public: isPublic,
                riskAcknowledged: risksAccepted,
              });
        // SEN-177: hire, then fund through the Fund sheet's own path. The
        // hired screen shows at once; a funding failure never undoes the hire.
        // SEN-188: between the two, the amend that pins the agent's Kuru
        // deposits to its own wallet, with the mandate just sent.
        setHiredMandate(result.mandate);
        await hireThenFund({
          hire,
          funding: fundingRequests(fundingAsked),
          fund: (to, token, atoms) =>
            walletId === undefined
              ? Promise.reject(new Error('Your wallet isn’t ready.'))
              : fundAgent(
                  (intent) => sendSponsored(walletApi, intent, auth.signPrivyAuthorization),
                  { walletId, token, to, atoms },
                ),
          // SEN-190: the agent exists now — a pending debounced save from the
          // moment before this must never write the draft back afterwards.
          onHired: (hireResult) => {
            draftSync.clear();
            setHired(hireResult);
          },
          onFunding: (index, state) =>
            setFundings((current) => {
              const next = [...current];
              next[index] = state;
              return next;
            }),
          secure: (agent) => secure(agent, result.mandate),
          onSecure: setPin,
        });
      }
    } catch (error) {
      setSubmitError(describeAgentsError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const secure = (agent: Agent, mandate: AgentMandate) =>
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

  /** "Secure deposits" on the hired screen: the same amend again. */
  const retrySecure = async () => {
    if (!hired || !hiredMandate || pin?.kind === 'securing') return;
    setPin({ kind: 'securing' });
    setPin(await secure(hired.agent, hiredMandate));
  };

  const approve = async () => {
    if (!api || !target || !pending) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // SEN-124: the phone's own wallet, not the mandate's `returnTo`, is what
      // the way out is checked against; `null` (not registered yet) is refused.
      await amendMandateWithApproval(
        api,
        target,
        pending.mandate,
        returnTo,
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

  if (hired) {
    return (
      <Hired
        result={hired}
        pin={pin}
        onSecure={() => void retrySecure()}
        fundings={fundings}
        requests={fundingAsked.map(({ token, amount }) => ({ token: token.symbol, amount }))}
      />
    );
  }

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
      disabled={!mandateResult.ok || fundingInvalid || (mode !== 'amend' && !risksAccepted)}
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
      {draftBanner ? (
        <View style={styles.draftBanner}>
          <Notice title="Draft restored" detail="Picked up where you left off.">
            <SectionLink label="Discard" onPress={discardDraft} />
          </Notice>
        </View>
      ) : null}
      {step === 'mandate' ? (
        <View style={styles.explain}>
          <SectionLink label="How the limits work" onPress={() => setExplaining(true)} />
          <MandateExplainer visible={explaining} onClose={() => setExplaining(false)} />
        </View>
      ) : null}

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
            autoFocus={editing === 'systemPrompt'}
            multiline
            max={AGENT_LIMITS.systemPrompt}
            placeholder="Who the agent is and how it should behave."
          />
          <Field
            label="Strategy"
            value={strategy}
            onChangeText={setStrategy}
            autoFocus={editing === 'strategy'}
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
                <DisclosureRow
                  label="System prompt"
                  value={`${systemPrompt.length.toLocaleString('en-US')} characters`}
                >
                  <Text style={[text.body, styles.readText]} selectable>
                    {systemPrompt.trim() || 'Empty.'}
                  </Text>
                  <SectionLink label="Edit" onPress={() => editInstructions('systemPrompt')} />
                </DisclosureRow>
                <DisclosureRow
                  label="Strategy"
                  value={`${strategy.length.toLocaleString('en-US')} characters`}
                >
                  <Text style={[text.body, styles.readText]} selectable>
                    {strategy.trim() || 'Empty.'}
                  </Text>
                  <SectionLink label="Edit" onPress={() => editInstructions('strategy')} />
                </DisclosureRow>
                <Row label="Prompt" value={isPublic ? 'Published' : 'Private'} />
              </Card>
            </Section>
          ) : null}
          <Section label="Mandate">
            {mandateResult.ok ? <MandateSummary mandate={mandateResult.mandate} /> : null}
          </Section>
          {canFund && (chosenToken || perpsToken) ? (
            <FundNow
              tokens={layout.spot}
              setToken={(token) => setFundSymbol(token.symbol)}
              spot={
                chosenToken
                  ? {
                      token: chosenToken,
                      amount: fundAmount,
                      setAmount: setFundAmount,
                      balance: fundBalance,
                      check: fundCheck,
                    }
                  : null
              }
              perps={
                perpsToken
                  ? {
                      token: perpsToken,
                      amount: ausdAmount,
                      setAmount: setFundAusdAmount,
                      balance: fundAusdBalance,
                      check: ausdCheck,
                    }
                  : null
              }
              perpsNote={perpsFundNote(ausdCheck)}
            />
          ) : null}
          <Text style={[text.dim, styles.after]}>
            {amend
              ? 'Saving replaces the wallet’s signing policy. Until that succeeds, the current mandate stands.'
              : fork
                ? `Forking creates your own agent with this policy attached. The strategy carries over; the source’s wallet, prompt and mandate do not. ${startsEmpty}`
                : `Hiring creates the agent’s wallet with this policy attached. ${startsEmpty}`}
          </Text>
          {amend ? null : (
            <View style={styles.risks}>
              <RiskCard
                accepted={risksAccepted}
                onToggle={() => setRisksAccepted(!risksAccepted)}
              />
            </View>
          )}
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

/**
 * SEN-177: what to do next, in the order people need it. Funding comes first
 * because a new agent's wallet is empty and can trade nothing; the MCP token is
 * an optional, advanced extra, so it sits below, explained before it is shown.
 */
function Hired({
  result,
  pin,
  onSecure,
  fundings,
  requests,
}: {
  result: HireAgentResult;
  /** SEN-188: the pinning amend after the hire; `null` when there was nothing to pin. */
  pin: DepositPinState | null;
  onSecure: () => void;
  /** The fundings that followed the hire, in order; empty when none was asked for. */
  fundings: readonly FundingState[];
  /** What was asked, index for index, so a retry opens the Fund sheet prefilled. */
  requests: readonly { token: string; amount: string }[];
}) {
  const router = useRouter();
  const { agent, mcpToken } = result;
  // A retry opens the Fund sheet on the first transfer that failed.
  const failed = fundings.findIndex((state) => state.kind === 'failed');
  const retry = failed >= 0 ? requests[failed] : undefined;
  const open = (sheet?: 'fund') =>
    router.replace({
      pathname: '/agents/[id]',
      params: sheet ? { id: agent.id, sheet, ...(retry ?? {}) } : { id: agent.id },
    });
  // Funded, or on its way: going to the agent is what is left to do.
  const funded = fundings.length > 0 && failed < 0;
  const endpoint = `${API_URL.replace(/\/+$/, '')}/mcp`;
  const config = JSON.stringify(
    {
      mcpServers: {
        sente: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${mcpToken}` } },
      },
    },
    null,
    2,
  );
  return (
    <Screen
      footer={
        <View style={styles.hiredActions}>
          {funded ? (
            <Button label={`Go to ${agent.name}`} kind="primary" onPress={() => open()} />
          ) : (
            <>
              <Button label={`Fund ${agent.name}`} kind="primary" onPress={() => open('fund')} />
              <Button label={`Go to ${agent.name}`} kind="secondary" onPress={() => open()} />
            </>
          )}
        </View>
      }
    >
      <TopBar />
      <Text style={text.display}>{agent.name} is hired</Text>
      {pin ? <DepositPinStatus state={pin} onRetry={onSecure} /> : null}
      {fundings.length > 0 ? (
        fundings.map((state, index) => (
          <FundingStatus key={index} state={state} onRetry={() => open('fund')} />
        ))
      ) : (
        <Text style={[text.dim, styles.subtitle]}>
          Its wallet starts empty. Fund it with what it trades, {quoteUnit(agent.mandate)}, so it
          has something to work with.
        </Text>
      )}
      <Section label="Its wallet" aside={<CopyButton value={agent.address} />}>
        <Text style={text.mono} selectable>
          {agent.address}
        </Text>
      </Section>

      <Section label="Connect your own AI client · optional">
        <Text style={text.dim}>
          Sente runs {agent.name} for you, so you can skip this. To drive it from your own AI client
          instead, such as Claude Code or any MCP client, connect that client to Sente’s MCP server
          with the token below. It gets the same tools {agent.name} uses, held to the same mandate.
        </Text>
        <Card>
          <Row label="Server" value={endpoint} mono />
          <View style={styles.tokenHead}>
            <Text style={text.label}>Token · shown once</Text>
            <CopyButton value={mcpToken} />
          </View>
          <Text style={[text.mono, styles.token]} selectable>
            {mcpToken}
          </Text>
          <Text style={[text.caption, styles.after]}>
            Sente keeps only a hash of it, so it can’t show it again. Send it as{' '}
            <Text style={text.mono}>Authorization: Bearer …</Text>. Revoking the agent cuts it off.
          </Text>
        </Card>
        <View style={styles.tokenHead}>
          <Text style={text.caption}>As a JSON config, e.g. Claude Code’s .mcp.json:</Text>
          <CopyButton value={config} />
        </View>
        <Card>
          <Text style={[text.mono, styles.token]} selectable>
            {config}
          </Text>
        </Card>
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
  draftBanner: { marginTop: 14 },
  readText: { color: color.textDim },
  explain: { marginTop: 10, alignSelf: 'flex-start' },
  readBack: { fontSize: 15, lineHeight: 22, color: color.textDim },
  token: { color: color.text },
  tokenHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 14,
    marginBottom: 8,
  },
  hiredActions: { gap: 10 },
  risks: { marginTop: 18 },
  sheetLead: { marginTop: 6, marginBottom: 8 },
  approvalActions: { marginTop: 16, gap: 10 },
});
