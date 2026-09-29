# chopsticks duel — reference #alternating game built on duel-game-core

The two-hands finger game: attack (add your hand's count to an opponent's
live hand) or split (redistribute your total). Put both opponent hands
out to win. The creator picks Classic or Instructables at table time.
This is the repo's reference for a variant that changes RESOLUTION as
well as legality, and for a three-tier bot (Bunny/Fox/Bear). Not part of
either package.

- **`src/ChopsticksRules.mo`** — `#alternating`, `#p1` first. `State = {
variant; p1 : Hands; p2 : Hands }`, `Hands = { l; r }` (0 = out,
  otherwise 1..4). `Action = #attack { from; to }` (`to` is the
  opponent's hand) or `#split { l; r }`. `init(raw)` parses
  `"instructables"`; anything else is `#classic`. `validate` gates
  attacks (both hands live) and splits per variant; `resolve` applies
  `hit` (`>= 5` out in Classic; `sum % 5`, 0 = out, in Instructables) or
  the split. `legalActions` enumerates by calling `validate` on each
  candidate. `other`/`handsOf`/`get`/`liveHands`/`isOut` are helpers the
  bot reuses.
- **`src/Host.mo`** — identical in shape to `examples/checkers/src/Host.mo`
  (metrics, canister players, bot discovery, ELO). Variants are entirely
  `Rules`' and the plugin's concern.
- **`src/BotIface.mo`** — `make_move`.
- **`bot/BotLogic.mo`** — `COMPLEXITIES = ["Bunny", "Fox", "Bear"]`;
  `chooseMove` switches on `req.complexity`, reads the variant off
  `req.game.variant`, and always draws from `legalActions`. Bunny: no
  lookahead. Fox: take an immediate win, else never leave the opponent
  one. Bear: negamax with alpha-beta, `BEAR_DEPTH = 6`, terminal `WIN +
depth`, live-hands heuristic — depth-limited because the position graph
  is cyclic in both variants. Unknown complexities play Bunny.
- **`bot/Bot.mo`** — `make_move` (`query`), `play(...)`, `register`/
  `unregister` (sends `COMPLEXITIES`, so the bot lists as
  "ChopsticksBot (Bunny)/(Fox)/(Bear)"):
  `icp canister call bot register '(principal "<backend-canister-id>", "ChopsticksBot")'`.
- **`test/*.test.mo`** — `RulesUnit` (variant parsing, attack gating,
  Classic's free split minus stay-put/pure-swap/hand-of-five,
  Instructables' one-dead-and-even gate, `>= 5` vs exact-5 and wrap, win,
  `legalActions` counts); `Engine` (`#notYourTurn`, a pure swap refused,
  claim-win, variant reaching `init`); `Lifecycle` (an Instructables
  table, three opening moves, seed to one attack from the end); `Bot`
  (every tier legal in both variants, Fox/Bear win-taking and
  loss-avoidance, ladder play-outs — Bear beats Bunny and Fox from either
  seat in either variant, Fox beats Bunny in Classic — then two canister
  bots at different complexities through real plies asserting
  `req.complexity`/`req.game.variant`).
- **`icp.yaml`** — `backend`, `bot`, `frontend/dist`.
- **`frontend/`** — `chopsticks-plugin.js` implements the plugin plus
  `variantChoices()` (Classic first) and `formatVariant()`. `renderBoard`
  draws the opponent's hands above yours; attacks are tap-a-hand then
  tap-a-target (local selection, the target a real `data-act` button);
  splits are `renderActions` buttons (every legal Classic split, or
  "Split evenly" in Instructables) read off `gameState.variant`. `app.js`
  matches `examples/tic-tac-toe`. The Challenge flow creates Classic
  tables; for Instructables against the bot, start an Instructables
  table and use "Add Bot" on the staging screen.

## Toolchain / Build & test

Same as `examples/tic-tac-toe` (moc 1.11.2; `mops test`; build
`../../frontend` first, then `npm install --legacy-peer-deps && npm run
build` in `frontend/`; `icp deploy`; then
`icp canister call bot register ...`). Play both seats in two tabs,
trying both variants.

## Architecture rules

Everything in `../../CLAUDE.md`, plus: the engine and generic screens
are never vendored here, and `chopsticks-plugin.js`'s `splitsFor` mirrors
`ChopsticksRules.mo`'s `validateSplit` cosmetically — keep them in sync.

## Game-rule notes (src/ChopsticksRules.mo)

- Seats: "Player 1"/"Player 2"; `#p1` first. Both hands start at 1. A
  hand at 0 is out by any path and can neither attack nor be attacked.
- ATTACK: target becomes `target + attacker`; both hands must be live.
- **Classic** (`""` or unrecognized): 5 or more is out, no wrap. Split
  freely, except staying put, a pure swap, or a hand of 5+.
- **Instructables** (`"instructables"`): exactly 5 is out; above 5 wraps
  `mod 5`. Split only with one hand out and the other even, always half
  and half.
- WIN: both opponent hands out. A split never ends the game. No draw
  condition; a cycling position is left to the players or `claimWin`.
- `turn` counts plies.

## Conventions

Plain interpreter tests; `msg`, not `label`; update all four suites when
the rules change (`legalActions` must keep matching `validate`) and keep
the plugin's `splitsFor` in sync.
