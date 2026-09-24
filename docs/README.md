# docs/

Working notes, not marketing. Each one records what was measured, against what,
on what date, and says so when a claim is inferred rather than observed. Where a
document contains a strikethrough or a "PENDING" section, a later section in the
same file supersedes it — read to the end before quoting.

Start with `privy-policy-enforcement.md` if you only read one.

| Doc                                                        | Answers                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [privy-policy-enforcement.md](privy-policy-enforcement.md) | Which parts of a mandate are really enclave-enforced, and who is allowed to change it  |
| [demo-refusal.md](demo-refusal.md)                         | How to run the refusal demo, and what each of its five acts proves                     |
| [agents.md](agents.md)                                     | How an agent's Privy wallet trades on Kuru and Perpl, and what landed on chain         |
| [user-wallet.md](user-wallet.md)                           | What the user's Privy wallet is, and why this server can never sign for it             |
| [privy-sponsorship.md](privy-sponsorship.md)               | Whether a user-owned Privy wallet can send with Privy paying the gas                   |
| [kuru.md](kuru.md)                                         | Which Kuru Spot V2 addresses, APIs and SDK are real, and how the adapter places orders |
| [monad-testnet-assets.md](monad-testnet-assets.md)         | Which Monad testnet addresses are real, what gas costs, and how to get funded          |
| [erc8004.md](erc8004.md)                                   | How an agent gets an on-chain ERC-8004 identity and a reputation entry per verdict     |
| [indexer.md](indexer.md)                                   | What the Envio HyperIndex indexes, and how to run and verify it                        |
| [leaderboard.md](leaderboard.md)                           | How `GET /leaderboard` is ranked, and what each metric actually counts                 |
| [openrouter.md](openrouter.md)                             | How per-user model credits are minted, and whether tool use works through OpenRouter   |
| [nansen.md](nansen.md)                                     | What smart-money data the agents' Nansen tool reads, and how it stays in budget        |
| [deploy.md](deploy.md)                                     | How to deploy the API and build the release APK, what is secret, and how to roll back  |

Two transcripts sit beside `demo-refusal.md` rather than inside it, because they
are the evidence for it and are meant to be read unedited:

| File                                                           | What it is                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [demo-refusal.output.txt](demo-refusal.output.txt)             | The scripted run, 2026-09-11 — `ALL 24 CHECKS PASSED`                    |
| [demo-refusal.model.output.txt](demo-refusal.model.output.txt) | The same demo with a model deciding, 2026-09-13 — `ALL 23 CHECKS PASSED` |

Two conventions worth knowing before you read any of them:

- **Privy object ids are placeholders.** `<privy-app-id>`, `<sen44-agent-policy-id>`
  and friends stand in for real ids from live runs. EVM addresses and transaction
  hashes are **not** redacted: they are public on Monad testnet and they are the
  evidence.
- **Test-vector keys are published on purpose.** Anvil/Hardhat default keys appear
  in tests and in two live scripts. Anything derived from them is controllable by
  anyone — never send it something of value. `../CLAUDE.md` gotcha 11.
