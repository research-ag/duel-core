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
