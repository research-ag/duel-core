# ultimate-tic-tac-toe duel — reference #alternating game built on duel-game-core

A complete, deployable example game that plugs into the two
`duel-game-core` packages this repo ships (`../../backend`, the Motoko
mops package; `../../frontend`, the npm package). Ultimate tic-tac-toe
(https://en.wikipedia.org/wiki/Ultimate_tic-tac-toe): a 3x3 META-board of
nine ordinary 3x3 tic-tac-toe LOCAL boards. Whichever cell position a
mark lands on within its own local board (0-8, row-major) routes the
opponent to the local board at that SAME position next — unless that
board is already decided (won or tied), in which case they may play in
any undecided board. Three of a seat's own local-board wins in a row,
column, or diagonal on the meta-board wins the whole match; every local
board decided with no meta-line completed is a draw. It exists alongside
`examples/checkers` and `examples/tic-tac-toe` as a third `#alternating`
reference — the one with real state beyond a flat board (nine
independent sub-games plus a routing rule linking them) — and gives a
new "state layered on top of several smaller states" game something
concrete to copy; it is **not** part of either package itself.

- **`src/UltimateTicTacToeRules.mo`** — the game logic as pure functions.
  No actor, no shared functions, no storage, no Time. Plugs into the
  engine via `spec() : TP.Spec<State, Action>`, where `TP` is
  `mo:duel-game-core` (imported from `../../backend` — see `mops.toml`).
  `spec()` returns `#alternating { init; validate; resolve }`. `State`
  carries `cells` (all 81 cells flattened, `index = board*9 + cell`),
  `results` (which seat, if either, has decided each of the nine local
  boards — `#p1`/`#p2`/`#tie`), and `activeBoard` (`?Nat`: `Some(b)` when
  the next placement must land in local board `b`, `null` when routing is
  free because the target board named by the last cell played was
  already decided). `LINES` (the eight 3-in-a-row lines of a 3x3 grid) is
  a single constant reused identically for both a local board's own win
  check (over `cells`) and the meta-board's own win check (over
  `results`) — the same geometry, one level up. `legalActions(s, seat)`
  enumerates every empty cell of every board `activeBoard`/`results`
  together currently allow — legality here doesn't depend on `seat` at
  all, same as `examples/tic-tac-toe`'s own `legalActions` — exported
  specifically so a caller doesn't have to re-derive "which boards are
  open, and which cells within them are empty" itself; `BotLogic.mo`'s
  canister player is its first real consumer. See the module's own doc
  header for the full rules text.
- **`src/Host.mo`** — the host actor, identical in shape to
  `examples/tic-tac-toe/src/Host.mo` (down to the metrics/canister-players/
  bot-discovery/ELO-leaderboard wiring) — see that file's own `CLAUDE.md`
  bullet for the full explanation; nothing about this game's own extra
  state changes how a host actor is wired. `Registry.new(60_000_000_000,
15_000_000_000)`, `STARTING_ELO = 1200` — same defaults as
  `examples/tic-tac-toe`.
- **`src/BotIface.mo`** — the `CanisterPlayer` Candid interface an
  ultimate-tic-tac-toe canister player must implement: one method,
  `make_move : (TP.MoveRequest<Rules.State, Rules.Action>) -> async
Rules.Action`.
- **`bot/BotLogic.mo`** — the bot's move-selection logic, as a plain pure
  module (no actor, no `Time`, matching `UltimateTicTacToeRules.mo`'s own
  style): `chooseMove` reuses `UltimateTicTacToeRules.legalActions`
  directly and picks one result deterministically from `req.turn` and the
  position — no lookahead, no win/block detection, the same shape
  `examples/tic-tac-toe/bot/BotLogic.mo`/`examples/checkers/bot/BotLogic.mo`
  use (`moves[req.turn % moves.size()]`). No per-seat multiplier is
  needed here either (contrast `examples/rock-paper-scissors`'s own bot):
  each placement permanently removes a cell from the legal set AND
  `activeBoard` keeps reshuffling which BOARDS are even in play, so the
  position — and therefore each bot's own pick — keeps changing turn to
  turn even with an identical formula on both seats. Kept separate from
  `Bot.mo` so `test/Bot.test.mo` can call `chooseMove` directly, with no
  actor/Candid round-trip.
- **`bot/Bot.mo`** — the bot canister itself: implements
  `BotIface.CanisterPlayer`'s `make_move` as a `query` (a thin shell over
  `BotLogic.chooseMove`), plus `play(host, tableId, seat, code, complexity)` (Flow 1's
  self-join entry point) and `register(host, name)`/`unregister(host)`
  for bot discovery (registering an empty complexity list — one way to
  play, listed under "Default"; `examples/tic-tac-toe/bot/` is the
  two-way reference). Deploy target (see `icp.yaml`). Because every reply
  is drawn from `legalActions`, this bot can never submit an illegal
  move, even without any lookahead of its own.
- **`test/*.test.mo`** — interpreter-run suites. `RulesUnit.test.mo`
  drives `validate`/`resolve`/`legalActions` directly against synthetic
  states (no engine, no actor): free-choice vs. routed-to-one-board vs.
  routed-to-an-already-decided-board legality, a local board won without
  ending the match, a local board tied, a completed meta-line winning the
  whole match, and every local board decided with no meta-line as a
  draw. `Engine.test.mo` plugs the real rules into the real `Table`
  primitive, focused on what's specific to this game on top of plain
  `#alternating` mechanics: board routing enforced through `submit` (a
  wrong-board resubmission refused, not just an occupied cell), and
  claim-win gated to the waiting seat — the engine's own generic
  `#alternating` mechanics already have their own exhaustive suite in
  `duel-game-core` itself (`../../backend/test/Alternating.test.mo`), so
  this isn't a second copy of that. `Lifecycle.test.mo` is one short
  session narrative through the real engine — join, a couple of genuine
  opening moves (exercising routing for real), then the live board is
  seeded directly via `Table.phase`'s own public `var` field to a
  position one legal placement from winning the WHOLE match, so the
  ending itself is still exercised for real — only the long middle game
  (up to 81 plies in the worst case) is skipped. `test/Bot.test.mo`
  covers `BotLogic.mo`: it confirms `chooseMove` only ever returns a
  `UltimateTicTacToeRules.legalActions`-listed move — including a board
  routed down to its very last empty cell, where exactly one result
  exists — then separately wires `BotLogic.chooseMove` through a live
  `mo:duel-game-core/canister_players` as the `callBot` continuation so
  TWO canister-seated bots play each other through several real
  `#alternating` plies, with a larger sweep budget than
  `examples/tic-tac-toe`'s own suite to allow for this board's much
  longer worst-case game length. The `*.test.mo` suffix is what `mops
test` discovers — a file named `FooTest.mo` is silently skipped.
- **`icp.yaml`** — icp-cli manifest; deploys `src/Host.mo` as canister
  `backend`, `bot/Bot.mo` as canister `bot`, and `frontend/dist` (esbuild's
  bundled output — see this file's "Build & test" section, NOT
  `frontend/` itself) as an asset canister.
- **`frontend/`** — vanilla-JS web client (no framework), bundled with
  esbuild (`npm run build`); `duel-game-core` is fetched locally via `npm
install`. `uttt-plugin.js` is the whole game-specific surface: it
  implements the `GamePlugin` contract (`idlTypes`, `seatLabel`,
  `renderBoard`, `renderActions`). Interaction is a single click per
  move, same as `examples/tic-tac-toe/frontend/src/tictactoe-plugin.js`
  — every empty cell of a currently-playable local board renders directly
  as a real `<button data-act=...>` (`actionAttr({ place: { board, cell
} })`), submitted unchanged the instant it's clicked; a cell is
  "currently playable" precisely when its own local board is undecided
  AND is either the one board `activeBoard` names or, when `activeBoard`
  is `null`, any undecided board qualifies. `renderBoard` renders the
  meta-board as nine local-board panels (`.uttt-local-board`), each its
  own 3x3 grid (`.uttt-local-grid`); the board(s) currently open for play
  get a highlighted outline (`.uttt-active`), and a decided local board
  fades its grid and shows a large overlay mark or "draw"
  (`.uttt-board-won`) instead. `renderActions` itself returns nothing (an
  empty string) — everything happens by clicking the board, same as
  `examples/tic-tac-toe`. `app.js` is identical in shape to
  `examples/tic-tac-toe/frontend/src/app.js` (same leaderboard toggle,
  same "🤖 Bots" challenge flow) — see that file's own extensive inline
  comments for how each piece works; nothing there is game-specific.
  `style.css` here holds only the meta-board/local-board grid layout, the
  active/decided-board visuals, and the X/O mark colors, layered on top
  of `duel-game-core.css`.

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
- The frontend's npm dependencies split the same way `examples/tic-tac-toe`'s
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
cd examples/ultimate-tic-tac-toe
mops install                       # fetches duel-game-core (../../backend) + core

# Type-check:
moc --check $(mops sources) src/UltimateTicTacToeRules.mo
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
cd examples/ultimate-tic-tac-toe
icp deploy                 # local  → http://frontend.local.localhost:8000/
icp deploy --network ic    # mainnet — spends cycles
```

The asset-canister recipe must be **v2.3.0 or newer** (v2.1.0 syncs with
an `assets` step icp-cli 1.x rejects outright).

Play both seats by opening the deployed URL in two separate browser
tabs — create a table in one, join it from the other, and confirm a real
game (turn alternation, board routing following the cell just played,
free choice after being routed to an already-decided board, a local-board
win/tie, a meta-line win, a full-board draw, claim-win while waiting on an
idle opponent) plays out correctly. The Motoko tests passing and the
frontend building are both necessary but not sufficient; nothing here
automates an actual two-tab playthrough.

## Architecture rules

This game inherits every rule in `../../CLAUDE.md`'s "Architecture rules"
section (spec passed per call / never stored, the engine owns time, rules
stay pure, `validate` is the only legality gate, etc.) — read that file
first. Rules specific to this example:

1. **The engine lives in `../../backend` and is never vendored here.**
   `src/UltimateTicTacToeRules.mo` and `src/Host.mo` import it as
   `mo:duel-game-core`. If you find yourself copy-pasting engine code into
   this directory to fix something, fix it in `../../backend/src/lib.mo`/
   `table.mo` instead and re-run `mops install` here.
2. **The generic screens live in `../../frontend` and are never vendored
   here either.** `uttt-plugin.js` supplies ONLY `idlTypes`/`seatLabel`/
   `renderBoard`/`renderActions`; the multi-table lobby, staging, rematch,
   busy, debrief chrome, and the turn-accurate copy for `#alternating` all
   come from `duel-game-core/render.js` and `app.js`.

## Game-rule notes (src/UltimateTicTacToeRules.mo)

- Cells: 81, flattened (`index = board*9 + cell`), each `board`/`cell`
  0-8, row-major within its own 3x3 grid. `#p1` = X, moves first; `#p2` =
  O.
- The eight winning lines (three rows, three columns, two diagonals) are
  a single fixed constant (`LINES`), reused identically for a local
  board's own win check and the meta-board's own win check — there's no
  larger board size or win-length to generalize to here.
- `activeBoard` is computed once per `resolve` call from the CELL
  position just played, checked against the FRESH `results` (i.e.
  including the local-board decision this exact move may have just
  produced) — a board decided by this very placement is correctly
  treated as already-decided when routing the opponent, not one ply
  stale.
- A tied local board (`#tie`) is decided — no further placement in it —
  but counts toward neither seat's own meta-line.
- Turn counter (`View.inGame.turn`) counts individual PLIES (one per
  submission), not move-pairs — `#alternating` mode's own convention,
  same as `examples/tic-tac-toe`/`examples/checkers`.
- No configurable board size, win length, or "most local wins on a full
  board" tie-break variant — the plain Wikipedia rules described above
  are the entire rules description; promoting any of them to a
  configuration field would go beyond what was actually asked for.

## Motoko skills (read before editing)

Local copies of the relevant Motoko-authoring SKILL.md playbooks live in
this repo under `../../.agents/skills/` — the same set `../../CLAUDE.md`
points to (the duel-game-core-specific playbook instead lives in the
tracked `../../skills/duel-game-core/`, whose
`references/alternating-turn-games.md` this example is a third, larger
worked reference for alongside `examples/checkers`/`examples/tic-tac-toe`).
Consult those before editing `src/UltimateTicTacToeRules.mo`, `src/Host.mo`,
or `bot/Bot.mo`/`bot/BotLogic.mo`.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `ok`/`expectErr` helpers + `Runtime.trap` on violation. Extend in kind.
  (In mo:core, `trap` lives in `Runtime`; `Debug` only has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update all four test suites when touching
  `src/UltimateTicTacToeRules.mo`'s semantics (including `legalActions` —
  it must keep returning exactly what `validate` would accept).
