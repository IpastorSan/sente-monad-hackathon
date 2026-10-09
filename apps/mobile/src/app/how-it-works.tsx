/**
 * How it works (SEN-181): what Sente does with your passkey, your wallet, your
 * trades and your agents, and what is not proven yet — for a judge or a
 * technical user, in plain words. The copy is data (`howItWorks/content.ts`);
 * this file only lays it out.
 *
 * Six sections, each a board that opens into short questions. Closed, the
 * boards are the page's table of contents: a title and the one line that
 * answers the section. Every section and question has an anchor, so another
 * screen can send someone to `/how-it-works#mandate` and land on that answer,
 * opened and scrolled into view, with a purple edge saying "this one". On the
 * web, opening a question writes its anchor into the address bar, so the link
 * a reader copies is the answer they are looking at.
 *
 * It needs no session: a judge may want it before making a passkey, so it is a
 * stack screen outside the tabs' sign-in gate, linked from Welcome, the wide
 * rail and Account.
 *
 * Accessible as an accordion: each header is a button inside a heading, with
 * `aria-expanded` and `aria-controls`, reachable and operable by keyboard on
 * the web. "Open all" exists because a closed answer is invisible to the
 * browser's find-in-page.
 */
import { Link, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import Head from 'expo-router/head';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type PressableStateCallbackType,
  type ViewProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolveAnchor, SECTIONS, type HelpItem, type HelpSection } from '@/howItWorks/content';
import { parseParagraph } from '@/howItWorks/markup';
import { Pill } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import { CONTENT_MAX, isHovered, TopBar, useWide } from '@/ui/kit';
import { color, font, GUTTER, RADIUS, text } from '@/ui/theme';

/** react-native-web renders this as a level-2 heading; native reads it as a header. */
const HEADING = { role: 'heading', 'aria-level': 2 } as ViewProps;
const SUBHEADING = { role: 'heading', 'aria-level': 3 } as ViewProps;

/** Room left above an answer scrolled into view. */
const SCROLL_MARGIN = 12;

/** Pressable's state on web also carries `focused` (react-native-web). */
function isFocused(state: PressableStateCallbackType): boolean {
  return (state as PressableStateCallbackType & { focused?: boolean }).focused === true;
}

/** The anchor in the address on first load: the router's `#` param, or the browser's own hash. */
function initialAnchor(param: string | undefined): string | null {
  if (param) return param;
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location.hash)
    return window.location.hash;
  return null;
}

/** Keep the address bar's hash on the answer being read (web only; no navigation). */
function writeHash(id: string | null) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const url = `${window.location.pathname}${window.location.search}${id ? `#${id}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}

export default function HowItWorks() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wide = useWide();
  const params = useLocalSearchParams<{ '#'?: string }>();

  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(() => new Set());
  const [openItems, setOpenItems] = useState<ReadonlySet<string>>(() => new Set());
  /** The answer an anchor pointed at: marked, and scrolled to once laid out. */
  const [target, setTarget] = useState<{ id: string; nonce: number } | null>(null);

  const scroller = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const anchors = useRef(new Map<string, View | null>());

  const jump = useCallback((raw: string | null | undefined) => {
    const found = resolveAnchor(raw);
    if (!found) return;
    setOpenSections((prev) => new Set(prev).add(found.sectionId));
    if (found.itemId !== null) setOpenItems((prev) => new Set(prev).add(found.itemId as string));
    const id = found.itemId ?? found.sectionId;
    setTarget((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
    writeHash(id);
  }, []);

  // On arrival, and whenever another screen pushes a new anchor at this one.
  const anchorParam = params['#'];
  useEffect(() => {
    jump(initialAnchor(anchorParam));
  }, [anchorParam, jump]);

  // Scroll once the opened answer has been laid out.
  useEffect(() => {
    if (target === null) return;
    const timer = setTimeout(() => {
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        document.getElementById(target.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      const node = anchors.current.get(target.id);
      const root = content.current;
      if (!node || !root) return;
      node.measureLayout(root, (_x, y) => {
        scroller.current?.scrollTo({ y: Math.max(0, y - SCROLL_MARGIN), animated: true });
      });
    }, 60);
    return () => clearTimeout(timer);
  }, [target]);

  const toggleSection = (id: string) => {
    const opening = !openSections.has(id);
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    writeHash(opening ? id : null);
  };

  const toggleItem = (id: string) => {
    const opening = !openItems.has(id);
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    writeHash(opening ? id : null);
  };

  const allOpen = useMemo(
    () =>
      SECTIONS.every(
        (s) => openSections.has(s.id) && s.items.every((item) => openItems.has(item.id)),
      ),
    [openSections, openItems],
  );

  const toggleAll = () => {
    if (allOpen) {
      setOpenSections(new Set());
      setOpenItems(new Set());
      setTarget(null);
      writeHash(null);
      return;
    }
    setOpenSections(new Set(SECTIONS.map((s) => s.id)));
    setOpenItems(new Set(SECTIONS.flatMap((s) => s.items.map((item) => item.id))));
  };

  const register = (id: string) => (node: View | null) => {
    anchors.current.set(id, node);
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const column = wide
    ? { maxWidth: CONTENT_MAX, width: '100%' as const, alignSelf: 'center' as const }
    : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Head>
        <title>How it works · Sente</title>
      </Head>
      <ScrollView
        ref={scroller}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 48 }, column]}
      >
        <View ref={content} collapsable={false}>
          <TopBar back={{ label: 'Back', onPress: back }} />

          <View style={styles.head}>
            <Text style={text.display} role="heading" aria-level={1}>
              How Sente works
            </Text>
            <Text style={[text.body, styles.lede]}>
              What happens to your passkey, your wallet, your trades and your agents, and what has
              not been proven yet. The short answer is first; open a question for the detail.
            </Text>
            <View style={styles.meta}>
              <View>
                <Pill label="Monad testnet" />
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={toggleAll}
                hitSlop={10}
                style={(state) => [styles.textButton, isFocused(state) && styles.focusRing]}
              >
                <Text style={styles.textButtonLabel}>{allOpen ? 'Close all' : 'Open all'}</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.sections}>
            {SECTIONS.map((section) => (
              <SectionBoard
                key={section.id}
                section={section}
                open={openSections.has(section.id)}
                openItems={openItems}
                target={target?.id ?? null}
                onToggle={() => toggleSection(section.id)}
                onToggleItem={toggleItem}
                onJump={jump}
                register={register}
              />
            ))}
          </View>

          <Text style={[text.caption, styles.colophon]}>
            Every statement here is drawn from Sente’s repository: its README and the docs that
            record each measurement on Monad testnet.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function SectionBoard({
  section,
  open,
  openItems,
  target,
  onToggle,
  onToggleItem,
  onJump,
  register,
}: {
  section: HelpSection;
  open: boolean;
  openItems: ReadonlySet<string>;
  target: string | null;
  onToggle: () => void;
  onToggleItem: (id: string) => void;
  onJump: (anchor: string) => void;
  register: (id: string) => (node: View | null) => void;
}) {
  const panel = `${section.id}-panel`;
  return (
    <View
      ref={register(section.id)}
      nativeID={section.id}
      collapsable={false}
      style={[styles.board, open && styles.boardOpen, target === section.id && styles.targeted]}
    >
      <View {...HEADING}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          aria-expanded={open}
          aria-controls={panel}
          onPress={onToggle}
          style={(state) => [
            styles.sectionHead,
            isHovered(state) && styles.hover,
            state.pressed && styles.pressed,
            isFocused(state) && styles.focusRing,
          ]}
        >
          <View style={styles.glyph}>
            <Icon name={section.icon} size={20} color={open ? color.purpleHi : color.textDim} />
          </View>
          <View style={styles.grow}>
            <Text style={text.title}>{section.title}</Text>
            <Text style={[text.dim, styles.summary]}>{section.summary}</Text>
          </View>
          <Chevron open={open} />
        </Pressable>
      </View>

      {open ? (
        <View nativeID={panel} style={styles.items}>
          {section.items.map((item) => (
            <Question
              key={item.id}
              item={item}
              open={openItems.has(item.id)}
              targeted={target === item.id}
              onToggle={() => onToggleItem(item.id)}
              onJump={onJump}
              register={register}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Question({
  item,
  open,
  targeted,
  onToggle,
  onJump,
  register,
}: {
  item: HelpItem;
  open: boolean;
  targeted: boolean;
  onToggle: () => void;
  onJump: (anchor: string) => void;
  register: (id: string) => (node: View | null) => void;
}) {
  const answer = `${item.id}-answer`;
  return (
    <View
      ref={register(item.id)}
      nativeID={item.id}
      collapsable={false}
      style={[styles.question, targeted && styles.targeted]}
    >
      <View {...SUBHEADING}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          aria-expanded={open}
          aria-controls={answer}
          onPress={onToggle}
          style={(state) => [
            styles.questionHead,
            isHovered(state) && styles.hover,
            state.pressed && styles.pressed,
            isFocused(state) && styles.focusRing,
          ]}
        >
          <Text style={[text.strong, styles.grow, open && styles.questionOpen]}>
            {item.question}
          </Text>
          <Chevron open={open} small />
        </Pressable>
      </View>
      {open ? (
        <View nativeID={answer} style={styles.answer}>
          {item.body.map((paragraph, i) => (
            <Paragraph key={i} source={paragraph} onJump={onJump} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Paragraph({ source, onJump }: { source: string; onJump: (anchor: string) => void }) {
  const spans = parseParagraph(source);
  const parts: ReactNode[] = spans.map((span, i) => {
    if (span.kind === 'code')
      return (
        <Text key={i} style={styles.code}>
          {span.text}
        </Text>
      );
    if (span.kind === 'link') {
      if (span.href.startsWith('#'))
        return (
          <Text
            key={i}
            style={styles.link}
            accessibilityRole="link"
            onPress={() => onJump(span.href)}
          >
            {span.text}
          </Text>
        );
      return (
        <Link key={i} href={span.href as Href} style={styles.link}>
          {span.text}
        </Link>
      );
    }
    return span.text;
  });
  return <Text style={styles.paragraph}>{parts}</Text>;
}

function Chevron({ open, small = false }: { open: boolean; small?: boolean }) {
  return (
    <View style={{ transform: [{ rotate: open ? '-90deg' : '90deg' }] }}>
      <Icon name="chevron" size={small ? 14 : 16} color={color.textFaint} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.ink },
  content: { paddingHorizontal: GUTTER, paddingTop: 8 },
  head: { marginTop: 8, gap: 12 },
  lede: { color: color.textDim, maxWidth: 600 },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  textButton: { paddingVertical: 4, paddingHorizontal: 6, borderRadius: RADIUS.stone },
  textButtonLabel: { fontFamily: font.medium, fontSize: 13, color: color.purpleHi },
  sections: { marginTop: 24, gap: 12 },
  board: {
    borderRadius: RADIUS.board,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.board,
    overflow: 'hidden',
  },
  boardOpen: { borderColor: color.lineStrong },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  glyph: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.well,
  },
  grow: { flex: 1, minWidth: 0 },
  summary: { marginTop: 2 },
  items: { borderTopWidth: 1, borderTopColor: color.line },
  question: {
    borderBottomWidth: 1,
    borderBottomColor: color.line,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  questionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 18,
  },
  questionOpen: { color: color.purpleSoft },
  answer: { paddingLeft: 14, paddingRight: 18, paddingBottom: 18, gap: 12 },
  paragraph: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 23,
    color: color.textDim,
    maxWidth: 640,
  },
  link: {
    fontFamily: font.medium,
    color: color.purpleHi,
    textDecorationLine: 'underline',
    textDecorationColor: 'rgba(168, 152, 255, 0.45)',
  },
  code: {
    fontFamily: font.chain,
    fontSize: 13,
    color: color.text,
    backgroundColor: color.well,
  },
  // The answer an anchor brought you to: the enclave's purple, drawn as an edge.
  targeted: { borderLeftColor: color.purple },
  hover: { backgroundColor: 'rgba(29, 24, 56, 0.6)' },
  pressed: { opacity: 0.85 },
  focusRing: {
    outlineColor: color.purpleHi,
    outlineStyle: 'solid',
    outlineWidth: 2,
    outlineOffset: -2,
  },
  colophon: { marginTop: 28, maxWidth: 600 },
});
