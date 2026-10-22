# duel-game-core

A generic 2-player game framework for the Internet Computer — for
games where both seats act at once and games where the rules say whose
turn it is — in two rules-agnostic packages, both published as
`duel-game-core`:

- [`backend/`](backend/README.md) — Motoko mops package: the engine
  (tables, seating, rounds, debrief, rematch, idle takeover, claims),
  the transport every client goes through, canister bots and a
  leaderboard.
- [`frontend/`](frontend/README.md) — npm package: the matching client
  (identity, the polling transport, generic screens) plus a
  `GamePlugin` contract for a game's own board and moves.

**Start with [`DESIGN.md`](DESIGN.md)** — the overall design, with
diagrams of how a browser, the game canister and a bot interact. Each
package's README has its API. See [`CLAUDE.md`](CLAUDE.md) for
repo-wide conventions and build/test commands.

## Building a game

[`skills/duel-game-core`](skills/duel-game-core/SKILL.md) is a skill for
Claude Code (or any agent that reads `SKILL.md` files) that walks
through building a whole game on these packages from nothing but a
plain-English rules description: the Motoko rules module, host actor,
tests, and frontend `GamePlugin`, from copy-and-fill-in templates —
plus, for a canvas/3D UI, porting an existing client, or a game whose
ending takes many rounds to reach in a test, its own `references/`.
Tracked in git, so it installs standalone into your own game's repo:

```
npx skills add research-ag/duel-core --skill duel-game-core
```

Putting a game online needs no prior Internet Computer knowledge and
nothing installed on your computer: a Claude Code cloud session
(claude.ai/code) builds and tests the game in its own VM, and puts the
backend and the frontend online through [hosty.live](https://hosty.live/)'s
MCP server, in canisters of your own paid by card (a few dollars), after
you approve the deploy in hosty.live with your passkey. A coding agent
on your computer works the same way, and `icp-cli` with your own
identity and cycles remains an option. The skill's
[`references/going-live.md`](skills/duel-game-core/references/going-live.md)
is the walkthrough; the aggregator's "Build a new game" guide hands you
the prompt.

## Building your own frontend or bot for a listed game

Every game's backend serves its rules as plain text
(`https://<backend-id>.raw.icp0.io/semantics`), carries its Candid as
public metadata, and its exact module can be downloaded from
hosty.live's module store by the canister's public `module_hash`, so a new
frontend or a bot can be built and tested against a private copy of
the game from the canister id alone. The "Make your own frontend" and "Build a bot" buttons in a
game's info dialog on the aggregator hand you a prompt for an AI coding
agent;
[`references/frontend-for-existing-game.md`](skills/duel-game-core/references/frontend-for-existing-game.md)
and
[`references/bot-for-existing-game.md`](skills/duel-game-core/references/bot-for-existing-game.md)
are the procedures behind them.

## Aggregator

[`aggregator/`](aggregator/CLAUDE.md) is a separate product built on
this repo's Motoko/TypeScript tooling: an Internet Identity login, a
developer's own editable display name, and a public, filterable grid of
every registered game — not part of either package above and not a game
built on the session engine. Live at
[n6plc-4yaaa-aaaaj-qshia-cai.icp.net](https://n6plc-4yaaa-aaaaj-qshia-cai.icp.net/).

### Format the code

We use `prettier` with the `prettier-plugin-motoko` plugin (configured in `.prettierrc`). The CI checks formatting on every pull request.

To format the code locally run:

```
npx -y prettier --plugin prettier-plugin-motoko --write '**/*.{mo,json,md}'
```

To only check the formatting (as CI does) run:

```
npx -y prettier --plugin prettier-plugin-motoko --check '**/*.{mo,json,md}'
```
