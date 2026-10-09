/**
 * Account's "Profile" (SEN-172): your face and name, and the controls to
 * change either. The face steps through a sequence of re-rolls (previous /
 * new / original); the name is free text under `rules.ts`, or a rolled one.
 * Every change is optimistic through `useProfile` and a refusal is shown
 * under the controls. Enter in the name field saves, so it works from a
 * keyboard on web.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useSession } from '@/session';
import { Avatar } from '@/ui/Avatar';
import { shortAddress } from '@/ui/format';
import { Button, ButtonRow, Card, Field, Notice, Section, useWide } from '@/ui/kit';
import { color, font, text } from '@/ui/theme';
import { asError } from '@/wallet/api';

import { avatarSeedFor, rolledName } from './identity';
import { NAME_MAX, nameProblem, normalizeName } from './rules';

export function ProfileSection() {
  const { auth, profile } = useSession();
  const wide = useWide();
  const [draft, setDraft] = useState<string | null>(null);
  const [rolls, setRolls] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);

  const identity = profile.identity;
  if (identity === null || auth.address === null) return null;
  const address = auth.address;

  const change = (patch: Parameters<typeof profile.update>[0]) => {
    setFailure(null);
    profile.update(patch).catch((error: unknown) => {
      setFailure(asError(error).message);
    });
  };

  const value = draft ?? identity.name;
  const normalized = normalizeName(value);
  const problem = draft !== null ? nameProblem(normalized) : null;
  const dirty = draft !== null && normalized !== identity.name;

  const saveName = () => {
    if (!dirty || problem !== null) return;
    change({ name: normalized });
    setDraft(null);
  };
  const rollName = () => {
    const next = rolledName(address, rolls, identity.name);
    setRolls((n) => n + 1);
    setDraft(null);
    change({ name: next });
  };

  const step = identity.avatarStep;
  const size = wide ? 128 : 104;
  const face = identity.defaultAvatar ? 'original face' : `face ${step}`;
  const source =
    identity.defaultAvatar && identity.defaultName
      ? `drawn from ${shortAddress(address)}`
      : `${shortAddress(address)} · ${face}`;

  return (
    <Section label="Profile">
      <Card>
        <View style={styles.head}>
          <Avatar seed={identity.avatarSeed} size={size} />
          <View style={styles.who}>
            <Text style={styles.name} numberOfLines={2}>
              {identity.name}
            </Text>
            <Text style={[text.mono, styles.source]} numberOfLines={1}>
              {source}
            </Text>
          </View>
        </View>
        <View style={styles.controls}>
          <ButtonRow>
            <Button
              label="Previous"
              icon="back"
              size="sm"
              disabled={step === 0}
              onPress={() => change({ avatarSeed: avatarSeedFor(step - 1) })}
            />
            <Button
              label="New face"
              kind="soft"
              size="sm"
              onPress={() => change({ avatarSeed: avatarSeedFor(step + 1) })}
            />
            <Button
              label="Original"
              size="sm"
              disabled={step === 0}
              onPress={() => change({ avatarSeed: null })}
            />
          </ButtonRow>
        </View>
      </Card>

      <View style={styles.nameBlock}>
        <Field
          label="Name"
          value={value}
          onChangeText={setDraft}
          max={NAME_MAX}
          maxLength={NAME_MAX + 8}
          autoCapitalize="words"
          error={problem ?? undefined}
          hint={
            identity.defaultName
              ? 'Generated from your signing key. Type your own or roll another.'
              : 'Your pick. It follows your passkey to every device.'
          }
          onSubmitEditing={saveName}
        />
        <ButtonRow>
          {dirty ? (
            <Button
              label="Save name"
              kind="primary"
              size="sm"
              disabled={problem !== null}
              onPress={saveName}
            />
          ) : null}
          <Button label="Roll a name" size="sm" onPress={rollName} />
          {!identity.defaultName ? (
            <Button
              label="Use generated"
              size="sm"
              onPress={() => {
                setDraft(null);
                change({ name: null });
              }}
            />
          ) : null}
        </ButtonRow>
      </View>

      {failure !== null ? (
        <View style={styles.failure}>
          <Notice tone="error" title="Your profile was not saved" detail={failure} />
        </View>
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  who: { flex: 1, minWidth: 0, gap: 6 },
  name: {
    fontFamily: font.display,
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.6,
    color: color.text,
  },
  source: { fontSize: 11, lineHeight: 15, color: color.textFaint },
  controls: { marginTop: 18 },
  nameBlock: { marginTop: 18, gap: 12 },
  failure: { marginTop: 12 },
});
