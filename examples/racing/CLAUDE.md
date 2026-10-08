# racing duel — reference game built on duel-game-core

Two players race one lap of a fixed track; each round both submit the
arc they want to drive, the engine resolves both, first across the line
wins. A `#simultaneous` example with a Three.js frontend. Not part of
either package.

- **`src/RacingRules.mo`** — pure rules (physics, collision, lap
  progress); see its doc header.
- **`src/Track.mo`** — baked geometry for the one "island" map (boundary
  polygons and road centerline), generated from
  `frontend/src/assets/maps/island/scene.meta`.
- **`src/Host.mo`** — `Registry` (300s/45s), `status`, `Transport.attach` +
  `ActorMixin`, metrics with a `/metrics` route, canister players (same
  wiring as `examples/checkers`), bot discovery, and a best-lap
  leaderboard: `Leaderboard.new(50, 0)` (the default score is inert),
  `scoreFromLapMs(ms) = max(0, 3_600_000 - ms)`, and `lapMsFor` computing
  the exact in-game time from `Debrief.turns × STEP_DURATION_MS` (1000,
  in sync with `game-state.service.ts`'s `stepDuration`) minus the
  winning car's final-round overshoot (`distanceFromStart / speed`,
  clamped to `[0, 1)`). Only a clean `#finished` win records
  (`recordIfBetter`). `playerKey` special-cases `cp:` sessions to
  `leaderboardKeyOfSession`.
- **`src/BotIface.mo`** — `make_move`, imported by `Host.mo`.
- **`bot/BotLogic.mo`** — `SCRIPT_P1`/`SCRIPT_P2`, fixed arcs derived
  offline (legal forever once at cruising speed), indexed by `req.turn`;
  past the script, hold `{ l = max(5, speed * 0.75); c = 0 }`.
- **`bot/Bot.mo`** — `make_move` (`query`), `play(...)`, `register`/
  `unregister` (registers `[]`):
  `icp canister call bot register '(principal "<backend-canister-id>", "RacerBot")'`.
- **`test/*.test.mo`** — `Lifecycle`/`Rules` are scenario walks;
  `RulesUnit` the per-operation suite. `RaceTestHelpers.mo`
  (not `.test.mo`) seeds a live table one legal step from the finish
  instead of simulating a race. `Bot.test.mo` replays both scripts (plus
  the post-script clamp) through the real `validate`/`resolve`, then
  wires `chooseMove` through `canister_players` against a human seat.
- **`icp.yaml`** — `backend`, `bot`, `frontend/dist`.
- **HTTP** — besides `/semantics` and `/metrics`, `/track`
  (`Rules.trackText`) serves the three `Track` polylines a third-party
  client needs to draw the map.
- **`frontend/`** — plain TypeScript + Three.js, esbuild-bundled (see
  `frontend/README.md`, `frontend/CLAUDE.md`). `src/duel/duel-app.js` +
  `duel-racing-plugin.js` are the whole `duel-game-core` integration
  (lobby chrome, 🏆 leaderboard overlay, 🤖 Bots overlay and Challenge
  flow, bot rematch re-invite — same shape as `examples/checkers`, see
  `../../frontend/README.md`). `duel-racing-plugin.js`'s `formatScore`
  inverts `scoreFromLapMs` (`m:ss.mmm`; `0n` renders `"--:--.--"`). Keep
  its `3_600_000n` in sync with `Host.mo`'s `ONE_HOUR_MS`. The race
  itself (`src/main.ts`, `lobby-connection.service.ts`) shares the ONE
  `DuelTransport` via `window.duelTransportReady` and has no polling of its own.

## Toolchain

moc **1.14.0** (`mops.toml`; nothing here requires more than 1.11.2).
Motoko dependencies: `duel-game-core` (path to `../../backend`), `core`;
`promtracker` transitively. Never import `mo:base`.
Frontend: `duel-game-core` (`file:../../../frontend`) and `@icp-sdk/core`
for `duel-app.js`; `@gg-web-engine/core`, `@gg-web-engine/three`,
`point-in-polygon`, `rxjs`, `three` for the race. `build.js` runs
esbuild twice (`main.ts` → `dist/main.js`, `src/duel/duel-app.js` →
`dist/duel-app.js`). `install-links=true` copies `duel-game-core`; see
`../../CLAUDE.md` for the refresh procedure.

## Build & test

```bash
cd examples/racing
mops install
moc --check $(mops sources) src/RacingRules.mo
moc --check $(mops sources) src/Host.mo
mops test                  # all four; `mops test Rules` matches Rules and RulesUnit

(cd ../../frontend && npm run build)
cd frontend && npm install --legacy-peer-deps && cd ..
icp deploy                 # local → http://frontend.local.localhost:8000/
icp deploy --network ic
```

`icp.yaml`'s `build` step runs `npm run build` in `frontend/` on every
deploy.

## Architecture rules

Everything in `../../CLAUDE.md`, plus: the engine is never vendored here.

## Game-rule notes (RacingRules.mo)

- **One round = one step.** Both seats submit `Action { l; c }` (arc
  distance and curvature) in the frontend's `StepTrajectoryModel` units.
  The frontend animates client-side for feel; the chain is authoritative.
- **`validate` recomputes the reachable arc** from the car's speed and the
  baked-in characteristics.
- **`resolve` walks the arc against `Track`'s boundary polygons** exactly
  as `findTrajectoryCollisionWithMap` does and clamps to the edge (speed
  → 0). A forward/neutral collision (`l >= 0`) arms a 2-step recovery
  penalty (`validate` forces `{ l = 0; c = 0 }`); reversing never does.
- **Progress is the projection onto `Track.roadPath`**, once per round.
- **One track, one car**, both constants.
- **`LAPS_TO_WIN = 1`, win check is `lap > LAPS_TO_WIN`.** `lap` counts
  wrap-boundary crossings and the grid sits just before the wrap point,
  so the first move crosses once for free. A simultaneous finish is
  broken by total distance; an exact tie draws. `gameplay.service.ts` and
  `duel-racing-plugin.js` each carry `LAPS_TO_WIN`/`FINISH_LAP_COUNT` —
  keep all three in sync.

## Conventions

Plain interpreter tests; `msg`, not `label`. When `RacingRules.mo`
changes, update all suites; if the finish line, wrap segment, or grid
moves, re-derive `RaceTestHelpers.mo`'s `nearFinish()`; if
`nextStepArea`, tuning constants, or the grid change, re-derive
`BotLogic.mo`'s scripts and confirm `mops test Bot`. Keep this file,
`frontend/README.md`, and `frontend/CLAUDE.md` in sync with the code.
