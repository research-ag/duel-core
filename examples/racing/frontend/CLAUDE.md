# racing duel frontend — notes for Claude

If something here costs real back-and-forth to figure out (a flag that
silently fails, a race, an odd tool), add a terse note near the relevant
section before ending the task, and correct stale guidance in place.
Describe the resulting state, never a diff against what used to be.

## App structure and duel-game-core integration

Plain TypeScript, no framework, one track and one car:

- `src/main.ts` wires the gameplay/physics/rendering services by hand
  (`new X(...)` in dependency order — see its header) and esbuild bundles
  it. Camera mode, control color, shadow resolution, and texture
  filtering are hardcoded constants; don't add a settings UI unasked.
- duel-game-core's generic screens (`#screen`, driven by
  `src/duel/duel-app.js` + `duel-racing-plugin.js`) own everything before
  and after a race. `duel-app.js` also wires, by hand and off the shared
  `ws`/`session`/`actor`, the `#leaderboard-toggle`/`#leaderboard-panel`
  and `#bot-challenge-toggle`/`#bot-challenge-panel` overlays (both
  styled by the shared `duel-game-core/style.css`, hidden during a race
  via `body.in-race`). The only per-challenge actor is the chosen bot's
  own `play`, built from `buildBotPlayIdlFactory`.
- `duel-app.js` uses `resolveIdentity()` — never the anonymous default
  identity, which the CDK's `ws_open` rejects ("Anonymous principal is
  not allowed"; symptom: a lobby stuck on loading). The keypair persists
  in `sessionStorage` and `sid` derives from its principal, as
  `isAuthorizedSid` requires. A same-principal reconnect is safe because
  the vendored CDK's `remove_client` is scoped to the exact connection; a
  recurring `ws_message: Client with principal ... doesn't have an open
connection` banner means that fix regressed.
- `lobby-connection.service.ts` fires a `status` `request()` the moment
  `getDuelWs()` resolves. Safe because `GatewayWs`'s `send()`/`request()`
  coalesce on `_ensureOpen()`. Don't add a wait-for-onopen here; a `null
client_key` decode error means that coalescing regressed.
- `lobby-connection.service.ts` shares the ONE `GatewayWs` via
  `window.duelWsReady` (an `EventTarget` listener, not `ws.onmessage`),
  submits via `request(sid, req)` for a correlated reply, and has NO poll
  loop of its own. Sharp edge: the CDK queue is keyed by
  `gateway_principal` and persists across a reconnect, so
  `SelfGatewayTransport`'s nonce is set once and never reset — a reset
  replays the queue (cars animate backwards, then teleport).
- The HUD (`game-viewport/hud/hud.ts`) subscribes to `GameStateService`
  and pokes the DOM directly; `raceTime` is polled on a `setInterval` and
  reset by `resetRaceClock()` from `startRace()`. A page-lifetime
  singleton means someone resets per-race state explicitly.

## Gameplay controls (not WASD)

A step/trajectory-selection game: click a point inside the fan-shaped arc
to pick the next arc; the car animates over about a second. No keyboard.
Logic is in `player-control.service.ts` against
`ControlSceneService.controlPlane`. To drive forward, click near the apex
of the forward arc each step; it moves every frame, so re-aim each time.

### `onStepComplete` animates cars to their END position before `startNewIteration`

`playAnimations(steps)` mutates the shared `Car` objects to each step's
final position before `startNewIteration(data)` runs. Anything needing
the pre-move positioning (collision re-derivation via
`findTrajectoryCollisionWithMap`/`hasCrashed`) must capture it in
`onStepComplete`'s `steps[]`-building loop, not read it fresh later —
otherwise the check runs against the wrong basis and fires spurious
crash penalties.

## Local verification workflow (headless, no GPU display)

`claude-in-chrome` cannot reach locally served canister URLs here
("Frame with ID 0 is showing error page"); don't retry it. Use headless
Chromium via Playwright over a persistent CDP session
(`chromium.connectOverCDP('http://127.0.0.1:9333')`):

```bash
npx playwright install chromium   # first time; re-run if the cached revision mismatches
chrome --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 \
  --headless=new --no-sandbox --use-gl=angle --use-angle=swiftshader \
  --enable-unsafe-swiftshader --ignore-gpu-blocklist
```

`disown` it; later scripts `connectOverCDP` and reuse
`context.pages()[0]`. `browser.close()` on a CDP-connected browser only
disconnects. Do NOT use `--use-gl=swiftshader --disable-gpu`; WebGL
context creation fails.

The app boots to the lobby and needs a live `backend` (`icp deploy`);
reaching gameplay means joining a seat in two sessions, or seeding a table
as `../test/RaceTestHelpers.mo` does.

- **The render loop only redraws while the car moves.** Mutating the
  scene graph and screenshotting shows a stale frame until a trajectory
  click; `resize`/mouse-move don't trigger a redraw.
- **Inspecting the scene graph:** fake `window.__THREE_DEVTOOLS__` via
  `page.addInitScript` to capture `observe`/`register` events (Scene,
  Object3D, Renderer; no camera).
- **Screenshots lag fast state changes** (0.5–1.5s to encode). Read
  state synchronously via `page.evaluate()` where a value exists; reserve
  screenshots for visual-only checks.
- **Temporary debug hooks:** `(window as any).__gameStateDebug = this; //
TEMP-DEBUG-REMOVE` in a service constructor, drive via
  `page.evaluate`; grep for `TEMP-DEBUG-REMOVE` and delete before
  finishing.

## `src/assets/` format and naming conventions

Each model directory ships `<name>.glb` plus a `<name>.meta` JSON sidecar
with `dummies` (name, position, Euler rotation, `properties`) and
`curves` (name, ordered points). `model-loader.service.ts` loads both;
`map-loader.service.ts` matches:

- `map-polygon_outer`/`map-polygon_inner` (curves) — boundary polygons.
- `player-position_NN` (dummies) — start positions.
- `road_path` (curve) — centerline.
- `proxy_<id>` (dummies, optionally `.001`, ...) — places
  `assets/proxies/<id>.glb` at the dummy, scaled by its `scale` property.
  Don't reintroduce a random scatterer unasked.

New assets are produced externally and dropped in this layout; there is
no authoring pipeline here.
