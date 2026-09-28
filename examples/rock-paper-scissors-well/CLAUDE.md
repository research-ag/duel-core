# rock-paper-scissors-well duel — reference game built on duel-game-core

A complete, deployable example game that plugs into the two
`duel-game-core` packages this repo ships (`../../backend`, the Motoko
mops package; `../../frontend`, the npm package). A 4-symbol expansion of
`examples/rock-paper-scissors`: a fourth pick, WELL, joins rock/paper/
scissors — Scissors beats Paper; Paper beats Rock and Well; Rock beats
Scissors; Well beats Rock and Scissors. First to 3 round wins takes the
match. It exists alongside `examples/rock-paper-scissors` as a second,
slightly richer `#simultaneous` reference (a complete, asymmetric
tournament over 4 symbols rather than a plain 3-way cycle) — it is **not**
part of either package itself.

- **`src/RockPaperScissorsWellRules.mo`** — the game logic as pure
  functions. No actor, no shared functions, no storage, no Time. Plugs
  into the engine via `spec() : TP.Spec<State, Action>`, where `TP` is
  `mo:duel-game-core` (imported from `../../backend` — see `mops.toml`).
  `validate` always returns `null` — every pick is always legal.
  `resolve`'s own `p1Beats` spells out all six distinct pairs explicitly
  (Paper and Well each beat two symbols and lose to one; Rock and
  Scissors each beat one and lose to two — this is NOT the symmetric
  "adjacent beats adjacent" cycle plain rock-paper-scissors has, so there
  is no shortcut formula to derive a winner from the two picks' index
  positions alone). See the module's own doc header for the full rules
  text.
- **`src/Host.mo`** — the host actor, identical in shape to
  `examples/rock-paper-scissors/src/Host.mo` (down to the metrics/
  canister-players/bot-discovery/ELO-leaderboard wiring) — see that
  file's own `CLAUDE.md` bullet for the full explanation; nothing here is
  specific to this game's own rules. `Registry.new(60_000_000_000,
15_000_000_000)`, `STARTING_ELO = 1200` — same defaults as
  `rock-paper-scissors`.
- **`src/BotIface.mo`** — the `CanisterPlayer` Candid interface a
  rock-paper-scissors-well canister player must implement: one method,
  `make_move : (TP.MoveRequest<Rules.State, Rules.Action>) -> async
Rules.Action`.
- **`bot/BotLogic.mo`** — the bot's move-selection logic: `chooseMove`
  rotates deterministically through `[rock, paper, scissors, well]` by
  `req.turn`, offset by a per-seat multiplier (1 for p1, 3 for p2 — 3 is
  coprime to the action set's own size of 4, so p2's rotation still
  visits every symbol) so two copies of this bot playing each other don't
  lock into the identical pick every round forever. No lookahead, no
  opponent modeling — see that file's own doc comment for why the
  multiplier is needed here (this game's action set has no board position
  to vary the pick by, unlike checkers' `moves[req.turn %
moves.size()]`). Kept separate from `Bot.mo` so `test/Bot.test.mo` can
  call `chooseMove` directly, with no actor/Candid round-trip.
- **`bot/Bot.mo`** — the bot canister itself: implements
  `BotIface.CanisterPlayer`'s `make_move` as a `query`, plus
  `play(host, tableId, seat, code)` (Flow 1's self-join entry point) and
  `register(host, name)`/`unregister(host)` for bot discovery. Deploy
  target (see `icp.yaml`).
- **`test/*.test.mo`** — interpreter-run suites, matching
  `examples/rock-paper-scissors`'s own shape exactly.
  `RulesUnit.test.mo` drives `validate`/`resolve` directly: every one of
  the six distinct pairs (and each pair's own mirror image), a tie, and
  the first-to-3 match win. `Engine.test.mo`/`Lifecycle.test.mo` plug the
  real rules into the real engine, deliberately reusing only the plain
  rock-paper-scissors sub-triangle (rock/paper/scissors, never well) for
  their own move sequences, since those three symbols' beats-relationship
  is identical in both games — the well symbol adds no NEW engine-facing
  behavior to exercise beyond what `RulesUnit.test.mo`'s own pair checks
  already cover directly. `Bot.test.mo` confirms `chooseMove` always
  returns a legal pick, then wires two canister-seated bots through a
  live `mo:duel-game-core/canister_players` to play a full real match to a
  decisive finish, proving the per-seat multiplier actually avoids the
  lock-step tie it exists to prevent. The `*.test.mo` suffix is what
  `mops test` discovers — a file named `FooTest.mo` is silently skipped.
- **`icp.yaml`** — icp-cli manifest; deploys `src/Host.mo` as canister
  `backend`, `bot/Bot.mo` as canister `bot`, and `frontend/dist` (esbuild's
  bundled output — see this file's "Build & test" section, NOT
  `frontend/` itself) as an asset canister.
- **`frontend/`** — vanilla-JS web client (no framework), bundled with
  esbuild. `rpsw-plugin.js` is the whole game-specific surface: it
  implements the `GamePlugin` contract — a scoreboard, the last round's
  two picks side by side, and four emoji buttons (🪨📄✂️🪣) for the next
  pick. `app.js` is identical in shape to
  `examples/rock-paper-scissors/frontend/src/app.js` (same leaderboard
  toggle, same "🤖 Bots" challenge flow). `style.css` reuses the same
  scoreboard/last-round/action-button classes as
  `examples/rock-paper-scissors`'s own stylesheet.

## Toolchain

- moc **1.11.2** (mops toolchain, pinned in `mops.toml`), node/npm for the
  frontend.
- Motoko dependencies: `duel-game-core` (path dependency on
  `../../backend`), `core` (mo:core), `ic-websocket-cdk` (via
  `mo:duel-game-core/ws`), and `promtracker` (via the metrics wiring) —
  see `../../CLAUDE.md`'s toolchain note. Neither is listed under this
  file's own `mops.toml` `[dependencies]` — both arrive transitively
  through `duel-game-core`'s own `mops.toml`. Never import `mo:base`
  directly in this game's own code.
- The frontend's npm dependencies split the same way
  `examples/rock-paper-scissors`'s do — see that game's own `CLAUDE.md`
  toolchain note for the full reasoning (identical here).

## Build & test

```bash
cd examples/rock-paper-scissors-well
mops install                       # fetches duel-game-core (../../backend) + core

# Type-check:
moc --check $(mops sources) src/RockPaperScissorsWellRules.mo
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
cd examples/rock-paper-scissors-well
icp deploy                 # local  → http://frontend.local.localhost:8000/
icp deploy --network ic    # mainnet — spends cycles
```

The asset-canister recipe must be **v2.3.0 or newer** (v2.1.0 syncs with
an `assets` step icp-cli 1.x rejects outright).

Play both seats by opening the deployed URL in two separate browser
tabs — create a table in one, join it from the other, and confirm a real
match plays out correctly. The Motoko tests passing and the frontend
building are both necessary but not sufficient; nothing here automates
an actual two-tab playthrough.

## Architecture rules

This game inherits every rule in `../../CLAUDE.md`'s "Architecture rules"
section (spec passed per call / never stored, the engine owns time, rules
stay pure, `validate` is the only legality gate, etc.) — read that file
first. One rule specific to this example:

1. **The engine lives in `../../backend` and is never vendored here.**
   `src/RockPaperScissorsWellRules.mo` and `src/Host.mo` import it as
   `mo:duel-game-core`. If you find yourself copy-pasting engine code into
   this directory to fix something, fix it in `../../backend/src/lib.mo`
   instead and re-run `mops install` here.

## Game-rule notes (src/RockPaperScissorsWellRules.mo)

- Seats: plain `#p1`/`#p2`, labeled "Player 1"/"Player 2" in the frontend
  — the rules name neither side.
- `WINS_NEEDED = 3` (first to 3 round wins takes the match) is a fixed
  game constant, not a configuration field.
- A tied round (both pick the same thing) scores nobody and simply
  continues to the next round.
- This game is a deliberately UNBALANCED 4-symbol tournament, not a
  symmetric extension of rock-paper-scissors the way rock-paper-
  scissors-lizard-Spock is (where every symbol beats exactly two others
  and loses to exactly two) — Paper and Well each beat two symbols and
  lose to only one, while Rock and Scissors each beat only one and lose
  to two. This is exactly what the rules description specifies; it is not
  a bug to "balance."
- `BotLogic.mo`'s per-seat multiplier (see that file's own doc comment) is
  the one place this game's bot needed slightly more than "rotate by
  turn" — re-derive it (keeping it coprime to `ACTIONS.size()`) the same
  way if `ACTIONS`'s own order or count ever changes.

## Motoko skills (read before editing)

Local copies of the relevant Motoko-authoring SKILL.md playbooks live in
this repo under `../../.agents/skills/` — the same set `../../CLAUDE.md`
points to (the duel-game-core-specific playbook instead lives in the
tracked `../../skills/duel-game-core/`). Consult those before editing
`src/RockPaperScissorsWellRules.mo`, `src/Host.mo`, or
`bot/Bot.mo`/`bot/BotLogic.mo`.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `ok`/`expectErr` helpers + `Runtime.trap` on violation. Extend in kind.
  (In mo:core, `trap` lives in `Runtime`; `Debug` only has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update all four test suites when touching
  `src/RockPaperScissorsWellRules.mo`'s semantics.
