# chopsticks duel — reference #alternating game built on duel-game-core

A complete, deployable example game that plugs into the two
`duel-game-core` packages this repo ships (`../../backend`, the Motoko
mops package; `../../frontend`, the npm package). The two-hands finger
game chopsticks: each player starts with one finger up on each hand,
and on their turn either ATTACKS (taps one of their own live hands onto
one of the opponent's live hands, adding their count to it) or SPLITS
(redistributes their own total across their two hands). Put both of the
opponent's hands out and you win. A table's creator picks one of two
rules variants when starting it — Classic or Instructables, see the
"Game-rule notes" below — shown as plain text to anyone browsing open
tables before they join. It exists alongside `examples/checkers`,
`examples/tic-tac-toe`, and `examples/ultimate-tic-tac-toe` as a fourth
`#alternating` reference, and is this repo's second worked reference
for a table-time rules variant after `examples/rock-paper-scissors` —
the shape where a variant changes not just which moves are legal but
what a move DOES, so `resolve` branches on it as well as `validate` —
and its bot is the worked reference for a three-tier complexity ladder
(Bunny/Fox/Bear). It is **not** part of either package itself.

- **`src/ChopsticksRules.mo`** — the game logic as pure functions. No
  actor, no shared functions, no storage, no Time. Plugs into the engine
  via `spec() : TP.Spec<State, Action>`, where `TP` is `mo:duel-game-core`
  (imported from `../../backend` — see `mops.toml`). `spec()` returns
  `#alternating { init; validate; resolve }` — seats take turns in order
  (`#p1` moves first), and `State` carries no "whose turn" flag of its
  own because the engine already tracks that. `State` is `{ variant; p1 :
Hands; p2 : Hands }`, `Hands` a `{ l; r }` pair of `Nat`s (0 = out,
  otherwise 1..4 — a hand never legitimately holds 5 or more, in either
  variant), and `Action` is `#attack { from : HandId; to : HandId }`
  (`to` names the OPPONENT's hand) or `#split { l; r }` (the mover's own
  new hands). `init(raw : Text)` parses this table's own stored variant
  text via `parseVariant` into a closed `Variant = { #classic;
#instructables }` (`"instructables"` → `#instructables`, anything else —
  including `""`, what every example without variants passes — →
  `#classic`, a safe default rather than a trap) and stores it on
  `State.variant`. `validate` gates attacks (both hands live) and splits
  (per variant — see below); `resolve` applies the attack via `hit`
  (`>= 5` → out in Classic; `sum % 5`, with 0 = out, in Instructables)
  or the split, and returns a `Verdict` once the opponent has no live
  hand left. `legalActions(s, seat)` enumerates every legal `Action`
  (attacks first, then splits by ascending left hand) by calling
  `validate` on each candidate, so it can never drift from it;
  `BotLogic.mo` is its consumer, and so is `Bot.test.mo`'s legality
  check. `other`/`handsOf`/`get`/`liveHands`/`isOut` are small public
  helpers `BotLogic.mo` reuses rather than re-deriving.
- **`src/Host.mo`** — the host actor, identical in shape to
  `examples/tic-tac-toe/src/Host.mo` (down to the metrics/canister-players/
  bot-discovery/ELO-leaderboard wiring) — see `examples/checkers/CLAUDE.md`'s
  own `src/Host.mo` bullet for the full explanation of each piece;
  nothing about `#alternating` mode or table variants changes how a host
  actor is wired (a table's variant is entirely `Rules.init`/`validate`/
  `resolve`'s concern, plus the frontend's own picker — see below).
  `Registry.new(60_000_000_000, 15_000_000_000)`, `STARTING_ELO = 1200`
  — same defaults as `examples/tic-tac-toe`. ELO is scored identically
  regardless of which variant a match was played in.
- **`src/BotIface.mo`** — the `CanisterPlayer` Candid interface a
  chopsticks canister player must implement: one method,
  `make_move : (TP.MoveRequest<Rules.State, Rules.Action>) -> async
Rules.Action`.
- **`bot/BotLogic.mo`** — the bot's move-selection logic, as a plain pure
  module (no actor, no `Time`, matching `ChopsticksRules.mo`'s own
  style). This is the repo's worked reference for a THREE-tier bot (see
  `../../CLAUDE.md`'s "Canister players" note on `complexity`; the
  two-tier one is `examples/tic-tac-toe/bot/BotLogic.mo`):
  `COMPLEXITIES = ["Bunny", "Fox", "Bear"]` is the list `Bot.mo`'s
  `register` sends to the host, and `chooseMove` switches on
  `req.complexity`. Every tier draws from `ChopsticksRules.legalActions`,
  so none can ever submit an illegal move; the same bot canister serves
  both variants, reading which off `req.game.variant` on every request
  (never a hardcoded, per-canister constant).
  - **Bunny** — no lookahead: `moves[req.turn % moves.size()]`, the same
    shape `examples/checkers`/`examples/tic-tac-toe` use.
  - **Fox** — one ply: takes an immediate win if any move gives one,
    otherwise never plays a move after which the opponent has an
    immediate win (falling back to Bunny's pick among whatever's left —
    or among every move, if nothing is safe). In the source game this
    tier is described as being built exactly this way; in this
    implementation it beats Bunny from either seat in Classic, and
    Bear beats it from either seat in either variant.
  - **Bear** — a depth-limited negamax with alpha-beta pruning
    (`BEAR_DEPTH = 6` plies) over `ChopsticksRules.resolve` itself, a
    terminal score of `WIN + depth` (so a quicker win outranks a slower
    one) and a horizon heuristic of live hands (own minus the
    opponent's). Depth-limited rather than full-depth because chopsticks'
    position graph is CYCLIC in both variants (splits, and Instructables'
    wraparound, can revisit earlier positions), so a full minimax would
    never terminate without cycle handling — the depth limit is that
    handling. Deterministic: among equal-valued moves the first in
    `legalActions` order wins, so `make_move` stays a `query`.
    Any `req.complexity` the bot didn't declare plays `Bunny`. Kept
    separate from `Bot.mo` so `test/Bot.test.mo` can call `chooseMove`
    directly, with no actor/Candid round-trip.
- **`bot/Bot.mo`** — the bot canister itself: implements
  `BotIface.CanisterPlayer`'s `make_move` as a `query` (a thin shell over
  `BotLogic.chooseMove` — every tier is a pure function of the request),
  plus `play(host, tableId, seat, code, complexity)` (Flow 1's self-join
  entry point — `complexity` is whichever of `BotLogic.COMPLEXITIES` the
  challenger picked, forwarded to `join_table_as_canister` and carried
  back on every `make_move` as `req.complexity`) and
  `register(host, name)`/`unregister(host)` for bot discovery (`register`
  sends `BotLogic.COMPLEXITIES` along, so the "🤖 Bots" dialog and the
  leaderboard list this bot as "ChopsticksBot (Bunny)", "(Fox)", and
  "(Bear)", each rated on its own) — a one-time call made by hand after
  both canisters are deployed:
  `icp canister call bot register '(principal "<backend-canister-id>", "ChopsticksBot")'`.
  Deploy target (see `icp.yaml`).
- **`test/*.test.mo`** — interpreter-run suites. `RulesUnit.test.mo`
  drives `init`/`validate`/`resolve` directly against synthetic positions
  (no engine, no actor): variant parsing with its safe default, attacks
  gated to live hands on both ends, Classic's free split minus
  staying-put/pure-swap/a-hand-of-five (splitting down to 0 allowed),
  Instructables' one-dead-hand-and-even gate with its forced even
  result, Classic's "5 or more is out" vs Instructables' exact-5 and
  `mod 5` wraparound, the win on the opponent's last hand (and that a
  wrap never puts a hand out), and `legalActions` mirroring `validate`
  with exact counts for several positions. `Engine.test.mo` plugs the
  real rules into the real `Table` primitive, focused on what an
  `#alternating` game specifically exercises through it
  (`Err.#notYourTurn`, immediate single-move resolve, a pure swap refused
  as `#illegalMove`, claim-win gated to the waiting seat) plus the
  table's own `variant` text reaching `init` — the engine's own generic
  `#alternating` mechanics already have their own exhaustive suite in
  `duel-game-core` itself (`../../backend/test/Alternating.test.mo`).
  `Lifecycle.test.mo` is one short session narrative through the real
  engine (an Instructables table): join, three genuine opening moves
  including a hand put out at exactly 5, then the live position is
  seeded directly via `Table.phase`'s own public `var` field to one
  attack from finishing (with a wraparound attack on the way), and that
  finishing attack is submitted for real. `test/Bot.test.mo` covers
  `BotLogic.mo`: every tier (and an undeclared complexity, which must
  play exactly like Bunny) only ever returns a `legalActions`-listed move
  across several positions in both variants; Fox and Bear both take an
  immediate win and both refuse the one move in a synthetic position
  that hands the opponent an immediate win (which Bunny's own turn-1
  pick is); full play-outs from the opening prove the ladder — Bear
  beats Bunny and Fox from either seat in either variant, Fox beats
  Bunny from either seat in Classic; then `BotLogic.chooseMove` is wired
  through a live `mo:duel-game-core/canister_players` as the `callBot`
  continuation so TWO canister-seated bots (one as `Bear`, one at its
  default) play an Instructables table through several real
  `#alternating` plies, asserting each ask's `req.complexity` and
  `req.game.variant`. The `*.test.mo` suffix is what `mops test`
  discovers — a file named `FooTest.mo` is silently skipped.
- **`icp.yaml`** — icp-cli manifest; deploys `src/Host.mo` as canister
  `backend`, `bot/Bot.mo` as canister `bot`, and `frontend/dist`
  (esbuild's bundled output — see this file's "Build & test" section, NOT
  `frontend/` itself) as an asset canister.
- **`frontend/`** — vanilla-JS web client (no framework), bundled with
  esbuild (`npm run build`); `duel-game-core` is fetched locally via `npm
install`. `chopsticks-plugin.js` is the whole game-specific surface: it
  implements the `GamePlugin` contract (`idlTypes`, `seatLabel`,
  `renderBoard`, `renderActions`) plus the two optional variant hooks
  `variantChoices()` (Classic first — the default `renderBrowsing`'s
  "Start a new table" picker preselects) and `formatVariant(variant)`
  (turns a browsed table's own stored key back into the same label
  text). `renderBoard` draws the opponent's two hands above the mover's
  own two (finger marks, count, "OUT" for a dead hand). Interaction is
  click-to-select for attacks: while `yourTurn` (`renderBoard`'s own 4th
  parameter — see `GamePlugin`'s doc in `duel-game-core/render.js`), each
  of your own live hands is a `data-hand` button; tapping one selects it
  (module-level state, same technique as
  `examples/checkers/frontend/src/checkers-plugin.js`, reset whenever a
  new position arrives or it isn't your turn), after which each of the
  opponent's live hands becomes a real `<button data-act=...>` carrying
  the `#attack` for that pair, submitted unchanged by `app.js`'s generic
  click handling; tapping the selected hand again deselects it. Splits
  live in `renderActions`: every legal Classic split as a `l · r` button
  (mirroring `validate`'s own Classic rule cosmetically — no staying put,
  no pure swap, no hand of five), or the single "Split evenly" button in
  Instructables when it's legal, with a hint line otherwise;
  `renderActions` reads `gameState.variant` (the actual live match's own
  rules, never a picker's last-clicked value). `app.js` is identical in
  shape to `examples/tic-tac-toe/frontend/src/app.js` (same leaderboard
  toggle, same "🤖 Bots" challenge flow) — see that file's own extensive
  inline comments for how each piece works. Two ways to face the bot in
  a chosen variant: the leaderboard/"🤖 Bots" Challenge button's own
  seat-choice step creates a table with `variant: ""` (Classic); to play
  Instructables against it, start a table from the lobby with the
  Instructables radio selected, then use "Add Bot 🤖 to the open seat"
  on the "Waiting for an opponent" screen, which fills THAT table.
  `style.css` here holds only the hand cards, selection/target rings,
  and split-button row, layered on top of `duel-game-core.css`.

## Toolchain

- moc **1.11.2** (mops toolchain, pinned in `mops.toml`), node/npm for the
  frontend. `src/Host.mo`'s `include ActorMixin<system>(...)` needs a newer
  moc than 1.11.2 to type-check locally (see `../../CLAUDE.md`'s toolchain
  note) — `icp deploy`'s own `@dfinity/motoko` recipe brings one; the
  rules module, the bot, and all four test suites type-check and run
  under 1.11.2.
- Motoko dependencies: `duel-game-core` (path dependency on
  `../../backend`), `core` (mo:core), `ic-websocket-cdk` (via
  `mo:duel-game-core/ws`), and `promtracker` (via the metrics wiring) —
  see `../../CLAUDE.md`'s toolchain note. Neither of the latter is listed
  under this file's own `mops.toml` `[dependencies]` — both arrive
  transitively through `duel-game-core`'s own `mops.toml`. Never import
  `mo:base` directly in this game's own code.
- The frontend's npm dependencies split the same way
  `examples/tic-tac-toe`'s do: `duel-game-core` (`file:../../../frontend`)
  and `@icp-sdk/core` are what `app.js` itself needs; esbuild bundles
  both, plus everything `duel-game-core` needs transitively
  (`@icp-sdk/auth`, `cborg`), into a single `dist/app.js`.
  `frontend/.npmrc` sets `install-links=true`. **Gotcha:** because it's a
  copy, not a symlink, a plain `npm install` after editing
  `../../frontend/` reports "up to date" and does NOT refresh the copy —
  see `../../CLAUDE.md`'s "After touching anything under `frontend/`"
  section for the actual refresh procedure, and re-run `npm run build`
  HERE too afterward.

## Build & test

```bash
cd examples/chopsticks
mops install                       # fetches duel-game-core (../../backend) + core

# Type-check (Host.mo needs the newer moc icp deploy brings — see Toolchain):
moc --check $(mops sources) src/ChopsticksRules.mo
moc --check $(mops sources) bot/BotLogic.mo

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
cd examples/chopsticks
icp deploy                 # local  → http://frontend.local.localhost:8000/
icp deploy --network ic    # mainnet — spends cycles
icp canister call bot register '(principal "<backend-canister-id>", "ChopsticksBot")'
```

The asset-canister recipe must be **v2.3.0 or newer** (v2.1.0 syncs with
an `assets` step icp-cli 1.x rejects outright).

Play both seats by opening the deployed URL in two separate browser
tabs — create a table in one (try both Classic and Instructables from the
picker), join it from the other, and confirm a real game plays out
correctly: attack via tap-then-tap, every legal Classic split offered
and a pure swap never offered, Instructables' "Split evenly" appearing
only with one hand out and the other even, a hand at 5 going out in
Classic and a 6 wrapping to 1 in Instructables, claim-win while waiting
on an idle opponent. The Motoko tests passing and the frontend building
are both necessary but not sufficient; nothing here automates an actual
two-tab playthrough.

## Architecture rules

This game inherits every rule in `../../CLAUDE.md`'s "Architecture rules"
section (spec passed per call / never stored, the engine owns time, rules
stay pure, `validate` is the only legality gate, etc.) — read that file
first. Rules specific to this example:

1. **The engine lives in `../../backend` and is never vendored here.**
   `src/ChopsticksRules.mo` and `src/Host.mo` import it as
   `mo:duel-game-core`. If you find yourself copy-pasting engine code into
   this directory to fix something, fix it in `../../backend/src/lib.mo`/
   `table.mo` instead and re-run `mops install` here.
2. **The generic screens live in `../../frontend` and are never vendored
   here either.** `chopsticks-plugin.js` supplies ONLY `idlTypes`/
   `seatLabel`/`renderBoard`/`renderActions`/`variantChoices`/
   `formatVariant`; the multi-table lobby, staging, rematch, busy, debrief
   chrome, and the turn-accurate copy for `#alternating` all come from
   `duel-game-core/render.js` and `app.js`.
3. **`chopsticks-plugin.js`'s `splitsFor` and `ChopsticksRules.mo`'s
   `validateSplit` are two independent implementations of the same
   rule** — one in Motoko (authoritative), one in JS (cosmetic, deciding
   which split buttons to offer). If they ever disagree,
   `ChopsticksRules.mo` is correct and the plugin has a display bug; the
   engine calls the REAL `validate` on every submission regardless. Keep
   both in sync when the split rules change.

## Game-rule notes (src/ChopsticksRules.mo)

- Seats: plain `#p1`/`#p2`, labeled "Player 1"/"Player 2" in the frontend
  — the rules name neither side. `#p1` moves first.
- Both hands start at 1. A hand at 0 is out ("OUT" in the UI) by ANY path
  — elimination or a voluntary Classic split down to 0 — and is inert
  both ways: it can neither attack nor be attacked.
- ATTACK: the target becomes `target + attacker`; the attacking hand is
  unchanged. Both hands involved must be live.
- Two rules variants, picked once by a table's creator, opaque `Text`
  stored on the table and parsed by `Rules.init`:
  - **Classic** (`""`, or any unrecognized text — the safe default): a
    hand reaching **5 or more** is out — plain addition, no wraparound.
    SPLIT is free: any redistribution of the mover's own total, dead
    hand or not, except staying put or a pure swap (`3+1 → 1+3`), and
    never a hand of 5 or more (it would be out on the spot; `validate`
    rejects it outright instead).
  - **Instructables** (`"instructables"`): only **exactly 5** puts a
    hand out; above 5 the sum **wraps** — `sum mod 5`, so `4 + 2 = 6 →
1`, and 0 means out. SPLIT is gated: legal only once one hand is out
    AND the other is even, and the result is forced — exactly half to
    each hand (this is the move that revives a dead hand).
- WIN: the first seat to put both of the opponent's hands out. A split
  can never end the game. No draw condition is implemented — the source
  game tracks a draw stat but no triggering condition was ever observed
  (see the investigation this example was built from), and a position
  that cycles is left to the players (or `claimWin`/`leave`) to resolve.
- Turn counter (`View.inGame.turn`) counts individual PLIES (one per
  submission), not move-pairs — `#alternating` mode's own convention,
  same as checkers.
- `BotLogic.mo`'s Bear tier is deliberately depth-limited (see its own
  bullet above): the position graph has cycles in both variants, so
  "full-depth minimax" is not a terminating search here without it.

## Motoko skills (read before editing)

Local copies of the relevant Motoko-authoring SKILL.md playbooks live in
this repo under `../../.agents/skills/` — the same set `../../CLAUDE.md`
points to (the duel-game-core-specific playbook instead lives in the
tracked `../../skills/duel-game-core/`, whose
`references/alternating-turn-games.md` this example is a further worked
reference for, and whose own "Turn the rules into State/Action" step
covers designing a table-time variant like this game's own
Classic/Instructables). Consult those before editing
`src/ChopsticksRules.mo`, `src/Host.mo`, or `bot/Bot.mo`/`bot/BotLogic.mo`.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `ok`/`expectErr` helpers + `Runtime.trap` on violation. Extend in kind.
  (In mo:core, `trap` lives in `Runtime`; `Debug` only has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update all four test suites when touching `src/ChopsticksRules.mo`'s
  semantics (including `legalActions` — it must keep returning exactly
  what `validate` would accept), and keep `chopsticks-plugin.js`'s
  `splitsFor` mirror in sync (see Architecture rule 3 above).
