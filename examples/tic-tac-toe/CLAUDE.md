# tic-tac-toe duel — reference #turnBased game built on duel-game-core

Standard 3x3 tic-tac-toe: the smallest `#turnBased` reference, and the
reference for a bot with two complexities. Not part of either package.

- **`src/TicTacToeRules.mo`** — `#turnBased`, X/`#p1` first; `toMove`
  is derived from the number of marks (no turn field in `State = {
board }`); `move` = `validate` then `resolve`; `View = State`, `Options
= {}`. `legalActions(s, seat)` is every empty cell (seat-independent).
- **`src/Host.mo`** — same shape as `examples/checkers/src/Host.mo`
  (metrics, canister players, bot discovery, ELO; 90s/60s, `STARTING_ELO
= 1200`).
- **`src/BotIface.mo`** — `make_move`.
- **`bot/BotLogic.mo`** — `COMPLEXITIES = ["Easy", "Hard"]`. Easy:
  `legalActions(...)[step % n]`. Hard: negamax with alpha-beta over
  `Rules.resolve` itself, never loses. Unknown complexities play Easy.
- **`bot/Bot.mo`** — `make_move` (`query`), `play(...)`, `register`/
  `unregister` (sends `COMPLEXITIES`, listing "TicTacToeBot (Easy)" and
  "(Hard)").
- **`test/*.test.mo`** — `RulesUnit` (empty/occupied/out-of-bounds, each
  line type, full-board draw, `legalActions`); `Lifecycle`
  (join, opening moves, seed to one placement from the end); `Bot` (Easy
  stays legal including the last cell; Hard wins, blocks, draws itself,
  never loses to Easy; unknown complexity = Easy; two canister bots at
  different complexities through real plies).
- **`icp.yaml`** — `backend`, `bot`, `frontend/dist`.
- **`frontend/`** — `tictactoe-plugin.js`: every empty cell is a `data-act`
  button while `yourTurn`, otherwise a plain `<div>`; the opponent's last
  mark (`.ttt-last`) is found by diffing consecutive boards, since `State`
  has no move history; `applyLocal` places your mark the moment you
  click; `renderActions` returns `""`. `app.js` matches `examples/checkers`.

## Toolchain / Build & test

Same as `examples/checkers` (moc 2.0.0; `mops test`; build
`../../frontend` first; `npm install --legacy-peer-deps && npm run build`
in `frontend/`; `icp deploy`). Play both seats in two tabs.

## Architecture rules

Everything in `../../CLAUDE.md`, plus: the engine and generic screens are
never vendored here.

## Game-rule notes (src/TicTacToeRules.mo)

- 9 cells, row-major (`index = row*3 + col`); `#p1` = X first, `#p2` = O.
- `LINES` is a fixed constant of the eight winning lines.
- Any empty cell is legal for either seat.
- `step` counts plies. No configurable board size or win length.

## Conventions

Plain interpreter tests; `msg`, not `label`; update all three suites when
the rules change (`legalActions` must keep matching `validate`).
