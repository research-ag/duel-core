# tic-tac-toe duel — reference #alternating game built on duel-game-core

A complete, deployable example game that plugs into the two
`duel-game-core` packages this repo ships (`../../backend`, the Motoko
mops package; `../../frontend`, the npm package). Standard 3x3
tic-tac-toe: X and O take turns placing their own mark on any empty
cell; three in a row (row, column, or diagonal) wins, a full board with
no line completed is a draw. It exists alongside `examples/checkers` as
a second, much smaller `#alternating` reference — a single-cell move
with no capture chains, no promotion, no mandatory-move rule — and gives
a new "seats take turns" game something small to copy; it is **not**
part of either package itself.

- **`src/TicTacToeRules.mo`** — the game logic as pure functions. No
  actor, no shared functions, no storage, no Time. Plugs into the engine
  via `spec() : TP.Spec<State, Action>`, where `TP` is `mo:duel-game-core`
  (imported from `../../backend` — see `mops.toml`). `spec()` returns
  `#alternating { init; validate; resolve }` — seats take turns in order
  (X/#p1 moves first), and `State` carries no "whose turn" flag of its
  own because the engine already tracks that. `legalActions(s, seat)`
  enumerates every empty cell — legality here doesn't depend on `seat` at
  all (either seat may place on any empty cell), unlike checkers' own
  `legalActions` — exported specifically so a caller doesn't have to
  re-derive "which cells are empty" itself; `BotLogic.mo`'s canister
  player is its first real consumer. See the module's own doc header for
  the full rules text.
- **`src/Host.mo`** — the host actor, identical in shape to
  `examples/checkers/src/Host.mo` (down to the metrics/canister-players/
  bot-discovery/ELO-leaderboard wiring) — see that file's own `CLAUDE.md`
  bullet for the full explanation; nothing about `#alternating` mode
  changes how a host actor is wired. `Registry.new(60_000_000_000,
15_000_000_000)`, `STARTING_ELO = 1200` — same defaults as
  `examples/checkers`.
- **`src/BotIface.mo`** — the `CanisterPlayer` Candid interface a
  tic-tac-toe canister player must implement: one method,
  `make_move : (TP.MoveRequest<Rules.State, Rules.Action>) -> async
Rules.Action`.
- **`bot/BotLogic.mo`** — the bot's move-selection logic, as a plain pure
  module (no actor, no `Time`, matching `TicTacToeRules.mo`'s own style).
  This is the repo's worked reference for a bot with more than one way
  to play (see `../../CLAUDE.md`'s "Canister players" note on
  `complexity`): `COMPLEXITIES = ["Easy", "Hard"]` is the list `Bot.mo`'s
  `register` sends to the host, and `chooseMove` switches on
  `req.complexity` between the two. `Easy` reuses
  `TicTacToeRules.legalActions` directly and picks one result
  deterministically from `req.turn` and the position — no lookahead, no
  win/block detection, the same shape `examples/checkers/bot/BotLogic.mo`
  uses (`moves[req.turn % moves.size()]`); unlike rock-paper-scissors'
  own bot, no per-seat multiplier is needed here, since each placement
  permanently removes a cell from the legal set, so the position — and
  therefore each bot's own pick — keeps changing turn to turn even with
  an identical formula on both seats. `Hard` is a full negamax search
  with alpha-beta pruning over `TicTacToeRules.resolve` itself (no line
  check re-derived here; `resolve`'s own verdict is the terminal test),
  which on a 3x3 board never loses. Any `req.complexity` the bot didn't
  declare plays `Easy`. Kept separate from `Bot.mo` so `test/Bot.test.mo`
  can call `chooseMove` directly, with no actor/Candid round-trip.
- **`bot/Bot.mo`** — the bot canister itself: implements
  `BotIface.CanisterPlayer`'s `make_move` as a `query` (a thin shell over
  `BotLogic.chooseMove` — `Hard`'s search is still a pure function of
  the request, so nothing about it needs an update call), plus
  `play(host, tableId, seat, code, complexity)` (Flow 1's self-join entry
  point — `complexity` is whichever of `BotLogic.COMPLEXITIES` the
  challenger picked, forwarded to `join_table_as_canister` and carried
  back on every `make_move` as `req.complexity`) and
  `register(host, name)`/`unregister(host)` for bot discovery
  (`register` sends `BotLogic.COMPLEXITIES` along, so the "🤖 Bots"
  dialog and the leaderboard list this bot as "TicTacToeBot (Easy)" and
  "TicTacToeBot (Hard)", each rated on its own). Deploy target (see
  `icp.yaml`). Because every reply is drawn from `legalActions`, this
  bot can never submit an illegal move at either complexity.
- **`test/*.test.mo`** — interpreter-run suites. `RulesUnit.test.mo`
  drives `validate`/`resolve` directly against synthetic boards (no
  engine, no actor): an empty vs. occupied vs. out-of-bounds cell, a row/
  column/diagonal win, a full-board draw, and `legalActions` mirroring
  `validate`'s own legality (including the zero-legal-moves case on a
  full board). `Engine.test.mo` plugs the real rules into the real
  `Table` primitive, focused on what an `#alternating` game specifically
  exercises through it (`Err.#notYourTurn`, immediate single-placement
  resolve, claim-win gated to the waiting seat, an occupied-cell
  resubmission refused) — the engine's own generic `#alternating`
  mechanics already have their own exhaustive suite in `duel-game-core`
  itself (`../../backend/test/Alternating.test.mo`), so this isn't a
  second copy of that. `Lifecycle.test.mo` is one short session narrative
  through the real engine — join, a couple of genuine opening moves,
  then the live board is seeded directly via `Table.phase`'s own public
  `var` field to a position one legal placement from finishing, so the
  ending itself is still exercised for real (tic-tac-toe's own middle
  game is short enough that this is a convenience, not a necessity, but
  it keeps this suite consistent with the other reference games').
  `test/Bot.test.mo` covers `BotLogic.mo`: it confirms `Easy` only ever
  returns a `TicTacToeRules.legalActions`-listed move — including on the
  board's very last empty cell, where exactly one result exists — and
  that `Hard` takes an immediate win, blocks an immediate threat, draws
  against itself, never loses to `Easy` from either seat, and that an
  undeclared complexity plays exactly like `Easy`; then separately wires
  `BotLogic.chooseMove` through a live `mo:duel-game-core/canister_players`
  as the `callBot` continuation so TWO canister-seated bots (one seated
  as `Hard`, one at its default) play each other through several real
  `#alternating` plies, asserting each ask's `req.complexity` is the
  seat's own. The `*.test.mo` suffix is what `mops test` discovers — a
  file named `FooTest.mo` is silently skipped.
- **`icp.yaml`** — icp-cli manifest; deploys `src/Host.mo` as canister
  `backend`, `bot/Bot.mo` as canister `bot`, and `frontend/dist`
  (esbuild's bundled output — see this file's "Build & test" section, NOT
  `frontend/` itself) as an asset canister.
- **`frontend/`** — vanilla-JS web client (no framework), bundled with
  esbuild (`npm run build`); `duel-game-core` is fetched locally via `npm
install`. `tictactoe-plugin.js` is the whole game-specific surface: it
  implements the `GamePlugin` contract (`idlTypes`, `seatLabel`,
  `renderBoard`, `renderActions`). Interaction is a single click per
  move — unlike checkers, a tic-tac-toe placement is never more than one
  cell, so there's no click-to-select state to track at all: every empty
  cell renders directly as a real `<button data-act=...>`
  (`actionAttr()`), submitted unchanged the instant it's clicked, while
  it's `yourTurn` (`renderBoard`'s own 4th parameter — see `GamePlugin`'s
  doc in `duel-game-core/render.js`); an occupied cell, or any cell at
  all when it isn't this seat's turn, renders as a plain, non-interactive
  `<div>`. `renderActions` itself returns nothing (an empty string) —
  everything happens by clicking the board, same as
  `examples/checkers/frontend/src/checkers-plugin.js`. `app.js` is
  identical in shape to
  `examples/checkers/frontend/src/app.js` (same leaderboard toggle, same
  "🤖 Bots" challenge flow) — see that file's own extensive inline
  comments for how each piece works; nothing there is checkers-specific.
  `style.css` here holds only the 3x3 grid layout and the X/O mark
  colors, layered on top of `duel-game-core.css`.

## Toolchain

- moc **1.11.2** (mops toolchain, pinned in `mops.toml`), node/npm for the
  frontend.
- Motoko dependencies: `duel-game-core` (path dependency on
  `../../backend`), `core` (mo:core), `ic-websocket-cdk` (via
  `mo:duel-game-core/ws`), and `promtracker` (via the metrics wiring) —
  see `../../CLAUDE.md`'s toolchain note. Neither is listed under this
  file's own `mops.toml` `[dependencies]` — both arrive transitively
  through `duel-game-core`'s own `mops.toml`. `src/Host.mo`'s
  `mo:duel-game-core/canister_players` opt-in needs nothing further
  either. Never import `mo:base` directly in this game's own code.
- The frontend's npm dependencies split the same way `examples/checkers`'s
  do: `duel-game-core` (`file:../../../frontend`) and `@icp-sdk/core` are
  what `app.js` itself needs; esbuild bundles both, plus everything
  `duel-game-core` needs transitively (`@icp-sdk/auth`, `cborg`), into a
  single `dist/app.js`. `frontend/.npmrc` sets `install-links=true`.
  **Gotcha:** because it's a copy, not a symlink, a plain `npm install`
  after editing `../../frontend/` reports "up to date" and does NOT
  refresh the copy — see `../../CLAUDE.md`'s "After touching anything
  under `frontend/`" section for the actual refresh procedure, and
  re-run `npm run build` HERE too afterward.

## Build & test

```bash
cd examples/tic-tac-toe
mops install                       # fetches duel-game-core (../../backend) + core

# Type-check:
moc --check $(mops sources) src/TicTacToeRules.mo
moc --check $(mops sources) src/Host.mo

# Run the test suites (interpreter mode; they Debug.print progress and end
# with "ALL ... CHECKS PASSED"; any trap = a FAIL, exit code 1):
mops test                  # all four
mops test Engine           # one suite — the filter is a path substring
mops test Rules            # ...so this matches RulesUnit
mops test Bot              # BotLogic.mo, offline and wired through canister_players
```

```bash
# Frontend: build duel-game-core first (its dist/ is what npm install
# actually copies), fetch the local duel-game-core npm package, then
# esbuild-bundle this frontend and sanity-check the bundled output parses:
(cd ../../frontend && npm run build)
cd frontend
npm install --legacy-peer-deps    # see ../../../frontend/README.md's note on @icp-sdk/auth's peer range
npm run build                     # esbuild bundle → frontend/dist/ (icp.yaml deploys THIS, not frontend/ itself)
node --check dist/app.js
```

Deploy (icp-cli; `icp network start` must be running for the local env):

```bash
cd examples/tic-tac-toe
icp deploy                 # local  → http://frontend.local.localhost:8000/
icp deploy --network ic    # mainnet — spends cycles
```

The asset-canister recipe must be **v2.3.0 or newer** (v2.1.0 syncs with
an `assets` step icp-cli 1.x rejects outright).

Play both seats by opening the deployed URL in two separate browser
tabs — create a table in one, join it from the other, and confirm a real
game (turn alternation, a win by each of row/column/diagonal, a draw,
claim-win while waiting on an idle opponent) plays out correctly. The
Motoko tests passing and the frontend building are both necessary but
not sufficient; nothing here automates an actual two-tab playthrough.

## Architecture rules

This game inherits every rule in `../../CLAUDE.md`'s "Architecture rules"
section (spec passed per call / never stored, the engine owns time, rules
stay pure, `validate` is the only legality gate, etc.) — read that file
first. Rules specific to this example:

1. **The engine lives in `../../backend` and is never vendored here.**
   `src/TicTacToeRules.mo` and `src/Host.mo` import it as
   `mo:duel-game-core`. If you find yourself copy-pasting engine code into
   this directory to fix something, fix it in `../../backend/src/lib.mo`/
   `table.mo` instead and re-run `mops install` here.
2. **The generic screens live in `../../frontend` and are never vendored
   here either.** `tictactoe-plugin.js` supplies ONLY `idlTypes`/
   `seatLabel`/`renderBoard`/`renderActions`; the multi-table lobby,
   staging, rematch, busy, debrief chrome, and the turn-accurate copy for
   `#alternating` all come from `duel-game-core/render.js` and `app.js`.

## Game-rule notes (src/TicTacToeRules.mo)

- Board: 9 cells, row-major (`index = row*3 + col`). `#p1` = X, moves
  first; `#p2` = O.
- The eight winning lines (three rows, three columns, two diagonals) are
  a fixed constant (`LINES`), not derived geometry — there's no larger
  board size or win-length to generalize to here.
- A placement is legal on any empty cell regardless of which seat is
  placing — unlike checkers, legality never depends on `seat` at all.
- Turn counter (`View.inGame.turn`) counts individual PLIES (one per
  submission), not move-pairs — `#alternating` mode's own convention,
  same as checkers.
- No configurable win length or board size — a fixed 3x3 board with
  3-in-a-row is the entire rules description; promoting either to a
  configuration field would go beyond what was actually asked for.

## Motoko skills (read before editing)

Local copies of the relevant Motoko-authoring SKILL.md playbooks live in
this repo under `../../.agents/skills/` — the same set `../../CLAUDE.md`
points to (the duel-game-core-specific playbook instead lives in the
tracked `../../skills/duel-game-core/`, whose
`references/alternating-turn-games.md` this example is a second, smaller
worked reference for alongside `examples/checkers`). Consult those
before editing `src/TicTacToeRules.mo`, `src/Host.mo`, or
`bot/Bot.mo`/`bot/BotLogic.mo`.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `ok`/`expectErr` helpers + `Runtime.trap` on violation. Extend in kind.
  (In mo:core, `trap` lives in `Runtime`; `Debug` only has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update all four test suites when touching `src/TicTacToeRules.mo`'s
  semantics (including `legalActions` — it must keep returning exactly
  what `validate` would accept).
