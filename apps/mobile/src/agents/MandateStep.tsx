/**
 * "Draw the lines": the hire flow's mandate step (SEN-59), shared by hire,
 * amend and fork.
 *
 * Presets come first because most people want Standard; each one only fills
 * the form below (`presets.ts`), and touching any field afterwards turns the
 * chip to Custom. Venues are cards, and a venue's own fields — Kuru's markets
 * and deposit caps, Perpl's collateral, markets and leverage — appear only
 * once it is picked. Every validation message is still `buildMandate`'s, shown
 * next to the field that caused it.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/ui/icons';
import { Chip, Chips, Field, Section, Segmented } from '@/ui/kit';
import { color, RADIUS, text } from '@/ui/theme';

import { AGENT_LIMITS } from './api';
import {
  AUSD,
  EXPIRY_PRESETS_DAYS,
  formatExpiry,
  KURU_MARKETS,
  relevantDepositTokens,
  type MandateErrors,
  type MandateForm,
} from './mandate';
import { PRESET_CHOICES, type PresetChoice } from './presets';
import { orderUnit } from './readback';

/** `current` keeps an amended mandate's own expiry: `expiryDays === null`. */
type ExpiryOption = 'current' | `${number}`;

export function MandateStep({
  form,
  patch,
  errors,
  expiresAt,
  expiryDays,
  setExpiryDays,
  preset,
  choosePreset,
  canKeepExpiry,
  fork,
}: {
  form: MandateForm;
  /** Edits the form; the screen turns the preset chip to Custom. */
  patch: (change: Partial<MandateForm>) => void;
  errors: MandateErrors;
  /** `resolveExpiry`'s answer, computed once by the screen. */
  expiresAt: number;
  expiryDays: number | null;
  setExpiryDays: (days: number | null) => void;
  preset: PresetChoice;
  choosePreset: (choice: PresetChoice) => void;
  /** Amending: offer "Current", which leaves the stored expiry alone. */
  canKeepExpiry: boolean;
  /** Set only when forking (SEN-28): the source's name, and the copy's name. */
  fork?: { source: string; name: string; setName: (value: string) => void } | undefined;
}) {
  const toggleMarket = (address: MandateForm['kuruMarkets'][number]) =>
    patch({
      kuruMarkets: form.kuruMarkets.includes(address)
        ? form.kuruMarkets.filter((market) => market !== address)
        : [...form.kuruMarkets, address],
    });

  const depositTokens = relevantDepositTokens(form.kuruMarkets);
  // One quote token fits in the field; with both venues the hint says which is which.
  const unit = form.kuru !== form.perpl ? orderUnit(form) : undefined;
  const expiryOptions: { value: ExpiryOption; label: string }[] = [
    ...(canKeepExpiry ? [{ value: 'current' as const, label: 'Current' }] : []),
    ...EXPIRY_PRESETS_DAYS.map((days) => ({
      value: `${days}` as const,
      label: days === 1 ? '1 day' : `${days} days`,
    })),
  ];

  return (
    <>
      {fork ? (
        <Section label="Your copy">
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

      <View style={styles.presets}>
        <Chips>
          {PRESET_CHOICES.map((choice) => (
            <Chip
              key={choice.value}
              label={choice.label}
              selected={preset === choice.value}
              onPress={() => choosePreset(choice.value)}
            />
          ))}
        </Chips>
      </View>

      <Section label="Where it trades">
        <View style={styles.venues}>
          <VenueCard
            title="Kuru"
            detail="Spot order book"
            on={form.kuru}
            onPress={() => patch({ kuru: !form.kuru })}
          />
          <VenueCard
            title="Perpl"
            detail="Perps, with leverage"
            on={form.perpl}
            onPress={() => patch({ perpl: !form.perpl })}
          />
        </View>
        {errors.venues ? <Text style={[text.dim, text.danger]}>{errors.venues}</Text> : null}
        {form.kuru ? (
          <View style={styles.markets}>
            <Chips>
              {KURU_MARKETS.map((market) => (
                <Chip
                  key={market.address}
                  label={market.symbol}
                  selected={form.kuruMarkets.includes(market.address)}
                  onPress={() => toggleMarket(market.address)}
                />
              ))}
            </Chips>
            {errors.kuruMarkets ? (
              <Text style={[text.dim, text.danger]}>{errors.kuruMarkets}</Text>
            ) : null}
          </View>
        ) : null}
      </Section>

      {form.kuru && depositTokens.length > 0 ? (
        <Section label="Kuru deposit caps">
          <Text style={text.dim}>
            The most one deposit may move into Kuru, per token. Leave a token blank and the agent
            can’t deposit it.
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
            hint="The most one transfer may move into Perpl. At least 100: opening the agent’s Perpl account takes 100 AUSD."
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

      <Field
        label="Largest single order"
        value={form.maxOrderNotional}
        onChangeText={(maxOrderNotional) => patch({ maxOrderNotional })}
        keyboardType="decimal-pad"
        placeholder="0"
        {...(unit ? { suffix: unit } : {})}
        error={errors.maxOrderNotional}
        hint="Notional, in the market’s quote token: USDC on Kuru, AUSD on Perpl."
      />

      <Section label="Mandate ends">
        <Segmented
          options={expiryOptions}
          value={expiryDays === null ? 'current' : `${expiryDays}`}
          onChange={(value) => setExpiryDays(value === 'current' ? null : Number(value))}
        />
        <Text style={[text.dim, text.num, styles.after]}>Ends {formatExpiry(expiresAt)}</Text>
        {errors.expiresAt ? <Text style={[text.dim, text.danger]}>{errors.expiresAt}</Text> : null}
      </Section>
    </>
  );
}

/** A venue as a card you pick, not a switch: the mockup's "Where it trades". */
function VenueCard({
  title,
  detail,
  on,
  onPress,
}: {
  title: string;
  detail: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={({ pressed }) => [styles.venue, on && styles.venueOn, pressed && styles.pressed]}
    >
      <View style={styles.venueHead}>
        <Text style={text.strong}>{title}</Text>
        {on ? <Icon name="check" size={18} color={color.purpleHi} /> : null}
      </View>
      <Text style={text.caption}>{detail}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  presets: { marginTop: 18 },
  venues: { flexDirection: 'row', gap: 10 },
  venue: {
    flex: 1,
    gap: 4,
    padding: 14,
    minHeight: 72,
    borderRadius: RADIUS.well,
    borderWidth: 1,
    borderColor: color.lineStrong,
  },
  venueOn: { borderColor: color.purple, backgroundColor: 'rgba(131, 110, 249, 0.1)' },
  venueHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pressed: { opacity: 0.7 },
  markets: { marginTop: 8, gap: 8 },
  after: { marginTop: 10 },
});
