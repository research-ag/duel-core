# rock-paper-scissors duel — reference game built on duel-game-core

First to N round wins. The creator picks Classic or Well (a fourth
symbol) and the number of wins at table time; this is the repo's
reference for a record `Options` bounded by `checkOptions` and a variant
gated purely in `validate`. Not part of either package.

- **`src/RockPaperScissorsRules.mo`** — `#simultaneous`. `Options = {
variant : Variant; winsNeeded : Nat }`; `checkOptions` requires
  `winsNeeded` in 1..9. `init(options, rng)` copies both onto `State`
  (`variant`, `winsNeeded`). `validate` rejects `#well` in Classic and
  accepts everything else. `resolve` always uses the Well win table (a
  strict superset), bumps the round winner's score, and returns a
  `Verdict` at `winsNeeded`. `View = State`.
- **`src/Host.mo`** — same shape as `examples/checkers/src/Host.mo`
  (metrics, canister players, bot discovery, ELO). Nothing about options
  lives here beyond naming `Rules.Options` in `duel_create_table`/
  `duel_lobby`.
- **`src/BotIface.mo`** — `make_move` and `callBot`.
- **`bot/BotLogic.mo`** — `chooseMove(req, entropy)` picks uniformly
  from the current variant's action set (read off `req.game.variant`),
  hashing `entropy` with the seat so two copies of the bot asked at the
  same instant still pick independently.
- **`bot/Bot.mo`** — `make_move` (`query`, passes `Time.now()` as the
  entropy), `play(...)`, `register`/
  `unregister` (registers `[]`, "Default").
- **`test/*.test.mo`** — `RulesUnit` (`checkOptions` bounds, init per
  option, well gating, all six beat pairs plus a tie, first-to-N in both
  variants); `Lifecycle` (join, full match, rematch, mid-game leave,
  idle takeover) on Classic; `Bot` (legal per variant, then two canister
  bots play a full match per variant with the table's options flowing
  through).
- **`icp.yaml`** — `backend`, `bot`, `frontend/dist`.
- **`frontend/`** — `rps-plugin.js`: scoreboard, last round's picks, three
  or four emoji buttons depending on `gameState.variant`, plus
  `optionChoices()` (Classic/Well, both first to 3) and `formatOptions()`
  ("Classic · first to 3"); `applyLocal` returns the state unchanged, so
  a pick shows as locked in at once. `app.js` matches
  `examples/checkers` (its Challenge flow sends the first option choice)
  and is
  the `start({ screens })` reference: `renderRpsDebrief` replaces the
  debrief with a final scoreline (via `debriefVerdict`) and the deciding
  round's picks (`renderLastRound`, shared with the plugin) while keeping
  the default `data-rematch`/`data-leave` hooks.

## Toolchain / Build & test

Same as `examples/checkers` (moc 2.0.0; `mops test`; build
`../../frontend` first; `npm install --legacy-peer-deps && npm run build`
in `frontend/`; `icp deploy`). Play both seats in two tabs, trying both
variants and confirming the Well button appears only in a Well table.

## Architecture rules

Everything in `../../CLAUDE.md`, plus: the engine is never vendored here.

## Game-rule notes (src/RockPaperScissorsRules.mo)

- Seats: "Player 1"/"Player 2". `WINS_NEEDED = 3` is a constant. A tie
  scores nobody.
- **Classic** (`""` or unrecognized): `#well` is illegal.
- **Well** (`"well"`): Scissors beats Paper; Paper beats Rock and Well;
  Rock beats Scissors; Well beats Rock and Scissors. Deliberately
  unbalanced, as specified — not a bug.
- If either `ACTIONS` list changes, re-derive the bot's p2 multiplier to
  stay coprime to the set size.

## Conventions

Plain interpreter tests; `msg`, not `label`; update all three suites when
the rules change.
