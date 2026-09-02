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
