# rock-paper-scissors duel — reference game built on duel-game-core

A complete, deployable example game that plugs into the two
`duel-game-core` packages this repo ships (`../../backend`, the Motoko
mops package; `../../frontend`, the npm package). Two players secretly
pick rock, paper, or scissors every round; first to 3 round wins takes
the match. A table's creator additionally picks one of two rules
variants when starting it — Classic (plain rock/paper/scissors) or Well
(a fourth pick, WELL, joins the other three) — shown as plain text to
anyone browsing open tables before they ever join. It exists alongside
`examples/007` and `examples/racing` as a third `#simultaneous`
reference, gives a new "both seats act every round" game something
small and rules-trivial to copy, and is this repo's own worked reference
for a table-time rules variant (see `../../backend/README.md`'s "Table
variants" section and `../../CLAUDE.md`'s `Spec<S, M>` note) — it is
**not** part of either package itself.

- **`src/RockPaperScissorsRules.mo`** — the game logic as pure functions.
  No actor, no shared functions, no storage, no Time. Plugs into the
  engine via `spec() : TP.Spec<State, Action>`, where `TP` is
  `mo:duel-game-core` (imported from `../../backend` — see `mops.toml`).
  `init(raw : Text) : State` parses this table's own stored variant text
  into a closed `Variant = { #classic; #well }` (`"well"` → `#well`,
  anything else — including `""`, what every OTHER example in this repo
  passes — → `#classic`, a safe default rather than a trap), and stores
  it on `State.variant` for `validate`/`resolve` to read back. `validate`
  rejects `#well` picks in `#classic` mode (`?"well is not available in
classic mode"`) and accepts everything else unconditionally — every
  OTHER pick is always legal, since this game has no resource or board
  state that could make it illegal. `resolve` always uses the Well-mode
  win table (a strict superset of Classic's own three-way cycle: `#well`
  simply never appears in a Classic match's moves, having already been
  rejected by `validate`), computes the round's winner, bumps that seat's
  score, and returns a `Verdict` once either seat reaches 3 round wins.
  See the module's own doc header for the full rules text of both
  variants.
- **`src/Host.mo`** — the host actor: forwards every call to a
  `TP.Registry<Rules.State, Rules.Action>` (built with `Registry.new`
  from `mo:duel-game-core/registry`; a multi-table lobby — anyone may
  open a table, open or access-code protected, in either rules variant —
  not a single fixed board) with `Time.now()` and `Rules.spec()`, wired
  exactly as `../../backend/README.md`'s example shows — identical shape
  to `examples/checkers/src/Host.mo`; nothing about table-variant
  handling lives in `Host.mo` at all (that's entirely `Rules.mo`'s own
  `init`/`validate`, and the frontend's own picker — see below). Deploy
  target. `status` is the only plain Candid method on this actor (a
  `query`, side-effect-free); every mutating call
  (`createTable`/`joinTable`/`submit`/`rematch`/`leave`/`reset`/
  `claimWin`/`ackEnded`) is reachable exclusively through
  `mo:duel-game-core/ws`'s `ws_message`, which is what `frontend/app.js`
  actually talks to. `Host.mo` also wires Prometheus-style metrics
  (`Registry.attachMetrics(pt)`, exposed at `/metrics` via
  `mo:promtracker/mixins/http`), canister players
  (`mo:duel-game-core/canister_players` + `canister_players_actor_mixin`,
  so a bot canister can take a seat — see the `bot/` bullet below — with
  bot self-registration/discovery: `register_bot`/`unregister_bot`/
  `list_bots`), and an ELO leaderboard (`mo:duel-game-core/leaderboard` +
  `elo` + `leaderboard_actor_mixin`, `STARTING_ELO = 1200`,
  `Leaderboard.new(50, STARTING_ELO)`, re-rated via `Elo.update` in an
  `onGameEnded` hook — `#finished`/`#claimed`/`#aborted` all count, and
  score identically regardless of which variant a match was played in).
  Exactly the same wiring shape as `examples/checkers/src/Host.mo`
  (that file's own doc comments explain each piece in full); nothing here
  is specific to `#simultaneous` vs `#alternating` mode. See
  `../../backend/README.md`'s "Real-time push"/"Metrics"/"Canister
  players"/"Leaderboard" sections for the full designs.
- **`src/BotIface.mo`** — the `CanisterPlayer` Candid interface a
  rock-paper-scissors canister player must implement: one method,
  `make_move : (TP.MoveRequest<Rules.State, Rules.Action>) -> async
Rules.Action`. Lives in `src/`, not `bot/`, because it's `src/Host.mo`
  (the GAME canister) that imports it to type the remote bot actor it
  calls.
- **`bot/BotLogic.mo`** — the bot's move-selection logic, as a plain pure
  module (no actor, no `Time`): `chooseMove` reads the CURRENT match's
  own variant off `req.game.variant` (never a hardcoded, per-canister
  constant — the same bot canister serves both variants, since a table's
  variant lives in state the bot is handed on every request) to pick its
  action set — `[rock, paper, scissors]` for Classic,
  `[rock, paper, scissors, well]` for Well — then rotates deterministically
  through it by `req.turn`, offset by a per-seat, per-variant multiplier
  (1 for p1 always; 2 for p2 in Classic, 3 for p2 in Well — each coprime
  to its own action-set size, so p2's rotation still visits every symbol)
  so two copies of this same bot playing each other don't submit the
  identical pick every round forever (this game has no board position to
  vary the pick by, unlike checkers' `moves[req.turn % moves.size()]`, so
  `turn` alone would tie in lock-step without the multiplier). No
  lookahead, no opponent modeling — the milestone baseline this repo's
  other reference bots (`examples/racing/bot/`, `examples/checkers/bot/`)
  already establish. Kept separate from `Bot.mo` so `test/Bot.test.mo`
  can call `chooseMove` directly, with no actor/Candid round-trip.
- **`bot/Bot.mo`** — the bot canister itself: implements
  `BotIface.CanisterPlayer`'s `make_move` as a `query` (a thin shell over
  `BotLogic.chooseMove` — pure and stateless), plus `play(host, tableId,
seat, code, complexity)`, this bot's own Flow 1 "self-join" entry point, and
  `register(host, name)`/`unregister(host)` for bot discovery (registering
  an empty complexity list — one way to play, listed under "Default"; a one-time
  call made by hand after both canisters are deployed — see
  `examples/checkers/CLAUDE.md`'s identical note for the exact `icp
canister call` shape). Deploy target (see `icp.yaml`). This same `play`
  method is also what the frontend's own "🤖 Bots" challenge dialog calls
  directly (always creating a Classic table for that flow — see the
  `frontend/` bullet below).
- **`test/*.test.mo`** — interpreter-run suites. `RulesUnit.test.mo`
  drives `init`/`validate`/`resolve` directly against synthetic states
  (no engine, no actor): `init("")`/`init("well")`/`init(<garbage>)` each
  land on the right `Variant` (unrecognized text falling back to
  `#classic`, never trapping), well gated to well mode in `validate`,
  every one of the six distinct pairs' beats-relationship plus a tie in
  `resolve`, and first-to-3 match wins in both variants.
  `Engine.test.mo` plugs the real rules into the real `Table` primitive,
  focused on what's specific to a `#simultaneous` game (a pending
  submission hidden from the opponent, round resolution once both seats
  submit, claim-win gated to whichever seat already submitted) — the
  engine's own generic mechanics already have their own exhaustive suite
  in `duel-game-core` itself (`../../backend/test/Engine.test.mo`), so
  this isn't a second copy of that; it exercises the default `""` variant
  only, since none of what it covers is variant-specific.
  `Lifecycle.test.mo` is one short session narrative through the real
  engine: join, a full match to a decisive finish, rematch, a mid-game
  leave, and idle takeover — also `""`-variant only, same reasoning.
  `Bot.test.mo` covers `BotLogic.mo`: it confirms `chooseMove` always
  returns a legal pick FOR EACH variant, then wires two canister-seated
  bots through a live `mo:duel-game-core/canister_players` to play a full
  real match to a decisive finish once per variant (`createTable`'s own
  `variant` argument flowing all the way through to each bot's own
  `chooseMove`), proving the per-seat multiplier actually breaks the
  lock-step tie it exists to avoid in both cases. The `*.test.mo` suffix
  is what `mops test` discovers — a file named `FooTest.mo` is silently
  skipped, so keep the suffix when adding suites.
- **`icp.yaml`** — icp-cli manifest; deploys `src/Host.mo` as canister
  `backend`, `bot/Bot.mo` as canister `bot`, and `frontend/dist`
  (esbuild's bundled output — see this file's "Build & test" section, NOT
  `frontend/` itself) as an asset canister.
- **`frontend/`** — vanilla-JS web client (no framework), bundled with
  esbuild (`npm run build`); `duel-game-core` is fetched locally via `npm
install`. `rps-plugin.js` is the whole game-specific surface: it
  implements the `GamePlugin` contract (`idlTypes`, `seatLabel`,
  `renderBoard`, `renderActions`) — a scoreboard, the last round's two
  picks side by side, and three (Classic) or four (Well) emoji buttons for
  the next pick, `renderActions` reading `gameState.variant` (the actual
  live match's own rules, never a picker's last-clicked value) to decide
  whether the well button shows at all. It also implements the two
  optional variant hooks: `variantChoices()` (`[{key:"classic",...},
{key:"well",...}]`, Classic first — the default `renderBrowsing`'s
  "Start a new table" picker preselects) and `formatVariant(variant)`
  (turns a browsed table's own stored key back into the same label text),
  so a browsing visitor sees "Classic" or "Well" next to each open
  table's own `Table #N`. `app.js` is identical in shape to
  `examples/checkers/frontend/src/app.js` (same leaderboard toggle, same
  "🤖 Bots" challenge flow — that flow's own `createTable` call always
  sends `variant: ""`, i.e. Classic; a challenged bot's own `make_move`
  reads that back off `req.game.variant` like any other match) — see
  that file's own extensive inline comments for how each piece works;
  nothing there is checkers-specific. `style.css` here holds only the
  scoreboard/last-round/action-button visuals, layered on top of
  `duel-game-core.css` (its `.rps-actions` row already wraps, so a
  fourth Well button needs no CSS changes of its own).

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
  either: that module depends on nothing but `core` and its sibling
  engine modules, already pulled in regardless. Never import `mo:base`
  directly in this game's own code — it's the legacy library.
- The frontend's npm dependencies split the same way `examples/checkers`'s
  do: `duel-game-core` (`file:../../../frontend`) and `@icp-sdk/core` are
  what `app.js` itself needs; esbuild bundles both, plus everything
  `duel-game-core` needs transitively (`@icp-sdk/auth`, `cborg`), into a
  single `dist/app.js`. `frontend/.npmrc` sets `install-links=true` so
  `npm install` COPIES `duel-game-core` into `node_modules/duel-game-core`
  instead of the default symlink. **Gotcha:** because it's a copy, not a
  symlink, a plain `npm install` after editing `../../frontend/` reports
  "up to date" and does NOT refresh the copy — see `../../CLAUDE.md`'s
  "After touching anything under `frontend/`" section for the actual
  refresh procedure, and re-run `npm run build` HERE too afterward.

## Build & test

```bash
cd examples/rock-paper-scissors
mops install                       # fetches duel-game-core (../../backend) + core

# Type-check:
moc --check $(mops sources) src/RockPaperScissorsRules.mo
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
cd examples/rock-paper-scissors
icp deploy                 # local  → http://frontend.local.localhost:8000/
icp deploy --network ic    # mainnet — spends cycles
```

The asset-canister recipe must be **v2.3.0 or newer** (v2.1.0 syncs with
an `assets` step icp-cli 1.x rejects outright).

Play both seats by opening the deployed URL in two separate browser
tabs — create a table in one (try both Classic and Well from the
picker), join it from the other, and confirm a real match plays out
correctly, including the fourth Well button appearing only in a Well
table. The Motoko tests passing and the frontend building are both
necessary but not sufficient; nothing here automates an actual two-tab
playthrough.

## Architecture rules

This game inherits every rule in `../../CLAUDE.md`'s "Architecture rules"
section (spec passed per call / never stored, the engine owns time, rules
stay pure, `validate` is the only legality gate, etc.) — read that file
first. One rule specific to this example:

1. **The engine lives in `../../backend` and is never vendored here.**
   `src/RockPaperScissorsRules.mo` and `src/Host.mo` import it as
   `mo:duel-game-core`. If you find yourself copy-pasting engine code into
   this directory to fix something, fix it in `../../backend/src/lib.mo`
   instead and re-run `mops install` here.

## Game-rule notes (src/RockPaperScissorsRules.mo)

- Seats: plain `#p1`/`#p2`, labeled "Player 1"/"Player 2" in the frontend
  — the rules name neither side.
- `WINS_NEEDED = 3` (first to 3 round wins takes the match) is a fixed
  game constant, not a configuration field — nothing in the rules
  description makes it a player choice, and it's the same in both
  variants.
- A tied round (both pick the same thing) scores nobody and simply
  continues to the next round, in either variant.
- Two rules variants, picked once by a table's creator, opaque `Text`
  stored on the table and parsed by `Rules.init`:
  - **Classic** (`""`, or any unrecognized text — the safe default):
    plain rock/paper/scissors. `#well` is illegal, rejected by
    `validate`.
  - **Well** (`"well"`): a fourth symbol, WELL, joins the other three.
    Scissors beats Paper; Paper beats Rock and Well; Rock beats
    Scissors; Well beats Rock and Scissors. This is a complete,
    deliberately UNBALANCED tournament over 4 symbols (Paper and Well
    each beat two symbols and lose to only one; Rock and Scissors each
    beat only one and lose to two) — not a symmetric extension the way
    rock-paper-scissors-lizard-Spock is. This is exactly what the rules
    description specifies; it is not a bug to "balance."
- `BotLogic.mo`'s per-seat, per-variant multiplier (see that file's own
  doc comment) is the one place this game's bot needed slightly more
  than "rotate by turn" — re-derive it (keeping each variant's own p2
  multiplier coprime to that variant's own action-set size) the same way
  if either `ACTIONS` list's own order or count ever changes.

## Motoko skills (read before editing)

Local copies of the relevant Motoko-authoring SKILL.md playbooks live in
this repo under `../../.agents/skills/` — the same set `../../CLAUDE.md`
points to (the duel-game-core-specific playbook instead lives in the
tracked `../../skills/duel-game-core/`, whose own "Turn the rules into
State/Action" step covers designing a table-time variant like this
game's own Classic/Well — read that before adding a THIRD variant here).
Consult those before editing `src/RockPaperScissorsRules.mo`,
`src/Host.mo`, or `bot/Bot.mo`/`bot/BotLogic.mo`.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `ok`/`expectErr` helpers + `Runtime.trap` on violation. Extend in kind.
  (In mo:core, `trap` lives in `Runtime`; `Debug` only has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update all four test suites when touching
  `src/RockPaperScissorsRules.mo`'s semantics.
