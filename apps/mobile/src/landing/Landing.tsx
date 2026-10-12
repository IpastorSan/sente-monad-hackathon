/**
 * Welcome on a wide web window (SEN-196): a short landing page for someone who
 * arrives at sente.lol cold — a judge, usually — with the sign-in actions in
 * the hero, so the page that explains Sente is still the page that starts it.
 *
 * Welcome owns the sign-in logic and passes its actions, error and tip sheet
 * in; this file only lays them out. Only rendered when `useWide()` holds, so
 * only on web (Android is never wide), and it mounts no canvas (SEN-173): the
 * board behind the hero is `HomeBoard`'s CSS grid and the goban is SVG.
 *
 * The step markers are stones on a dashed line — the mandate's boundary from
 * `GobanHero` — because the steps are a real sequence: no hire before a
 * mandate, nothing to watch before a hire.
 */
import { Link, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, type TextProps } from 'react-native';

import { GobanHero } from '@/ui/GobanHero';
import { HomeBoard } from '@/ui/HomeBoard';
import { Mark, Pill } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import { WIDE_MAX } from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';

import {
  APK_URL,
  BROWSER_NOTE,
  GITHUB_URL,
  howItWorksHref,
  LANDING_HEADLINE,
  LANDING_LEDE,
  POINTS,
  STEPS,
} from './landing';

const H1 = { role: 'heading', 'aria-level': 1 } as TextProps;
const H2 = { role: 'heading', 'aria-level': 2 } as TextProps;
const H3 = { role: 'heading', 'aria-level': 3 } as TextProps;

/**
 * Keyboard focus, drawn: react-native-web leaves the browser's own ring to
 * links and pressables, which on this ground is near invisible. Only while the
 * landing is mounted, and only for keyboard focus (`:focus-visible`).
 */
const FOCUS_CSS = `a:focus-visible,[role="button"]:focus-visible{outline:2px solid ${color.purpleHi};outline-offset:3px;border-radius:999px}`;

export function Landing({
  actions,
  caption,
  notice,
  showcaseHref,
  sheet,
}: {
  /** The sign-in buttons, exactly as Welcome builds them. */
  actions: ReactNode;
  caption: string;
  /** An auth error, or null. */
  notice: ReactNode;
  /** `/a/<id>` of the agent to show off, or null to leave the section out. */
  showcaseHref: string | null;
  /** The passkey tip sheet. */
  sheet: ReactNode;
}) {
  return (
    <View style={styles.screen}>
      {Platform.OS === 'web' ? <style>{FOCUS_CSS}</style> : null}
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.boardWrap}>
          <HomeBoard />
          <View style={styles.column}>
            <View style={styles.nav}>
              <View style={styles.brand}>
                <Mark size={30} />
                <Text style={styles.wordmark}>Sente</Text>
                <View>
                  <Pill label="Monad testnet" />
                </View>
              </View>
              <View style={styles.navLinks}>
                <NavLink href="/how-it-works" label="How it works" />
                <NavLink href={GITHUB_URL} label="GitHub" external />
              </View>
            </View>

            <View style={styles.hero}>
              <View style={styles.heroCopy}>
                <Text {...H1} style={styles.headline}>
                  {LANDING_HEADLINE}
                </Text>
                <Text style={styles.lede}>{LANDING_LEDE}</Text>
                <View style={styles.actions}>{actions}</View>
                <View style={styles.notes}>
                  <Text style={text.caption}>{caption}</Text>
                  <Text style={text.caption}>{BROWSER_NOTE}</Text>
                </View>
                {notice}
              </View>
              <View style={styles.heroArt}>
                <GobanHero maxSize={380} />
                <Text style={styles.artCaption}>
                  Stones inside the dashed line are trades the mandate allows. The one outside is a
                  move the enclave refused to sign.
                </Text>
              </View>
            </View>
          </View>
        </View>

        <View style={[styles.column, styles.section]}>
          <Text {...H2} style={text.label}>
            Why the limits hold
          </Text>
          <View style={styles.points}>
            {POINTS.map((point) => (
              <View key={point.anchor} style={styles.point}>
                <View style={styles.pointIcon}>
                  <Icon name={point.icon} size={20} color={color.purpleSoft} />
                </View>
                <Text {...H3} style={text.title}>
                  {point.title}
                </Text>
                <Text style={[text.body, styles.dim]}>{point.body}</Text>
                <MoreLink anchor={point.anchor} label={point.more} />
              </View>
            ))}
          </View>
        </View>

        <View style={[styles.column, styles.section]}>
          <Text {...H2} style={text.label}>
            How it works
          </Text>
          <View style={styles.steps}>
            {STEPS.map((step, i) => (
              <View key={step.anchor} style={styles.step}>
                {i < STEPS.length - 1 ? <View style={styles.track} aria-hidden /> : null}
                <View style={[styles.stone, i === STEPS.length - 1 && styles.stoneLast]}>
                  <Text style={[styles.stoneNum, i === STEPS.length - 1 && styles.stoneNumLast]}>
                    {i + 1}
                  </Text>
                </View>
                <Text {...H3} style={text.title}>
                  {step.title}
                </Text>
                <Text style={[text.body, styles.dim]}>{step.body}</Text>
                <MoreLink anchor={step.anchor} label="Read the details" />
              </View>
            ))}
          </View>
        </View>

        {showcaseHref !== null ? (
          <View style={[styles.column, styles.section]}>
            <View style={styles.showcase}>
              <View style={styles.showcaseCopy}>
                <Text {...H2} style={text.title}>
                  See a live agent
                </Text>
                <Text style={[text.body, styles.dim]}>
                  Its mandate, what it traded and what it was held back from, readable without
                  signing in.
                </Text>
              </View>
              <Link href={showcaseHref as Href} style={styles.showcaseLink}>
                Open its public page →
              </Link>
            </View>
          </View>
        ) : null}

        <View style={styles.column}>
          <View style={styles.footer}>
            <Text style={text.caption}>Monad testnet only. The tokens have no value.</Text>
            <View style={styles.navLinks}>
              <NavLink href="/how-it-works" label="How it works" />
              <NavLink href={GITHUB_URL} label="GitHub" external />
              <NavLink href={APK_URL} label="Android APK" external />
            </View>
          </View>
        </View>
      </ScrollView>
      {sheet}
    </View>
  );
}

function NavLink({
  href,
  label,
  external = false,
}: {
  href: string;
  label: string;
  external?: boolean;
}) {
  return (
    <Link
      href={href as Href}
      style={styles.navLink}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {label}
    </Link>
  );
}

function MoreLink({ anchor, label }: { anchor: string; label: string }) {
  return (
    <Link href={howItWorksHref(anchor) as Href} style={styles.more}>
      {label} →
    </Link>
  );
}

const PAD = 48;
const STEP_GAP = 40;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.ink },
  scroll: { paddingBottom: 40 },
  // `HomeBoard` paints at zIndex -1; this keeps it above the ink ground.
  boardWrap: { position: 'relative', zIndex: 0 },
  column: { width: '100%', maxWidth: WIDE_MAX, alignSelf: 'center', paddingHorizontal: PAD },
  nav: {
    height: 72,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  wordmark: { fontFamily: font.display, fontSize: 22, letterSpacing: -0.4, color: color.text },
  navLinks: { flexDirection: 'row', alignItems: 'center', gap: 28 },
  navLink: { fontFamily: font.medium, fontSize: 14, color: color.textDim },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 64,
    paddingTop: 56,
    paddingBottom: 72,
  },
  heroCopy: { flex: 1.25, gap: 22 },
  headline: {
    fontFamily: font.display,
    fontSize: 64,
    lineHeight: 66,
    letterSpacing: -2.2,
    color: color.text,
  },
  lede: {
    fontFamily: font.regular,
    fontSize: 18,
    lineHeight: 28,
    color: color.textDim,
    maxWidth: 540,
  },
  // Fixed widths: a label flipping (credential hint read) or a spinner never moves the row.
  actions: { flexDirection: 'row', gap: 12, marginTop: 6, width: 512 },
  notes: { gap: 4, maxWidth: 512 },
  heroArt: { flex: 1, alignItems: 'center', gap: 14 },
  artCaption: {
    fontFamily: font.voice,
    fontSize: 12,
    lineHeight: 18,
    color: color.textFaint,
    textAlign: 'center',
    maxWidth: 340,
  },
  section: { paddingTop: 40, paddingBottom: 40, gap: 22 },
  points: { flexDirection: 'row', gap: 20 },
  point: {
    flex: 1,
    gap: 10,
    padding: 24,
    borderRadius: RADIUS.board,
    backgroundColor: color.board,
    borderWidth: 1,
    borderColor: color.line,
  },
  pointIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.well,
    marginBottom: 6,
  },
  dim: { color: color.textDim },
  more: { fontFamily: font.medium, fontSize: 14, color: color.purpleHi, marginTop: 4 },
  steps: { flexDirection: 'row', gap: STEP_GAP },
  // The mandate's dashed boundary, from this stone to the next one.
  track: {
    position: 'absolute',
    top: 17,
    left: 36 + 8,
    right: -STEP_GAP + 8,
    borderTopWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.purpleSoft,
    opacity: 0.5,
  },
  step: { flex: 1, gap: 10, position: 'relative' },
  stone: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.text,
    marginBottom: 8,
  },
  stoneLast: { backgroundColor: color.purple },
  stoneNum: { fontFamily: font.chain, fontSize: 14, color: color.ink },
  stoneNumLast: { color: '#FFFFFF' },
  showcase: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 24,
    padding: 28,
    borderRadius: RADIUS.board,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.purpleSoft,
    backgroundColor: 'rgba(131, 110, 249, 0.07)',
  },
  showcaseCopy: { flex: 1, gap: 6 },
  showcaseLink: {
    fontFamily: font.medium,
    fontSize: 15,
    color: '#FFFFFF',
    backgroundColor: color.purple,
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: RADIUS.stone,
  },
  footer: {
    marginTop: 24,
    paddingTop: 24,
    borderTopWidth: 1,
    borderTopColor: color.line,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
