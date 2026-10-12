/**
 * An agent's public page (SEN-193): `sente.lol/a/<id>`, no passkey needed.
 *
 * Sente's limits live in an enclave policy nobody outside can inspect, so this
 * page is where they become readable: the mandate in the same two ledgers the
 * owner sees (`MandateSummary`), what the agent has done under it, what it was
 * held back from, and — once SEN-194 anchors it — the transaction that put the
 * mandate's hash on chain. The mandate is the page's subject; the P&L is the
 * evidence beside it.
 *
 * Like `/how-it-works` it is a stack screen outside the tabs' sign-in gate.
 * "Hire a copy" opens the fork flow, through Welcome when signed out
 * (`?next=` brings the visitor back to it).
 *
 * Web: every drawing here is a DOM twin (sigil, avatar, icons), so the page
 * mounts no Skia canvas (SEN-173).
 */
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import Head from 'expo-router/head';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { modelLabel } from '@/agents/api';
import { pnlUnit } from '@/agents/cockpit';
import { formatExpiry, formatNotional, quoteUnit } from '@/agents/mandate';
import { MandateSummary } from '@/agents/MandateSummary';
import {
  fetchPublicAgent,
  hireCopyHref,
  PublicAgentError,
  publicAgentUrl,
  signedMoney,
  statusPill,
  type PublicAgent,
  type PublicFill,
  type PublicRefusal,
} from '@/agents/publicAgent';
import { ShareLinkButton } from '@/agents/ShareLink';
import { addressUrl, txUrl } from '@/chain/explorer';
import { useSession } from '@/session';
import { Avatar } from '@/ui/Avatar';
import { shortAddress } from '@/ui/format';
import { Mark, Pill, Sigil, Stat, Stone } from '@/ui/goban';
import { Icon } from '@/ui/icons';
import { Button, isHovered, Loading, Notice, Screen, Tag, useWide, WIDE_MAX } from '@/ui/kit';
import { color, font, RADIUS, text } from '@/ui/theme';

/** A page someone may leave open: a quiet refresh, matched to the API's 15 s cache. */
const REFRESH_MS = 30_000;

type Load =
  | { kind: 'loading' }
  | { kind: 'ok'; agent: PublicAgent }
  | { kind: 'error'; status: number; message: string };

export default function PublicAgentPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const wide = useWide();
  const { auth } = useSession();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const read = useCallback(async () => {
    if (!id) return;
    try {
      const agent = await fetchPublicAgent(id);
      setLoad({ kind: 'ok', agent });
    } catch (error) {
      setLoad((previous) =>
        // A failed refresh keeps the page it already has.
        previous.kind === 'ok'
          ? previous
          : {
              kind: 'error',
              status: error instanceof PublicAgentError ? error.status : 0,
              message: error instanceof Error ? error.message : String(error),
            },
      );
    }
  }, [id]);

  useEffect(() => {
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [read]);

  const home = () => router.replace('/');

  if (load.kind !== 'ok') {
    return (
      <Screen>
        <Head>
          <title>Agent · Sente</title>
        </Head>
        <Brand onHome={home} />
        {load.kind === 'loading' ? (
          <Loading />
        ) : (
          <Notice
            tone={load.status === 404 ? 'info' : 'error'}
            title={load.status === 404 ? 'No agent at this address' : 'Couldn’t load this agent'}
            detail={
              load.status === 404
                ? 'The link may be mistyped, or the agent was never on Sente.'
                : load.message
            }
          >
            <View style={styles.noticeAction}>
              {load.status === 404 ? (
                <Button label="Open Sente" size="sm" onPress={home} />
              ) : (
                <Button label="Try again" size="sm" onPress={() => void read()} />
              )}
            </View>
          </Notice>
        )}
      </Screen>
    );
  }

  const { agent } = load;
  const signedIn = auth.status === 'ready';
  const revoked = agent.status === 'revoked';
  const hire = () => router.push(hireCopyHref(agent, signedIn) as Href);

  return (
    <Screen
      maxWidth={WIDE_MAX}
      footer={
        <View style={styles.footer}>
          <Button
            label="Hire a copy"
            kind="primary"
            icon="plus"
            onPress={hire}
            disabled={revoked}
          />
          {revoked ? (
            <Text style={[text.caption, styles.footerNote]}>
              A revoked agent’s strategy is no longer running, so it can’t be copied.
            </Text>
          ) : (
            <Text style={[text.caption, styles.footerNote]}>
              Same strategy, a new wallet, and limits you set yourself.
            </Text>
          )}
        </View>
      }
    >
      <PublicHead agent={agent} />
      <Brand onHome={home} right={<ShareLinkButton agentId={agent.id} agentName={agent.name} />} />
      <Header agent={agent} />

      <View style={[styles.columns, wide && styles.columnsWide]}>
        <View style={[styles.column, wide && styles.mandateColumn]}>
          <MandateCard agent={agent} />
        </View>
        <View style={[styles.column, wide && styles.recordColumn]}>
          <Record agent={agent} />
          <Fills fills={agent.fills} />
          <Refusals refusals={agent.refusals} />
          <Instructions agent={agent} />
        </View>
      </View>
    </Screen>
  );
}

// ─── Head ───────────────────────────────────────────────────────────────────

/** The document title and the link-preview tags, on the web. */
function PublicHead({ agent }: { agent: PublicAgent }) {
  const title = `${agent.name} · Sente agent`;
  const description = describeForPreview(agent);
  const url = publicAgentUrl(agent.id);
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta property="og:type" content="profile" />
      <meta property="og:site_name" content="Sente" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
    </Head>
  );
}

function describeForPreview(agent: PublicAgent): string {
  const { mandate } = agent;
  const venues = mandate.venues.map((v) => (v === 'kuru' ? 'Kuru spot' : 'Perpl perps'));
  const pnl = signedMoney(agent.pnl.allTime).text;
  return (
    `An AI trading agent on Monad. Its mandate, enforced by Privy's signing enclave: ` +
    `${venues.join(' and ') || 'no venue'}, at most ${formatNotional(mandate.maxOrderNotional)} ` +
    `${quoteUnit(mandate)} per order, until ${formatExpiry(mandate.expiresAt)}. ` +
    `Realised P&L ${pnl}.`
  );
}

// ─── Top ────────────────────────────────────────────────────────────────────

function Brand({ onHome, right }: { onHome: () => void; right?: ReactNode }) {
  return (
    <View style={styles.brand}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Sente home"
        onPress={onHome}
        style={styles.brandMark}
        hitSlop={8}
      >
        <Mark size={26} />
        <Text style={styles.brandName}>Sente</Text>
      </Pressable>
      {right}
    </View>
  );
}

function Header({ agent }: { agent: PublicAgent }) {
  const pill = statusPill(agent.status);
  const wallet = addressUrl(agent.address);
  return (
    <View style={styles.header}>
      <Sigil seed={agent.sigilSeed} size={64} dimmed={agent.status === 'revoked'} />
      <View style={styles.headerText}>
        <Text style={text.display} numberOfLines={2} accessibilityRole="header">
          {agent.name}
        </Text>
        <View style={styles.meta}>
          <Avatar seed={agent.owner.avatarSeed} size={20} />
          <Text style={text.dim}>by {agent.owner.name ?? 'a Sente trader'}</Text>
          <Text style={text.caption}>·</Text>
          <Text style={text.dim}>{modelLabel(agent.model)}</Text>
          <Pill label={pill.label} tone={pill.tone} />
        </View>
        <View style={styles.meta}>
          {agent.preset ? (
            <Tag label={`${agent.preset.name}${agent.preset.customized ? ' · edited' : ''}`} />
          ) : null}
          <ExternalLink url={wallet} label={`Wallet ${shortAddress(agent.address)}`} mono />
          {agent.erc8004AgentId ? (
            <Text style={text.mono}>ERC-8004 #{agent.erc8004AgentId}</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

// ─── Mandate ────────────────────────────────────────────────────────────────

/**
 * The page's subject. Framed in the enclave's lilac — the one place on this
 * page that colour is spent — and closed by the seal: the on-chain anchor, or
 * a plain line saying there is none yet.
 */
function MandateCard({ agent }: { agent: PublicAgent }) {
  return (
    <View style={styles.mandate} accessibilityRole="summary">
      <View style={styles.mandateHead}>
        <Icon name="shield" size={16} color={color.purpleSoft} strokeWidth={2.2} />
        <Text style={[text.label, styles.mandateLabel]}>Mandate</Text>
      </View>
      <Text style={text.title}>What {agent.name} is allowed to do</Text>
      <Text style={[text.dim, styles.mandateLead]}>
        These limits are the agent wallet’s signing policy, read here as it was last set. Only the
        owner’s passkey can change them.
      </Text>
      <MandateSummary
        mandate={agent.mandate}
        returnToLabel={
          agent.returnsToOwner ? 'The owner’s own wallet' : 'Nowhere — this agent has no way out'
        }
      />
      <Text style={[text.caption, styles.honest]}>
        The enclave refuses to sign anything past the first list, whatever the agent is told. The
        second is Sente’s own check before an order goes out: the enclave never sees order size or
        leverage, so those hold only as long as Sente runs it.
      </Text>
      <Seal agent={agent} />
    </View>
  );
}

function Seal({ agent }: { agent: PublicAgent }) {
  const anchor = agent.mandateAnchor;
  if (!anchor) {
    return (
      <View style={styles.seal}>
        <Text style={text.caption}>The mandate’s hash is not anchored on chain yet.</Text>
      </View>
    );
  }
  return (
    <View style={styles.seal}>
      <View style={styles.grow}>
        <Text style={text.label}>Mandate hash on Monad</Text>
        <Text style={text.mono} selectable numberOfLines={1} ellipsizeMode="middle">
          {anchor.mandateHash ?? anchor.txHash}
        </Text>
      </View>
      <ExternalLink url={txUrl(anchor.txHash)} label="Verify on chain" strong />
    </View>
  );
}

// ─── Record ─────────────────────────────────────────────────────────────────

function Record({ agent }: { agent: PublicAgent }) {
  const { unit } = pnlUnit(agent.mandate.venues);
  const all = signedMoney(agent.pnl.allTime);
  const day = signedMoney(agent.pnl.last24h);
  const { trades, held } = agent.counts;
  return (
    <View style={styles.block}>
      <Text style={text.label}>Record</Text>
      <View style={styles.stats}>
        <Stat
          label="Realised P&L"
          value={all.text}
          tone={all.tone ?? undefined}
          style={styles.grow}
        />
        <Stat label="Last 24 h" value={day.text} tone={day.tone ?? undefined} style={styles.grow} />
        <Stat
          label="Balance"
          value={agent.balance ? `≈ $${agent.balance.approxUsd}` : '—'}
          style={styles.grow}
        />
      </View>
      <Text style={text.caption}>
        {[
          unit ? `P&L in ${unit}, net of fees` : 'P&L net of fees',
          agent.pnl.allTimePartial ? 'over the history Sente still holds' : null,
          `${trades} ${trades === 1 ? 'fill' : 'fills'}`,
          `${held} held back`,
          `copied ${agent.copies} ${agent.copies === 1 ? 'time' : 'times'}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
    </View>
  );
}

function Fills({ fills }: { fills: readonly PublicFill[] }) {
  return (
    <View style={styles.block}>
      <Text style={text.label}>Recent fills</Text>
      {fills.length === 0 ? (
        <Text style={text.dim}>No fills yet.</Text>
      ) : (
        <View style={styles.list}>
          {fills.map((fill, i) => (
            <View key={`${fill.at}-${i}`} style={[styles.item, i > 0 && styles.itemRule]}>
              <Stone kind="trade" size={10} />
              <View style={styles.grow}>
                <Text style={[text.body, text.num]}>
                  {fill.side ? (
                    <Text style={fill.side === 'buy' ? text.up : text.down}>
                      {fill.side === 'buy' ? 'Bought ' : 'Sold '}
                    </Text>
                  ) : (
                    'Filled '
                  )}
                  {fill.size} {fill.symbol}
                  {fill.price ? <Text style={text.dim}> at {fill.price}</Text> : null}
                </Text>
                <Text style={text.caption}>
                  {fill.venue === 'kuru' ? 'Kuru' : 'Perpl'} · {when(fill.at)}
                </Text>
              </View>
              {fill.txHash ? <ExternalLink url={txUrl(fill.txHash)} label="Tx" /> : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** Refusals in lilac, never red: an agent held back is the mandate working. */
function Refusals({ refusals }: { refusals: readonly PublicRefusal[] }) {
  return (
    <View style={styles.block}>
      <Text style={text.label}>Held back</Text>
      {refusals.length === 0 ? (
        <Text style={text.dim}>Nothing yet: the agent has stayed inside its mandate.</Text>
      ) : (
        <View style={styles.list}>
          {refusals.map((refusal, i) => (
            <View key={`${refusal.at}-${i}`} style={[styles.item, i > 0 && styles.itemRule]}>
              <Stone kind="refusal" size={10} />
              <View style={styles.grow}>
                <View style={styles.refusalHead}>
                  <Pill
                    tone="held"
                    label={refusal.layer === 'enclave' ? 'Held by the enclave' : 'Held by Sente'}
                  />
                  {refusal.code ? <Text style={text.mono}>{refusal.code}</Text> : null}
                </View>
                {refusal.message ? <Text style={text.dim}>{refusal.message}</Text> : null}
                <Text style={text.caption}>{when(refusal.at)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function Instructions({ agent }: { agent: PublicAgent }) {
  return (
    <View style={styles.block}>
      <Text style={text.label}>Instructions</Text>
      {agent.prompt ? (
        <>
          {agent.prompt.strategy ? <Text style={text.voice}>{agent.prompt.strategy}</Text> : null}
          {agent.prompt.systemPrompt ? (
            <View style={styles.prompt}>
              <Text style={text.dim} selectable>
                {agent.prompt.systemPrompt}
              </Text>
            </View>
          ) : null}
        </>
      ) : (
        <Text style={text.dim}>
          Its owner keeps the instructions private. A copy runs the same strategy and model under
          your own mandate.
        </Text>
      )}
    </View>
  );
}

// ─── Bits ───────────────────────────────────────────────────────────────────

function ExternalLink({
  url,
  label,
  mono = false,
  strong = false,
}: {
  url: string | null;
  label: string;
  mono?: boolean;
  strong?: boolean;
}) {
  if (!url) return <Text style={mono ? text.mono : text.caption}>{label}</Text>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint="Opens the block explorer"
      onPress={() => void Linking.openURL(url)}
      hitSlop={8}
      style={(state) => [styles.link, isHovered(state) && styles.linkHover]}
    >
      <Text style={[mono ? text.mono : styles.linkText, strong && styles.linkStrong]}>
        {label} ↗
      </Text>
    </Pressable>
  );
}

/** UTC to the minute, like the mandate's expiry: the same string for every reader. */
function when(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  brandMark: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandName: { fontFamily: font.displaySemibold, fontSize: 18, color: color.text },
  header: { flexDirection: 'row', gap: 16, alignItems: 'flex-start', marginTop: 20 },
  headerText: { flex: 1, gap: 8, minWidth: 0 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  columns: { gap: 28, marginTop: 28 },
  columnsWide: { flexDirection: 'row', alignItems: 'flex-start', gap: 32 },
  column: { gap: 28 },
  mandateColumn: { flex: 11, minWidth: 0 },
  recordColumn: { flex: 10, minWidth: 0 },
  mandate: {
    gap: 12,
    padding: 20,
    borderRadius: RADIUS.board,
    borderWidth: 1,
    borderColor: 'rgba(221, 215, 254, 0.28)',
    backgroundColor: color.board,
  },
  mandateHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mandateLabel: { color: color.purpleSoft },
  mandateLead: { marginBottom: 4 },
  honest: { marginTop: 4 },
  seal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 4,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: color.line,
    borderStyle: 'dashed',
  },
  block: { gap: 12 },
  stats: { flexDirection: 'row', gap: 8 },
  list: {
    borderRadius: RADIUS.well,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.board,
  },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  itemRule: { borderTopWidth: 1, borderTopColor: color.line },
  refusalHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  prompt: {
    padding: 14,
    borderRadius: RADIUS.well,
    backgroundColor: color.well,
  },
  link: { borderRadius: 6, paddingHorizontal: 2 },
  linkHover: { backgroundColor: color.well },
  linkText: { fontFamily: font.medium, fontSize: 13, color: color.purpleHi },
  linkStrong: { fontSize: 14 },
  footer: { gap: 8 },
  footerNote: { textAlign: 'center' },
  noticeAction: { marginTop: 10, alignSelf: 'flex-start' },
});
