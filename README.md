# duel-game-core

A generic 2-player game framework for the Internet Computer, for games
where both seats act at once and games where the rules say whose turn
it is. It is two rules-agnostic packages, `duel-game-core` on mops and
`@research-ag/duel-game-core` on npm:

- [`backend/`](backend/README.md): the Motoko mops package, with the engine
  (tables, seating, rounds, debrief, rematch, idle takeover, claims),
  the transport every client goes through, canister bots and a
  leaderboard.
- [`frontend/`](frontend/README.md): the npm package, with the matching client
  (identity, the polling transport, generic screens) plus a
  `GamePlugin` contract for a game's own board and moves.

**Start with [`DESIGN.md`](DESIGN.md)**: the overall design, with
diagrams of how a browser, the game canister and a bot interact. Each
package's README has its API. See [`CLAUDE.md`](CLAUDE.md) for
repo-wide conventions and build/test commands.

## Play

Every game built on the framework is listed on the
[Duel Dashboard](https://games.ic0.info/). The reference games in
[`examples/`](examples/) are live there too:
[Checkers](https://eag45-ayaaa-aaaac-qhela-cai.icp0.io/),
[Tic-Tac-Toe](https://umxxc-waaaa-aaaad-qmfya-cai.icp0.io/),
[Ultimate Tic-Tac-Toe](https://lmbbd-cyaaa-aaaah-qu5sq-cai.icp0.io/),
[Chopsticks](https://wrhvn-yiaaa-aaaak-qzg3a-cai.icp0.io/),
[Dots and Boxes](https://kh2gg-aiaaa-aaaau-ahhta-cai.icp0.io/),
[Rock Paper Scissors](https://gaiov-caaaa-aaaac-bga5q-cai.icp0.io/),
[Racing Duel](https://kenge-waaaa-aaaan-q6qea-cai.icp0.io/) and
[007 Duel](https://awvd7-gaaaa-aaaao-a3n4q-cai.icp0.io/), each against a
friend or a bot, free and with no sign-up.

## Building a game

[`skills/duel-game-core`](skills/duel-game-core/SKILL.md) is a skill for
Claude Code (or any agent that reads `SKILL.md` files) that walks
through building a whole game on these packages from nothing but a
plain-English rules description: the Motoko rules module, host actor,
tests, and frontend `GamePlugin`, from copy-and-fill-in templates. Its
`references/` cover going online, a canvas or 3D UI, porting an
existing client, and a game whose ending takes many rounds to reach in
a test. It is tracked in git, so it installs standalone into your own
game's repo:

```
npx skills add research-ag/duel-core --skill duel-game-core
```

An agent with the hosty.live connector needs no install: it loads the
skill with `hosty_get_skill { skill: "duel-game-core" }`, which is what
the Duel dashboard's prompts ask for. hosty.live serves a reviewed copy
of the skill, refreshed from this repository after each change to it.

Putting a game online needs no prior Internet Computer knowledge and
nothing installed on your computer. A Claude Code cloud session
(claude.ai/code) builds and tests the game in its own VM and puts it
online through [hosty.live](https://hosty.live/), a connector you add
to Claude once: first on free test canisters, then, when you approve
it in hosty.live, in canisters of your own paid by card (a few
dollars). A coding agent on your computer works the same way, and
`icp-cli` with your own identity and cycles is the third way. The
skill's
[`references/cloud-session.md`](skills/duel-game-core/references/cloud-session.md)
sets up the cloud session, and
[`references/going-live.md`](skills/duel-game-core/references/going-live.md)
walks through going online. The
[Duel Dashboard](https://games.ic0.info/)'s "Build a game" guide hands
you the prompt.

## Building your own frontend or bot for a listed game

Every game's backend serves its rules as plain text
(`https://<backend-id>.raw.icp0.io/semantics`), carries its Candid as
public metadata, and its exact module can be downloaded from
hosty.live's module store by the canister's public `module_hash`. So a
new frontend or a bot can be built and tested against a private copy
of the game from the canister id alone. The "Make your own frontend"
and "Build a bot" buttons in a game's info dialog on the Duel Dashboard
hand you a prompt for an AI coding agent;
[`references/frontend-for-existing-game.md`](skills/duel-game-core/references/frontend-for-existing-game.md)
and
[`references/bot-for-existing-game.md`](skills/duel-game-core/references/bot-for-existing-game.md)
are the procedures behind them.

## Duel Dashboard (`aggregator/`)

[`aggregator/`](aggregator/CLAUDE.md) is the Duel Dashboard, a separate
product built on this repo's Motoko/TypeScript tooling: an Internet
Identity login, a developer's own editable display name, and a public,
filterable grid of every registered game. It is not part of either
package above and not a game built on the session engine. Live at
[games.ic0.info](https://games.ic0.info/).

## Format the code

We use `prettier` with the `prettier-plugin-motoko` plugin (configured
in `.prettierrc`). The CI checks formatting on every pull request.

To format the code locally run:

```
npx -y prettier --plugin prettier-plugin-motoko --write '**/*.{mo,json,md}'
```

To only check the formatting (as CI does) run:

```
npx -y prettier --plugin prettier-plugin-motoko --check '**/*.{mo,json,md}'
```
