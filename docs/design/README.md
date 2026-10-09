# Goban — Sente's UI direction

Static HTML proposals for the app's redesign. Nothing here is wired into `apps/mobile` yet; review
first, then port.

- `mockups.html`: eight screens (welcome, home, agents, agent, hire/mandate, approve sheet, ledger,
  board), each with notes on what changed from the current app and why.
- `design-system.html`: principles, colour, type, the ledger stones, the consensus ramp,
  components, motion, voice, and the `theme.ts` mapping.
- `sente.css`: tokens and components shared by both pages.
- `sigil.js`: the per-agent goban sigil, seeded from the agent id.

Open them over HTTP so the stylesheet and fonts load:

```bash
cd docs/design && python -m http.server 8787   # http://localhost:8787/mockups.html
```

## The idea in one paragraph

Sente is the Go word for holding the initiative, so the app borrows the board. Agents place stones
in the ledger, and each entry kind has its own stone. The enclave's mandate is drawn as territory,
with gauges showing how much of each limit an agent has used. Monad purple (`#836EF9`) marks an
event, like an agent acting or a block landing, and the ground is Monad's night rather than a
neutral black. Each of the four typefaces belongs to one speaker: Bricolage Grotesque for display
text, Geist for the app, and Geist Mono for the machines: purple and at reading size when the agent speaks, small and dim
for the chain.
