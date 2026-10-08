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
  `legalActions` counts); `Lifecycle` (an Instructables
  table, three opening moves, seed to one attack from the end); `Bot`
  (every tier legal in both variants, Fox/Bear win-taking and
  loss-avoidance, ladder play-outs — Bear beats Bunny and Fox from either
  seat in either variant, Fox beats Bunny in Classic — then two canister
  bots at different complexities through real plies asserting
  `req.complexity`/`req.game.variant`).
- **`icp.yaml`** — `backend`, `bot`, `frontend/dist`.
- **`frontend/`** — the game's own UI, a plain-JS/CSS port of the
  Chopsticks web app's design (dark arcade look, Fraunces/GeneralSans/
  JetBrainsMono in `src/assets/fonts/`), over `duel-game-core/client.js`
  alone: nothing from `duel-game-core/app.js` or its stylesheet runs
  here. `chopsticks-plugin.js` is the `GamePlugin` (Candid types,
  `variantChoices()` Classic first, `formatVariant()`, `renderBoard`/
  `renderActions`, `applyLocal` mirroring `resolve`) plus what the UI shares with it: `renderHands`/
  `handCard` (the finger-emoji hand cards with selection, last-moved,
  targetable and replay states) and the cosmetic rules mirrors `hit`,
  `splitValid`, `canSplit`, `splitReason`. `chopsticks-ui.js` is every
  screen and overlay bound to `createDuelClient()`'s state: the hero
  lobby ("Play vs AI" → opponent picker from `list_bots()`, each
  complexity a character — 🐰 Bunny/🦊 Fox/🐻 Bear, anything else 🤖 —
  → rules picker → create as Player 1 and call the bot's `play`; "Play
  vs a Friend" → rules picker with seat and open/code options; the open
  tables list), staging (with "Add a Bot"), the board (record strip,
  rules and opponent badges, status badge, move banner, hands, split
  button with the exact "why not" texts, forfeit, idle/claim clocks),
  the split dialog (Classic slider, Instructables before → after), the
  game-over overlay ("Play Again" = rematch, which re-invites the same
  bot when the reserved staging lands), the tutorial (auto-shown once
  per browser), and the leaderboard modal (ELO, bot rows with
  Challenge). The opponent's last move is REPLAYED on the previous
  board before the new one shows (source pulse 900 ms, target flash
  700 ms, banner texts as in the original), and the move-history
  sidebar (2×2 grids with arrows and after-value badges) is derived
  client-side by diffing consecutive positions — `State` carries no
  history, so it starts empty on reload, and an attacker hand that
  equals its sibling is named left. Screens, history and replay all read
  `withLocalMove`'s status, so your move shows at once and a reply that
  carries the bot's answer too still replays it as its own ply; a
  rejected move drops the local ply from the history. The W/L/D record strip is per
  identity in `localStorage` (the backend keeps ELO only). `app.js`
  builds the actor, `connectTransport()`, the client, and a `services` object
  (`get_leaderboard`, `list_bots`, the bot's `play`) the UI reads
  through.

## Toolchain / Build & test

Same as `examples/tic-tac-toe` (moc 2.0.0; `mops test`; build
`../../frontend` first, then `npm install --legacy-peer-deps && npm run
build` in `frontend/`; `icp deploy`; then
`icp canister call bot register ...`). `build.js` also copies
`src/assets/` (the fonts) into `dist/`. Play a bot from "Play vs AI",
and both seats of a friend table in two tabs, trying both variants.

## Architecture rules

Everything in `../../CLAUDE.md`, plus:

1. **The engine and the default shell are never vendored here.**
   `chopsticks-ui.js` draws from `ClientState` and calls the client; it
   never reimplements what `client.js` does. If a screen needs something
   the state lacks, add it to `client.js`.
2. **`chopsticks-ui.js` imports only `client.js`, `render.js`'s pure
   text helpers, and `chopsticks-plugin.js`.**
3. **`chopsticks-plugin.js`'s `splitValid`/`hit` mirror
   `ChopsticksRules.mo`'s `validateSplit`/`hit` cosmetically** (the split
   dialog's validity, the replay's attacker inference) — keep them in
   sync.

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

Plain interpreter tests; `msg`, not `label`; update all three suites when
the rules change (`legalActions` must keep matching `validate`) and keep
the plugin's `splitValid`/`hit` in sync.
