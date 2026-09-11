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
  `joinTable`/`submit`/`rematch`/`leave`/`reset`/`ackEnded` have NO plain
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
  design.
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
  simulating a whole race). The `*.test.mo` suffix is what `mops test`
  discovers — a file named `FooTest.mo` is silently skipped, so keep the
  suffix when adding suites.
- **`icp.yaml`** — icp-cli manifest; deploys `src/Host.mo` as canister
  `backend` and `frontend/dist` (esbuild's bundled output — see
  `frontend/README.md`, NOT `frontend/` itself) as an asset canister.
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
  `mixin<system>(...)` wiring for `mo:duel-game-core/actor_mixin`, also
  type-checks cleanly under 1.11.2), node/npm for the frontend.
- Motoko dependencies: `duel-game-core` (path dependency on `../../backend`
  — see `mops.toml`), `core` (mo:core), and `ic-websocket-cdk` (only
  because `src/Host.mo` opts into `mo:duel-game-core/ws` — see
  `../../CLAUDE.md`'s toolchain note). Never import `mo:base` directly in
  this game's own code — it's the legacy library; `ic-websocket-cdk`
  pulling it in transitively is a documented, contained exception, not
  license to import it yourself. `duel-game-core` re-exports nothing of
  `core`'s own surface, so `src/Host.mo`'s direct `mo:core/Time` import
  needs `core` listed here too, same as any real game repo would.
- `frontend/`'s npm dependencies (`frontend/package.json`) split by which
  half of the app needs them: `duel-game-core` (`file:../../../frontend`)
  is the one `duel-app.js` itself needs; `@gg-web-engine/core`,
  `@gg-web-engine/three`, `point-in-polygon`, `rxjs`, and `three` are for
  the actual 3D race (`main.ts` and everything under
  `src/app/modules/gameplay/`), esbuild-bundled into `dist/main.js`.
  `duel-app.js` imports `duel-game-core/ws.js` by its on-disk
  `./node_modules/duel-game-core/dist/ws.js` path (see `../../CLAUDE.md`'s
  toolchain note — `duel-game-core` is TypeScript now, and ships from its
  own `dist/`, gitignored, built by `npm run build` THERE, not here),
  which talks to `mo:duel-game-core/ws`'s real `ic-websocket-cdk`
  protocol and pulls in `@icp-sdk/core/candid`/`cborg` transitively
  through `duel-game-core`'s own `package.json` — a normal `npm install`
  here resolves them into `node_modules/` like any other dependency (no
  import map needed for THIS example's bundled `main.js`, since esbuild
  resolves `node_modules` normally; `duel-app.js` itself is copied as-is
  rather than bundled, though — build.js also copies the whole
  `node_modules/duel-game-core` tree alongside it so that on-disk import
  keeps resolving once deployed — so `src/index.html` still carries the
  same import map `examples/007` needs — see that file's comment — for
  `duel-game-core/ws/gateway-*.js`'s OWN bare specifiers
  (`@icp-sdk/core/candid`, `@icp-sdk/core/principal`, `cborg`) to resolve
  in the browser once that copied-as-is file pulls them in transitively).
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
mops test                  # all four
mops test Engine           # one suite — the filter is a path substring
mops test Rules            # ...so this matches Rules AND RulesUnit
```

Build the frontend, then deploy (icp-cli; `icp network start` must be
running for the local env):

```bash
(cd ../../frontend && npm run build)  # duel-game-core's own dist/ — see this file's note above
cd examples/racing/frontend
npm install --legacy-peer-deps   # see frontend/README.md's rxjs peer-dep note
npm run build                    # esbuild bundle → frontend/dist/ (icp.yaml deploys THIS, not frontend/ itself)

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
`src/RacingRules.mo` or `src/Host.mo`.

## Conventions

- Tests are plain interpreter scripts (moc -r), not a test framework:
  `ok`/`expectErr` helpers + `Runtime.trap` on violation. Extend in kind.
  (In mo:core, `trap` lives in `Runtime`; `Debug` only has `print`.)
- `msg`, not `label`, for text parameters (`label` is a reserved word).
- Update ALL FOUR test suites when touching `RacingRules.mo`'s semantics —
  and if a change moves where the finish line / wrap segment / grid
  positions are, re-derive `RaceTestHelpers.mo`'s `nearFinish()` numbers
  (see `Rules.test.mo`'s comment on it for how they were computed).
- This file, `frontend/README.md`, and `frontend/CLAUDE.md` must stay in
  sync with the code. When a change moves, renames, or removes something
  one of them describes, update the affected doc in the same change —
  describe the resulting state plainly (what's there now), not as a diff
  against what it used to be.
