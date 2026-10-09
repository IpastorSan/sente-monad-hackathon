/**
 * The "How it works" page's copy (SEN-181), as data: sections → questions →
 * paragraphs written in `markup.ts`'s inline links and literals.
 *
 * Every section and every question has an `id`, which is its anchor:
 * `/how-it-works#mandate` opens the page with that question expanded and in
 * view. Other screens link to these, so an id is an address — rename one and
 * add the old name to `aliases`. `content.test.ts` checks that every anchor is
 * unique and that every link reaches a route file that exists.
 *
 * Every statement here is sourced from the repo (README, CLAUDE.md, docs/) and
 * the code on main; where the docs disagree the newer one wins. Keep it that
 * way: a claim this page cannot back is worse than no claim.
 */
import type { IconName } from '../ui/iconPaths.ts';

export type HelpItem = {
  readonly id: string;
  /** Older or shorter names other screens may link to. */
  readonly aliases?: readonly string[];
  readonly question: string;
  /** Paragraphs in `markup.ts` syntax. */
  readonly body: readonly string[];
};

export type HelpSection = {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly icon: IconName;
  readonly title: string;
  /** One line under the title, readable while the section is closed. */
  readonly summary: string;
  readonly items: readonly HelpItem[];
};

export const HOW_IT_WORKS_PATH = '/how-it-works';

export const SECTIONS: readonly HelpSection[] = [
  {
    id: 'account',
    icon: 'key',
    title: 'Your account',
    summary: 'One passkey, two keys derived from it, and no seed phrase.',
    items: [
      {
        id: 'passkey',
        question: 'How does one passkey give me a wallet?',
        body: [
          'Passkeys support a WebAuthn extension called PRF: given a salt, the passkey returns a secret that depends only on that passkey and that salt. Sente asks for two salts, `sha256("sente.prf.v1.wallet")` and `sha256("sente.prf.v1.device")`, and turns each answer into its own key.',
          'The wallet key is an ordinary secp256k1 key, derived through BIP-39 and BIP-44. It proves to Sente’s API who you are. The device key is a P-256 key, and it owns your [wallet](#wallet-owner) and the policy of every [agent you hire](#mandate).',
          'The `sente.prf.v1.` prefix leaves room for more keys from the same passkey later. The salts are permanent: a renamed salt would derive different keys.',
        ],
      },
      {
        id: 'no-seed-phrase',
        question: 'Why is there no seed phrase? What is stored?',
        body: [
          'There is nothing to write down because your keys are not stored: they are derived from your passkey again each time you sign in. The app keeps only a hint about which passkey you used, never key material. Nothing is stored in plaintext, and neither key is ever sent to Sente’s server.',
          'On the web, an encrypted copy can survive a page reload. See [staying signed in](#reload).',
        ],
      },
      {
        id: 'one-prompt',
        question: 'Why does signing in ask only once?',
        body: [
          'PRF can evaluate two salts in one ceremony (`eval.first` and `eval.second`), and each result depends only on the passkey and its own salt. The passkey library Sente uses, mera 0.2.0, passes only the first, so Sente ships a small patch to it that adds the second. Both keys then come from one prompt.',
          'A provider that ignores the second salt gets a second prompt for the device key, pinned to the same passkey. Against Chrome’s virtual authenticator, both paths derive byte-identical keys. How many prompts Google Password Manager shows has not been measured yet.',
        ],
      },
      {
        id: 'reload',
        question: 'Do I stay signed in if I reload the page?',
        body: [
          'On the web, yes: for up to 8 hours, in the same tab. After you sign in, the two secrets your session is rebuilt from are encrypted with AES-256-GCM under a browser key created as non-extractable, so its bytes cannot be read out. The encrypted copy is kept in `sessionStorage`, which the browser clears when the tab closes. Your passkey’s wallet secret, which would derive every account, is not kept.',
          'The trade-off: script running in the page could ask the browser to decrypt that copy while the tab is open, and act as you for that long. It cannot take the key anywhere else. Closing the tab, signing out, or the 8 hours running out ends it. Without the copy, the same script could already use the live session, so what this adds is the window after a reload.',
          'The Android app does not keep a copy.',
        ],
      },
      {
        id: 'providers',
        question: 'Which passkey providers work?',
        body: [
          'The provider has to support PRF. Measured to work: Google Chrome on desktop with the passkey saved to Google Password Manager.',
          'Measured not to work: Chromium, which has no Google Password Manager passkeys, and the Bitwarden extension, which takes over the ceremony without PRF (pick “Use your device” in its popup, or turn its passkey prompt off). 1Password and Chrome’s profile-local passkeys are not expected to work and have not been measured on the web build.',
          'Expected to work, not yet confirmed: signing in on the desktop with your Android phone through the QR code, and on the web with a passkey the Android app created. Windows Hello and iCloud Keychain have not been measured.',
        ],
      },
      {
        id: 'domain',
        question: 'Why does it only work on sente.lol?',
        body: [
          'A passkey belongs to a domain, its relying-party ID, and Sente’s is `sente.lol`. That ID is an input to your keys, as the salts are: the same passkey under another domain would derive a different wallet. So it can never change, and a browser refuses the passkey on any other site. It is the bare domain so that every subdomain of sente.lol can use it too.',
          'The Android app uses the same domain and the same salts, so one passkey is meant to give the same wallet on the phone and on the web. That cross-device check has not been run yet.',
        ],
      },
    ],
  },
  {
    id: 'wallet',
    icon: 'portfolio',
    title: 'Your wallet',
    summary: 'A Privy wallet that only your device key can move money from.',
    items: [
      {
        id: 'wallet-owner',
        question: 'Who controls my wallet?',
        body: [
          'When you first sign in, Sente’s API creates a Privy server wallet for you and makes your [device key](#passkey) its owner. Privy will not sign for that wallet without your device key’s signature, and the key never leaves your browser or phone. Sente can create and read the wallet, but cannot move your funds. That was measured live, not assumed.',
          'This wallet is where you [add funds](/), where your own trades come from, and where agents [send money back](#return-funds).',
        ],
      },
      {
        id: 'gas',
        question: 'Why don’t I need MON for gas?',
        body: [
          'Privy sponsors the gas for sends from your wallet. A sponsored transfer was measured landing from a wallet holding 0 MON. The first sponsored send gives the wallet an EIP-7702 delegation; its address stays the same.',
          'Agents are separate wallets and pay their own gas in MON.',
        ],
      },
      {
        id: 'starter-kit',
        question: 'What is the starter kit?',
        body: [
          'On testnet, Sente sends each new wallet a one-time starter kit after it is registered: 250 AUSD and 100 USDC by default. That covers the 100 AUSD needed to open a Perpl account and Kuru’s 10 USDC minimum order, so you can [hire an agent](/agents/new) straight away.',
          'It is sent once per user and under a daily cap. If the cap turned you away, you get it on a later sign-in after midnight UTC. These are testnet tokens, with no value.',
        ],
      },
      {
        id: 'address',
        question: 'Where do I find my address?',
        body: [
          '[Account](/account) shows it as “Address to fund”, and so does the [Add funds](/) sheet on Home. Send AUSD (for Perpl) or USDC (for Kuru) on Monad testnet.',
          'Account also shows your signing key. That key authorises your wallet and holds no funds: don’t send money to it.',
        ],
      },
    ],
  },
  {
    id: 'trading',
    icon: 'trade',
    title: 'Trading yourself',
    summary: 'Sente’s server prepares each step; your device checks it before your key signs.',
    items: [
      {
        id: 'verify',
        question: 'Who checks a trade before it is signed?',
        body: [
          'When you place a trade, Sente’s server plans the steps (approve, deposit, place) and prepares each one for Privy. Your device key signs whatever it is handed, so the app checks every step first: the contract it calls, the function, the amounts, and the worst price and deposit cap, which the app computes itself from the market rather than taking from the server. Anything it does not recognise is refused. The server can refuse a trade; it cannot widen one.',
          'Perps setup and key enrollment are checked the same way. Each signed request carries an idempotency key: the same request sent twice was measured landing once.',
        ],
      },
      {
        id: 'kuru',
        question: 'How does a spot trade on Kuru work?',
        body: [
          'Kuru is an order book on chain, with four markets on testnet: MON, WETH, cbBTC and XAUt, each against USDC (for example [MON-USDC](/markets/kuru/MON-USDC)). Your wallet first moves USDC or the token you sell into your Kuru account (an approve, then a deposit), then places the order. If the account already holds some, only the shortfall is deposited.',
          'A limit order rests on the book until it fills or you cancel it. A market order carries a worst price from your slippage setting and fills immediately or not at all, so part of it can fill and the rest is cancelled. Money in your Kuru account can be withdrawn back to your wallet. Every step is a sponsored send from your wallet.',
          'Trading by hand can be switched off on a deployment. When it is, a market points you to an agent instead.',
        ],
      },
      {
        id: 'perps',
        question: 'How do perps on Perpl work?',
        body: [
          'Perpl is a perpetual-futures exchange on Monad, settled in AUSD. [Set up perps](/trade/perpl-setup) does two things, once: it opens your Perpl account with at least 100 AUSD and lets Perpl forward your orders (three transactions from your wallet), then it enrolls a trade key.',
          'The trade key is an Ed25519 key your device derives from your device key, under the label `sente.perpl.trade-key.v1`. It is never stored, and Sente’s server never sees it. Enrolling it takes a signature from your wallet over Perpl’s own request, which the app checks field by field first.',
          'Sente’s server enrolls a separate read-only key for your account, so [Portfolio](/portfolio) can show your positions. That key cannot trade: Perpl refused an order placed with it. The server keeps it encrypted.',
          'Orders are market orders, bounded at 1% from the mark price, with isolated margin and leverage set per order. You close a position from its page. Try [BTC-PERP](/markets/perpl/BTC-PERP).',
        ],
      },
      {
        id: 'relay',
        question: 'Why do perps on the web go through Sente’s relay?',
        body: [
          'Perpl’s testnet refuses browsers: its trading socket answers a page from sente.lol with 403, and its API sends no CORS headers. So the web app reaches Perpl through a relay under `/perpl` on Sente’s API, which forwards to Perpl’s testnet with Perpl’s own origin. The Android app connects to Perpl directly.',
          'The trade-off: Perpl checks a socket once, with a sign-in your trade key signs, and the order messages after it are not signed. Whoever runs the relay could therefore inject orders into your open socket. It can never withdraw: a withdrawal is a transaction on chain that only your wallet signs. Testnet only.',
        ],
      },
      {
        id: 'stop-loss',
        aliases: ['stops'],
        question: 'Why is there no stop-loss or take-profit?',
        body: [
          'Neither venue offers them on testnet: Kuru’s trigger orders are disabled there, and Perpl does not have them yet. In Sente a stop can only be a price line that something checks, not an order resting on the venue.',
          'That is what the [Guardian](/presets/guardian) preset is: an agent that holds a position on Kuru and sells when the best bid crosses either of two lines. It checks at every run, so between runs the price can pass a line, and the sale fills at the price it sees then.',
        ],
      },
    ],
  },
  {
    id: 'agents',
    icon: 'agents',
    title: 'Agents',
    summary: 'An agent trades from its own wallet, inside a mandate a hardware enclave enforces.',
    items: [
      {
        id: 'mandate',
        question: 'What is a mandate?',
        body: [
          'A mandate is what you allow one agent to do: which venues and markets, how much can go in per transaction, the maximum leverage on Perpl, and when it expires. Each agent has its own Privy wallet, separate from yours, and Sente compiles the mandate into a Privy policy on that wallet. A policy holds only allow rules, and Privy refuses to sign anything no rule allows.',
          'Three keys touch that wallet. The agent’s key is only a signer: it can ask for signatures the policy allows. Your [device key](#passkey) owns both the policy and the wallet. Sente’s own key has no power over either. Measured live: the agent’s key tried to detach the policy, change the owner and add a signer, and got 401 every time. Sente’s server key got 401 on both the policy and the wallet, and the device key got 200.',
          'Start from a preset on [Agents](/agents), or [hire an agent](/agents/new) and write the mandate yourself.',
        ],
      },
      {
        id: 'limits',
        aliases: ['enforcement', 'who-enforces'],
        question: 'What does the enclave enforce, and what does Sente check?',
        body: [
          'Privy signs inside a hardware enclave (AWS Nitro). Its policy reads only what is in the request being signed: the contract called, the function and its arguments, the value, the chain and the time. Those limits are checked inside the enclave at signing time, so neither the agent nor a compromised server can get past them: which contracts the agent may call, how much it may approve or deposit per transaction, how much AUSD can reach Perpl, and when the mandate expires.',
          'Some limits are not visible in a transaction, so Sente’s own check enforces them before Privy is asked: Perpl order size and leverage (a Perpl order is a signed API call, not a transaction), and the size of a Kuru order, which sits inside a call the enclave does not read into. The enclave bounds the capital that can reach Perpl, not each Perpl order.',
          'Caps are per transaction, so one cap can be split across several transactions. A rolling cap over a time window is best effort: Privy records it after signing, so two writes close together can overshoot it, and Sente spaces an agent’s writes 5 seconds apart to narrow that. An amend or revoke takes about 0.3 to 1.4 seconds to reach the enclave; it is not instant.',
        ],
      },
      {
        id: 'markets',
        question: 'Why can an agent trade only some markets?',
        body: [
          'On Kuru, every market is its own order-book contract, and the policy allows calls only to the order books your mandate names, one rule per market. A market that is not in the policy cannot be traded, whatever the agent asks. Kuru lists four markets on testnet.',
          'On Perpl, the market list is checked by Sente, for the same reason as order size: Perpl orders are not transactions. Changing either list means [amending the mandate](#amend).',
        ],
      },
      {
        id: 'amend',
        aliases: ['revoke'],
        question: 'How do I change or stop an agent?',
        body: [
          'Amending and revoking are signed by your device key, so they ask for your passkey. Sente’s server prepares the change; the app compiles the mandate again itself and signs only if the policy it is asked to approve matches exactly. One extra rule would be one extra thing the agent could sign.',
          'A revoke stops the agent in Sente straight away (its runs and its MCP token are refused) and replaces its policy with only the rules that send money back to you. The enclave applies the change about 0.3 to 1.4 seconds later. Your agents are on [Agents](/agents?segment=yours).',
        ],
      },
      {
        id: 'return-funds',
        question: 'Can an agent send my money somewhere else?',
        body: [
          'No rule lets it. The only ways out of an agent’s wallet are a Kuru withdraw, which always pays the agent’s own wallet, and token transfers pinned to your wallet’s address. Sente fills in that address from your registered wallet, and the app cannot name another.',
          'Those two rules have no expiry and survive a revoke, so “Return funds” on an agent’s page works on an expired or revoked agent too. Leftover MON for gas stays with the agent.',
        ],
      },
      {
        id: 'runs',
        aliases: ['schedule'],
        question: 'When does an agent run, and what does a run do?',
        body: [
          'An agent runs when you start a run from its page, or on its own schedule if you give it one (from every minute to every 7 days). Scheduled runs are held back when your credits run low or the agent reaches its daily cap.',
          'A run is one bounded loop. The model gets a snapshot (balances, positions, open orders and the order book of each market it may trade), calls tools, and stops: at most 12 turns and 3 minutes by default. It must record a thesis before it trades a market. Runs are billed to your own OpenRouter key, which has a monthly spending limit. The models are Kimi K2.6 and Claude Sonnet 5.',
          'Everything an agent does (theses, orders, fills, refusals, and a summary of each run) is written to its Agent Ledger, on the agent’s page.',
        ],
      },
      {
        id: 'tools',
        question: 'What tools does an agent have?',
        body: [
          'To read: its mandate, the markets, order-book depth, candles, Perpl funding, a quote, balances, positions, open orders, and [Nansen](#nansen) smart-money signals. To act: record a thesis, place a limit or market order, deposit, withdraw, cancel an order, and close a position.',
          'Every action passes Sente’s check and then [the enclave](#limits). A refusal is final and goes on the Ledger; the agent is told not to route around it.',
        ],
      },
      {
        id: 'presets',
        question: 'What is a preset?',
        body: [
          'A ready-made strategy, such as [Guardian](/presets/guardian), that fills in the agent’s instructions and a mandate from a few settings. You read and adjust it before hiring. Presets are on [Agents](/agents).',
        ],
      },
      {
        id: 'mcp',
        question: 'Can I connect my own AI client?',
        body: [
          'Yes, over MCP. When you hire an agent, Sente shows its MCP token once and keeps only a hash of it. An MCP client such as Claude Desktop, connected to the `/mcp` endpoint of Sente’s API with that token, trades for that one agent: the same tools, the same check by Sente and the same enclave policy as Sente’s own runs.',
          'Actions from an MCP session are not spaced apart the way Sente’s runs are.',
        ],
      },
    ],
  },
  {
    id: 'market-data',
    aliases: ['data'],
    icon: 'markets',
    title: 'Market data & leaderboard',
    summary: 'Prices come from the venues, through one cache every screen and agent shares.',
    items: [
      {
        id: 'prices',
        question: 'Where do prices and candles come from?',
        body: [
          'Kuru: the market list and candles from Kuru’s data source, depth from Kuru’s gateway, and quotes from the order book on chain. The quote reads the chain because its worst price is what your order is sent with, so it has to be the book the order will meet.',
          'Perpl: prices from Perpl’s API, cached for 3 seconds, and depth and quotes from a Perpl order-book socket Sente’s API keeps open.',
          'Sente’s API caches each read briefly (from 1.5 seconds for a Kuru quote to 60 seconds for the market list), so a venue sees one request per window however many screens and agents are watching. Charts are the venues’ own candles; there is no live candle streaming yet. See [Markets](/markets).',
        ],
      },
      {
        id: 'leaderboard',
        question: 'How is the leaderboard ranked?',
        body: [
          'From Kuru fills, indexed by Envio HyperIndex. n is the number of settled trades, win rate is wins ÷ n, and ROI is realised PnL ÷ capital deployed (the stablecoins moved into Kuru, net of withdrawals). Fees are not taken out of PnL. An agent with fewer than 3 settled trades is listed but not ranked. See [Top](/agents?segment=top).',
          'Perpl is not indexed: its exchange emits about 216,000 events an hour, and the indexer’s Envio plan stops at 100,000 events in total. An agent’s Perpl results come from its own event log instead, labelled as such and never added to the ranking.',
          'The Kuru-only indexer has not been redeployed yet, so the ranking has not been answered by a live index.',
        ],
      },
      {
        id: 'nansen',
        question: 'What does Nansen cover?',
        body: [
          'Agents can read Nansen’s smart-money signals as a tool, cached because the free plan is small. Nansen covers Monad mainnet only, and its coverage there is near empty, so the tool answers that it has no data rather than inventing a signal.',
        ],
      },
    ],
  },
  {
    id: 'honest-limits',
    aliases: ['honest'],
    icon: 'shield',
    title: 'Honest limits',
    summary: 'Testnet only: what is proven, what is not, and where your data lives.',
    items: [
      {
        id: 'testnet',
        question: 'Is this real money?',
        body: [
          'No. Everything runs on Monad testnet (chain 10143). The tokens have no value, and both venues are testnet deployments. Sente runs on Android and in desktop web browsers; iOS is out of scope.',
        ],
      },
      {
        id: 'proven',
        question: 'What has been proven live, and what hasn’t?',
        body: [
          'Proven on testnet, with transaction hashes in the repository: the enclave refusing an agent’s over-mandate deposit with Sente’s check turned off, and the same deposit landing after the owner raised the cap; the agent’s key and Sente’s key both unable to change a policy; Kuru and Perpl trades from an agent’s wallet, including a run a model drove; a revoked agent’s funds going back to its owner; a sponsored send from a wallet holding 0 MON; and your own Kuru trades, perps setup, key enrollment and a perp opened and closed through the app’s code.',
          'Not proven yet: that one passkey gives the same wallet on the phone and on the web; how many prompts Google Password Manager shows; Windows Hello and iCloud Keychain; the leaderboard against a live index; ERC-8004 identity and reputation (the registries are read live, but no transaction has been sent). The live perp round trip connected to Perpl directly, not through the [web relay](#relay). Revoke has not been tapped on a physical phone.',
        ],
      },
      {
        id: 'storage',
        question: 'What does Sente store, and where?',
        body: [
          'On one server, in one state directory (`STATE_DIR`): the registry of user wallets, agents and their event logs, starter-kit records, profiles, value history, and venue credentials (your Perpl read key is encrypted under a server-side key). Your passkey and the keys derived from it never reach the server.',
          'Some state is only in memory: sign-in challenges and prepared approvals do not survive a restart. Only one API process can use the directory at a time, so the API cannot run more than one copy yet.',
        ],
      },
      {
        id: 'region',
        question: 'Where does it run?',
        body: [
          'On a single server in one region, Madrid (`europe-southwest1`), with no second copy to fail over to. It moved there from the US on 2026-10-09 because Perpl’s testnet trading socket refuses connections from US addresses.',
        ],
      },
    ],
  },
];

/** Where an anchor points: a section, or a question inside one. */
export type AnchorTarget = { readonly sectionId: string; readonly itemId: string | null };

/** Every anchor on the page (ids and aliases), mapped to what it opens. */
export function anchorIndex(
  sections: readonly HelpSection[] = SECTIONS,
): ReadonlyMap<string, AnchorTarget> {
  const index = new Map<string, AnchorTarget>();
  for (const section of sections) {
    for (const name of [section.id, ...(section.aliases ?? [])])
      index.set(name, { sectionId: section.id, itemId: null });
    for (const item of section.items)
      for (const name of [item.id, ...(item.aliases ?? [])])
        index.set(name, { sectionId: section.id, itemId: item.id });
  }
  return index;
}

/** Every anchor name in page order, duplicates included (the test wants to see them). */
export function anchorNames(sections: readonly HelpSection[] = SECTIONS): string[] {
  return sections.flatMap((section) => [
    section.id,
    ...(section.aliases ?? []),
    ...section.items.flatMap((item) => [item.id, ...(item.aliases ?? [])]),
  ]);
}

const ANCHOR_INDEX = anchorIndex();

/** `#mandate`, `mandate` or `%23mandate` → its target; null for anything unknown. */
export function resolveAnchor(raw: string | null | undefined): AnchorTarget | null {
  if (!raw) return null;
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // A malformed escape is just an unknown anchor.
  }
  return ANCHOR_INDEX.get(name.replace(/^#/, '')) ?? null;
}
