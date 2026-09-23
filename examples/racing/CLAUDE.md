# racing duel — reference game built on duel-game-core

A complete, deployable example game that plugs into the two
`duel-game-core` packages this repo ships (`../../backend`, the Motoko
mops package; `../../frontend`, the npm package). Two players race one lap
of a fixed track, taking turns simultaneously: each round both submit
the arc they want to drive that step, the engine resolves both at once, and
first to complete the lap wins.

- **`src/RacingRules.mo`** — the racing game logic as pure functions. No
  actor, no shared functions, no storage, no Time. Plugs into the engine
  via `spec() : TP.Spec<State, Action>`, where `TP` is `mo:duel-game-core`
  (imported from `../../backend` — see `mops.toml`). See the module's own
  doc header for the physics/collision/lap-progress rules in detail.
- **`src/Track.mo`** — baked-in geometry for the one map this example
  ships (`frontend`'s "island" map): the drivable-area boundary polygons
  and the road centerline, generated once from
  `frontend/src/assets/maps/island/scene.meta` — see `frontend/CLAUDE.md`
  for that file's format. Pure data; `RacingRules.mo` is what interprets
  it.
- **`src/Host.mo`** — the host actor: forwards every call to a
  `TP.Registry<Rules.State, Rules.Action>` (built with `Registry.new`
  from `mo:duel-game-core/registry`; a multi-table lobby — anyone may
  open a table, open or access-code protected — not a single fixed
  board; see `mo:duel-game-core`'s own doc header) with
  `Time.now()` and `Rules.spec()`, wired exactly as
  `../../backend/README.md`'s example shows. Deploy target. `status` is
  the only plain Candid method on this actor (a `query`, side-effect-free
  — see `../../CLAUDE.md`'s architecture rule 8); `createTable`/
  `joinTable`/`submit`/`rematch`/`leave`/`reset`/`claimWin`/`ackEnded` have NO plain
  Candid method at all — they're reachable exclusively through
  `mo:duel-game-core/ws`'s
  `ws_message`, which is what `duel-app.js` actually talks to
  (`duel-game-core/ws.js`'s `GatewayWs`, a real `ic-websocket-cdk` client
  that self-registers this tab as its own Gateway, not client-side
  polling) — for genuine canister-driven push, real
  close-detection-driven disappearance handling, AND to close the race a
  plain update call would otherwise open (two independent update calls
  have no guaranteed relative processing order once both are in flight —
  see `../../backend/src/ws.mo`'s doc header). `status` and `Ws.attach`
  are wired directly in `Host.mo`; the four `ws_*` Candid methods
  (including `ws_message`) plus the idle-sweep timer come from a single
  `include ActorMixin<system>(ws, ...)` (`mo:duel-game-core/actor_mixin`)
  — no per-game `ws_message` declaration needed, since its `msgType`
  parameter is a plain `Blob`, not a type generic over this game's
  `State`/`Action`. See
  `../../backend/README.md`'s "Real-time push" section for the full
  design. `Host.mo` also wires Prometheus-style metrics onto the
  registry via `Registry.attachMetrics(pt)` (`pt : mo:promtracker`'s
  `Tracker`), rendered at a `/metrics` endpoint (`include
Http(renderer.renderExposition, "/metrics")`, from
  `mo:promtracker/mixins/http` — the same kind of `mixin` as
  `mo:duel-game-core/actor_mixin`, so it's subject to this file's own
  Toolchain note below) alongside `PT.allSystemMetrics` (cycles/RTS
  metrics, no `Tracker` of its own needed). Unlike `ws.mo`, this is
  entirely optional instrumentation — see `../../backend/README.md`'s
  "Metrics" section for the metrics it exposes and the full reasoning.
  `Host.mo` also wires canister players (`mo:duel-game-core/canister_players`,
  see `../../CLAUDE.md`'s "Canister players" note): `CanisterPlayers.attach`
  shares this same `registry` and reuses `attached.afterMutation` (`Ws.attach`'s
  own push fan-out) so a bot's move reaches a human opponent's browser in
  real time, same as `ws.mo` itself; the `callBot` closure passed to it is
  where the actual `await bot.make_move(req)` inter-canister call happens
  (a `try`/`catch` around it, since `Rules.Action` is concrete only here —
  see `CanisterPlayers.attach`'s own doc for why that can't live inside the
  module). `create_table_as_canister`/`join_table_as_canister`/
  `leave_as_canister`/`rematch_as_canister`/`ack_ended_as_canister`/
  `claim_win_as_canister`/`reset_as_canister` all come from one
  `include CanisterPlayersActorMixin(cpAttached)`
  (`mo:duel-game-core/canister_players_actor_mixin`, the
  `canister_players.mo` counterpart to `ActorMixin` above) — no
  hand-declared forwarding methods here; each one derives the caller's
  `cp:` session from `msg.caller` (never client-supplied — nothing to
  spoof); there is no `submit_as_canister` at all, since a canister
  player's move only ever arrives as the direct reply to a call this
  module made, never a separately-arriving request. `Host.mo` also wires
  `Ws.attach`'s own optional `onSettled` parameter to `cpAttached.settle`
  through a small mutable indirection (breaking the circular dependency
  between the two `attach` calls — see `canister_players.mo`'s own doc
  header for why), so a HUMAN's own move/leave/rematch asks a canister
  opponent to move (or acks its own finished debrief) the instant that
  human's own action makes it due. A canister-driven mutation reaches the
  same `settle` directly, in-line, with no `onSettled` hop needed. The one
  case neither eager path reaches — a stalled opponent's silence — is
  covered by `armClaimCheck`, a host closure using `Timer.setTimer`'s own
  `<system>` capability to schedule exactly one precisely-timed wakeup
  back into `settle`, claiming the win automatically on behalf of any
  canister seat that's the WAITING one once it's entitled to (the
  unattended, canister-vs-canister case included, since it fires the same
  way regardless of who the opponent is); `claim_win_as_canister`/
  `reset_as_canister` exist mainly so a canister participant can act the
  instant it's entitled to instead of waiting on that wakeup.
  `cpAttached.sweep` — the slow, full-registry safety net for whatever
  `settle` never gets called for — is folded into the SAME
  already-mandatory 30s idle-sweep timer `ActorMixin` runs, so none of
  this costs a separate timer of its own.
- **`src/BotIface.mo`** — the `CanisterPlayer` Candid interface a racing
  canister player must implement: one method, `make_move : (TP.MoveRequest<Rules.State>)
-> async Rules.Action`, the exact counterpart to a browser's own
  `GamePlugin`. Lives in `src/`, not `bot/`, because it's `src/Host.mo`
  (the GAME canister) that imports it — to type the remote bot actor it
  calls — not `bot/Bot.mo`/`bot/BotLogic.mo` (the bot canister), which
  never import it at all.
- **`bot/BotLogic.mo`** — the racing bot's move-selection logic, as a
  plain pure module (no actor, no `Time`, matching `RacingRules.mo`'s own
  style): `SCRIPT`, a fixed array of arcs baked in offline (see the
  module's own doc comment for how they were derived and why the sequence
  stays legal forever once it converges to a steady cruising speed), and
  `chooseMove`, a pure lookup into it by `req.turn` — no lookahead, no
  awareness of `req.game` at all. Kept separate from `Bot.mo` specifically
  so `test/Bot.test.mo` can call `chooseMove` directly, with no
  actor/Candid round-trip.
- **`bot/Bot.mo`** — the bot canister itself: implements
  `BotIface.CanisterPlayer`'s `make_move` as a `query` (a thin shell over
  `BotLogic.chooseMove` — pure and stateless, so there's nothing an
  update call's replication would buy it), plus
  `play(host, tableId, seat, code)`, this
  bot's own Flow 1 "self-join" entry point (see the canister-players
  design's "Lobby & opponent selection" section) — hand it a racing
  `Host.mo`-shaped canister's id, a table id, a seat, and that table's
  access code (however you like; entirely outside this engine's concern),
  and it calls that canister's own `join_table_as_canister` on its own
  account. Deploy target (see `icp.yaml` below) — a deliberately "dumb"
  bot that proves the wiring end to end, not a competitive racer. This
  same `play` method is also what the frontend's own `Add Bot` control
  calls directly (see the `frontend/` bullet below) — a plain Candid
  call from the browser straight to this canister, not routed through
  `Host.mo`/`ws.mo` at all.
- **`test/*.test.mo`** — interpreter-run suites. `Lifecycle.test.mo` and
  `Rules.test.mo` are scenario walks (one long session / the headline game
  rules); `Engine.test.mo` and `RulesUnit.test.mo` are per-operation unit
  suites covering the error variants, takeover gates, and physics/validate
  edge cases the scenarios never reach. `Engine.test.mo` and
  `Lifecycle.test.mo` exercise the SAME engine code the `../../backend`
  package ships (via the mops dependency below) with these rules plugged
  in — they are not a second copy of the engine's own test suite.
  `test/RaceTestHelpers.mo` is a shared, deliberately NOT `.test.mo`-suffixed
  fixture module (see its doc header for why: driving a full, physics-real
  2-lap race would make the suites slow and non-deterministic, so it seeds
  a live table with a car one legal step from the finish line instead of
  simulating a whole race). `test/Bot.test.mo` covers `BotLogic.mo`: it
  replays `SCRIPT` (plus several rounds of the post-script "hold the last
  entry" clamp) through the REAL `RacingRules.validate`/`resolve` — a
  permanent regression guard on the offline-derived numbers actually
  staying legal against real collision checks, not just the idealized,
  no-wall formula they were derived from — and separately wires
  `BotLogic.chooseMove` through a live `mo:duel-game-core/canister_players`
  as the `callBot` continuation (no real second canister needed for
  this — see the file's own doc header) to prove a canister-seated bot
  drives several rounds against a human with no illegal move. The
  `*.test.mo` suffix is what `mops test`
  discovers — a file named `FooTest.mo` is silently skipped, so keep the
  suffix when adding suites.
- **`icp.yaml`** — icp-cli manifest; deploys `src/Host.mo` as canister
  `backend`, `bot/Bot.mo` as canister `bot` (this example's own
  milestone-01 canister player — see that file's own doc header), and
  `frontend/dist` (esbuild's bundled output — see `frontend/README.md`,
  NOT `frontend/` itself) as an asset canister.
- **`frontend/`** — a plain-TypeScript (no framework) Three.js racing
  client, bundled with esbuild (`npm run build`, see `frontend/README.md`).
  The 3D engine (physics, rendering, camera, click-to-drive control) is
  wired by hand in `frontend/src/main.ts` — no DI framework, no NgModules,
  no decorators.
  `frontend/src/duel/duel-app.js` + `duel-racing-plugin.js` are the whole
  `duel-game-core` integration (a `GamePlugin`, exactly like the `examples/007`
  frontend) — they own the multi-table lobby/staging/rematch/debrief
  chrome, driven by the real push transport `start()` requires
  (`duel-game-core/ws.js`'s `connectWs()`, exactly like
  `examples/007/frontend/app.js` — see `../../frontend/README.md`'s
  "Real-time push" section; this game's own code never touches
  `mo:duel-game-core/ws`'s protocol directly — `duel-game-core/ws/
gateway-*.js` does, registering this tab as its own WS Gateway).
  There is no polling fallback anywhere in this stack any more — the
  backend has no plain mutating Candid method to poll in the first place
  (see `../../CLAUDE.md`), so `duel-game-core` ships no plain-polling
  transport at all.
  `duel-app.js` also wires a small `Add Bot` control (`index.html`'s
  `#play-vs-bot-panel`, a sibling of `#screen`, positioned/styled in
  `style.css` to read as a continuation of the same card) — Flow 1's
  human-facing entry point (see `../CLAUDE.md`'s "Canister players"
  note): shown only for the generic "Waiting for an opponent" screen
  (`render.js`'s `stagingYou`, detected off a
  `ws.addEventListener("message", ...)` listener, the same
  `GatewayWs`-as-`EventTarget` technique `lobby-connection.service.ts`
  uses below), it reads that SAME status push's own open seat/table
  id/access code and, on click, calls the deployed `bot/Bot.mo`
  canister's own `play(host, tableId, seat, code)` directly — a plain
  Candid call to a SECOND, ad-hoc-IDL'd actor (built from
  `duel-game-core/idl.js`'s exported `buildEngineTypes`, so `Seat`/
  `TableId`/`Err` aren't redeclared by hand), never routed through
  `ws.mo`'s protocol or the shared `ws` at all — the bot then joins on
  its own account via `join_table_as_canister`, exactly Flow 1's
  "self-join" shape, just automated instead of hand-fed a table id/seat/
  code. Deliberately NOT `Registry.createTableReserving`/Flow 2: that
  call only ever seats both sides of a BRAND NEW table atomically, with
  no way to fill an already-staged table's open seat — exactly this
  screen's situation (a table this player already created, choosing
  their own seat, now waiting on the other one). `PUBLIC_CANISTER_ID:bot`
  missing from this deploy's `ic_env` cookie (a fork with no `bot`
  canister declared in `icp.yaml`) leaves the panel hidden for good.
  `frontend/src/main.ts`'s own gameplay code (really
  `lobby-connection.service.ts`, wired in via `gameplay.service.ts`)
  shares that EXACT connection (`duel-app.js` publishes it on
  `window.duelWsReady`, read via `duel-actor.ts`'s `getDuelWs()`) and has
  no polling of its own at all — there is only ever ONE communication
  channel to the canister, chrome and race alike — `GatewayWs` runs
  exactly one poll loop shared by both halves of the app, so two
  independent fetches can never resolve out of order and race each
  other. It still has one sharp edge worth knowing before touching it:
  the CDK's outgoing queue is keyed by `gateway_principal` (this tab's
  own stable identity, unchanged across a reconnect), not by
  `client_key`, so that queue persists across a reconnect too —
  `SelfGatewayTransport`'s polling nonce must therefore only ever be
  set once, in the constructor, and never reset on a later `open()` (see
  `../../frontend/ws/gateway-transport.js`'s `open()` comment). Resetting
  it on reconnect would replay the whole persisted queue from the start,
  re-delivering already-processed `#view` pushes in a fast burst — visible
  as a car briefly animating backwards before "teleporting" to the
  correct position — before catching up to the real current one. If that
  symptom ever appears, the general bug class to suspect is "something
  reset polling/fetch state across a reconnect that should have
  persisted," not necessarily this exact nonce again.
  See `frontend/README.md` and `frontend/CLAUDE.md` for the split in
  detail (including exactly how `lobby-connection.service.ts` uses the
  shared poller's `request()`), gameplay controls, and the headless
  verification workflow.

## Toolchain

- moc **1.14.0** (mops toolchain — newer than `../../backend`'s and
  `examples/007`'s pinned 1.11.2, though nothing in this example's own
  source actually requires it: every file here, including `src/Host.mo`'s
  `mixin<system>(...)` wiring for `mo:duel-game-core/actor_mixin` AND its
  `include Http(...)` wiring for `mo:promtracker/mixins/http`, also
  type-checks cleanly under 1.11.2), node/npm for the frontend.
- Motoko dependencies: `duel-game-core` (path dependency on `../../backend`
  — see `mops.toml`), `core` (mo:core), `ic-websocket-cdk` (only because
  `src/Host.mo` opts into `mo:duel-game-core/ws`), and `promtracker`
  (only because `src/Host.mo` opts into the metrics wiring described
  above) — see `../../CLAUDE.md`'s toolchain note for both of the
  latter. Neither is listed under `mops.toml`'s own `[dependencies]`
  here — both arrive transitively through `duel-game-core`'s own
  `mops.toml`, same as `ic-websocket-cdk` already did before promtracker
  existed; `mops sources` resolves the whole tree regardless of which
  `mops.toml` first declared a package. `src/Host.mo`'s third opt-in,
  `mo:duel-game-core/canister_players`, needs nothing further: that
  module depends on nothing but `core` and its sibling engine modules,
  already pulled in regardless. Never import `mo:base` directly
  in this game's own code — it's the legacy library; `ic-websocket-cdk`
  pulling it in transitively is a documented, contained exception, not
  license to import it yourself. `duel-game-core` re-exports nothing of
  `core`'s own surface, so `src/Host.mo`'s direct `mo:core/Time` import
  needs `core` listed here too, same as any real game repo would.
- `frontend/`'s npm dependencies (`frontend/package.json`) split by which
  half of the app needs them: `duel-game-core` (`file:../../../frontend`)
  and `@icp-sdk/core` are what `duel-app.js` itself needs;
  `@gg-web-engine/core`, `@gg-web-engine/three`, `point-in-polygon`,
  `rxjs`, and `three` are for the actual 3D race (`main.ts` and
  everything under `src/app/modules/gameplay/`). `build.js` runs esbuild
  twice — once bundling `main.ts` into `dist/main.js`, once bundling
  `src/duel/duel-app.js` (which imports `duel-game-core/ws.js` and
  `duel-game-core/identity.js` — its `package.json` `exports` map, not an
  on-disk path — see `../../CLAUDE.md`'s toolchain note: `duel-game-core`
  is TypeScript now, and ships from its own `dist/`, gitignored, built by
  `npm run build` THERE, not here) into `dist/duel-app.js`. Both bundles
  pull in everything they need — `@icp-sdk/core` directly, `@icp-sdk/auth`
  and `cborg` transitively through `duel-game-core`'s own `package.json`
  — from `node_modules` at build time (a normal `npm install
--legacy-peer-deps` resolves them there like any other dependency; see
  `../../frontend/README.md`'s note on why the flag is needed). Neither
  bundle needs an import map: esbuild inlines every one of those
  dependencies directly into `dist/main.js`/`dist/duel-app.js`, so the
  deployed page loads nothing from a CDN.
- **Gotcha:** `frontend/.npmrc` sets `install-links=true` (same reasoning
  as `examples/007`'s — see its `CLAUDE.md`), so `duel-game-core` is
  COPIED into `node_modules/duel-game-core`, not symlinked. A plain `npm
install` after editing `../../frontend/` reports nothing to do and does
  NOT refresh that copy. See `../../../CLAUDE.md`'s "After touching
  anything under `frontend/`" section for the actual refresh procedure —
  **always `npm run build` inside `../../frontend/` first** (its
  `prepare` script does NOT reliably do this for you here — this repo's
  `allow-scripts` gate blocks it, confirmed live), then a fast direct
  `rsync` copy in the common case, followed by re-running `npm run
build` HERE too; a full `node_modules`+lockfile reinstall with
  `--legacy-peer-deps` only if `frontend/package.json`'s own
  `dependencies` changed. Do this proactively after any change there,
  not just when asked to deploy.

## Build & test

```bash
cd examples/racing
mops install                       # fetches duel-game-core (../../backend) + core

# Type-check:
moc --check $(mops sources) src/RacingRules.mo
moc --check $(mops sources) src/Host.mo

# Run the test suites (interpreter mode; they Debug.print progress and end
# with "ALL ... CHECKS PASSED"; any trap = a FAIL, exit code 1):
mops test                  # all five
mops test Engine           # one suite — the filter is a path substring
mops test Rules            # ...so this matches Rules AND RulesUnit
mops test Bot              # BotLogic.mo, offline and wired through canister_players
```

Install the frontend's own dependencies, then deploy (icp-cli; `icp
network start` must be running for the local env). `icp.yaml`'s
asset-canister recipe declares `npm run build` (inside `frontend/`) as a
`build` step, so `icp build`/`icp deploy` runs it — and therefore
esbuild-bundles `frontend/dist/` (icp.yaml deploys THIS, not
`frontend/` itself) from current source — automatically; there's no
separate manual build step to run first:

```bash
(cd ../../frontend && npm run build)  # duel-game-core's own dist/ — see this file's note above
cd examples/racing/frontend
npm install --legacy-peer-deps   # see frontend/README.md's peer-dep note; populates node_modules only

cd ..
icp deploy                 # local  → http://frontend.local.localhost:8000/
icp deploy --network ic    # mainnet — spends cycles
```

## Architecture rules

This game inherits every rule in `../../CLAUDE.md`'s "Architecture rules"
section (spec passed per call / never stored, the engine owns time, rules
stay pure, `validate` is the only legality gate, etc.) — read that file
first. One rule specific to this example:

1. **The engine lives in `../../backend` and is never vendored here.**
   `src/RacingRules.mo` and `src/Host.mo` import it as `mo:duel-game-core`.
   If you find yourself copy-pasting engine code into this directory to fix
   something, fix it in `../../backend/src/lib.mo` instead and re-run
   `mops install` here.

## Game-rule notes (RacingRules.mo)

- **One round = one step.** Both seats submit an `Action { l; c }` — the
  arc (distance, curvature) they want to drive this step, in the SAME
  units the frontend's `StepTrajectoryModel` already computes client-side.
  The frontend keeps doing its own client-side physics/rendering for feel;
  the chain is authoritative for what actually happened.
- **`validate` recomputes the reachable arc itself** from the car's current
  speed and its (single, baked-in) characteristics — a client can't request
  a faster car or a tighter turn than physics allows by bypassing its own
  UI's clamps.
- **`resolve` walks the requested arc against `Track`'s boundary polygons**
  exactly as the frontend's `findTrajectoryCollisionWithMap` does, and
  clamps the car to the edge (speed → 0) if it would leave the track. A
  forward/neutral collision (`l >= 0`) arms a 2-step recovery penalty
  (`validate` then forces `{ l = 0; c = 0 }` for 2 rounds) — reversing
  through a collision never arms it, matching the frontend's rule that
  backing off a wall isn't a "crash".
- **Progress is the car's projection onto `Track.roadPath`** (the
  centerline), each step — the same nearest-point/lap-percent-wrap
  heuristic the frontend uses, just run once per round instead of once per
  animation frame (no lineIndex/allowance bookkeeping needed as a result —
  see the module's doc header).
- **This example supports exactly one track and one car** — both `Track`'s
  geometry and the car's characteristics (steering/drag/engine/braking/
  mass) are baked-in constants, not configuration. A game with more than
  one of either would thread both through `State`/`Spec` instead.
- **`LAPS_TO_WIN = 1`, but the win check is `lap > LAPS_TO_WIN`, not `>=`.**
  `lap` counts wrap-boundary crossings of `Track.roadPath`, not real laps
  driven, and the starting grid sits right before that same wrap point —
  so a race's very first move already crosses it once "for free" (lap
  0 → 1) without anyone having driven anywhere near an actual lap. Every
  crossing after that first one is a real lap, so finishing `LAPS_TO_WIN`
  real laps takes `LAPS_TO_WIN + 1` raw crossings (see `resolve`'s own
  comment on this) — drop the `+ 1` and the game ends after the very
  first move instead of after a real lap. A simultaneous finish (both
  cross the line the same round) is broken by total distance travelled,
  not seat order; an exact tie draws. The frontend carries TWO
  independent copies of this whole quirk —
  `gameplay.service.ts`'s `LAPS_TO_WIN`/`FINISH_LAP_COUNT`
  constants (a client-side "someone finished" check) and
  `duel-racing-plugin.js`'s own `LAPS_TO_WIN`/`FINISH_LAP_COUNT` (the
  generic debrief/HUD's lap display) — keep all three (this module plus
  both frontend copies) in sync.

## Motoko skills (read before editing)

Local copies of the relevant Motoko-authoring SKILL.md playbooks live in
this repo under `../../.agents/skills/` — the same set `../../CLAUDE.md`
points to (the duel-game-core-specific playbook instead lives in the
tracked `../../skills/duel-game-core/`). Consult those before editing
`src/RacingRules.mo`, `src/Host.mo`, or `bot/Bot.mo`/`bot/BotLogic.mo`.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `ok`/`expectErr` helpers + `Runtime.trap` on violation. Extend in kind.
  (In mo:core, `trap` lives in `Runtime`; `Debug` only has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update `Lifecycle.test.mo`/`Rules.test.mo`/`Engine.test.mo`/`RulesUnit.test.mo`
  when touching `RacingRules.mo`'s semantics — and if a change moves where
  the finish line / wrap segment / grid positions are, re-derive
  `RaceTestHelpers.mo`'s `nearFinish()` numbers (see `Rules.test.mo`'s
  comment on it for how they were computed). If the change alters
  `nextStepArea`, the car's tuning constants, or `Track`'s starting grid,
  also re-derive `BotLogic.mo`'s `SCRIPT` the same way its own doc
  comment describes, and confirm `mops test Bot` still passes.
- This file, `frontend/README.md`, and `frontend/CLAUDE.md` must stay in
  sync with the code. When a change moves, renames, or removes something
  one of them describes, update the affected doc in the same change —
  describe the resulting state plainly (what's there now), not as a diff
  against what it used to be.
