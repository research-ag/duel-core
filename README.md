# duel-game-core

A generic 2-player, turn-based game framework for the Internet Computer —
two rules-agnostic packages, both published as `duel-game-core`:

- [`backend/`](backend/README.md) — Motoko mops package: the session
  engine (join/seating, rounds, debrief, rematch, idle takeover, status).
- [`frontend/`](frontend/README.md) — npm package: the matching client
  plumbing (session identity, real-time push, generic screens) plus a
  `GamePlugin` contract for a game's own board and moves.

See each package's README for its integration contract. See
[`CLAUDE.md`](CLAUDE.md) for repo-wide conventions and build/test commands.

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

## Building your own frontend for a listed game

Every game's backend serves its rules as plain text
(`https://<backend-id>.raw.icp0.io/semantics`), carries its Candid as
public metadata, and serves the wasm it runs at `/wasm`, so a new
frontend can be built and tested locally from the canister id alone.
The "Make own frontend" button in a game's info dialog on the aggregator
hands you a prompt
for an AI coding agent;
[`references/frontend-for-existing-game.md`](skills/duel-game-core/references/frontend-for-existing-game.md)
is the procedure behind it.

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
