# ultimate-tic-tac-toe duel — reference #alternating game built on duel-game-core

Ultimate tic-tac-toe (https://en.wikipedia.org/wiki/Ultimate_tic-tac-toe):
a 3x3 meta-board of nine local boards. The cell position just played
routes the opponent to the local board at that position, unless it is
already decided, in which case any undecided board is playable. Three
local wins in a meta-line win; every board decided with no meta-line is a
draw. The `#alternating` reference with real structured state. Not part
of either package.

- **`src/UltimateTicTacToeRules.mo`** — `State = { cells (81, index =
board*9 + cell); results (per local board: #p1/#p2/#tie); activeBoard :
?Nat }`. `LINES` serves both the local and meta win checks.
  `legalActions` enumerates every empty cell of every currently allowed
  board.
- **`src/Host.mo`** — same shape as `examples/tic-tac-toe/src/Host.mo`.
- **`src/BotIface.mo`** — `make_move`.
- **`bot/BotLogic.mo`** — `legalActions(...)[turn % n]`; no lookahead.
- **`bot/Bot.mo`** — `make_move` (`query`), `play(...)`, `register`/
  `unregister` (registers `[]`, "Default").
- **`test/*.test.mo`** — `RulesUnit` (free vs routed vs
  routed-to-decided legality, local win without ending, local tie,
  meta-line win, full draw); `Engine` (routing enforced through `submit`,
  claim-win); `Lifecycle` (opening moves exercising routing, seed to one
  placement from a meta win); `Bot` (legal including a board routed to
  its last cell; two canister bots through real plies with a larger sweep
  budget).
- **`icp.yaml`** — `backend`, `bot`, `frontend/dist`.
- **`frontend/`** — `uttt-plugin.js`: nine `.uttt-local-board` panels,
  playable boards outlined (`.uttt-active`), decided boards faded with an
  overlay mark (`.uttt-board-won`); every playable empty cell is a
  `data-act` button (`actionAttr({ place: { board, cell } })`).
  `renderActions` returns `""`. `app.js` matches `examples/tic-tac-toe`.

## Toolchain / Build & test

Same as `examples/tic-tac-toe`. Play both seats in two tabs: routing,
free choice after a decided board, local win/tie, meta-line win, full
draw, claim-win.

## Architecture rules

Everything in `../../CLAUDE.md`, plus: the engine and generic screens are
never vendored here.

## Game-rule notes (src/UltimateTicTacToeRules.mo)

- `#p1` = X first, `#p2` = O.
- `activeBoard` is computed per `resolve` from the cell just played,
  against the FRESH `results` (a board decided by this very move counts as
  decided when routing).
- A tied local board is decided but counts toward neither meta-line.
- `turn` counts plies. No configurable size, win length, or tie-break
  variant.

## Conventions

Plain interpreter tests; `msg`, not `label`; update all four suites when
the rules change (`legalActions` must keep matching `validate`).
