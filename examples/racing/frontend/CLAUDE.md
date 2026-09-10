# racing duel frontend — notes for Claude

## Keep this file and README.md current

If you struggle with something in this repo — a flag that silently fails, a
race condition, a tool that behaves unexpectedly, anything that costs real
back-and-forth to figure out — and you find a working fix, add a short note
to this file documenting it **before** ending the task. Future sessions start
cold and will otherwise burn the same time rediscovering it. Keep entries
terse, put them in/near the relevant existing section rather than a
scrolling changelog at the bottom, and prefer correcting a stale instruction
in place over leaving both the old (wrong) and new guidance side by side.

The same applies whenever a change you make alters what this file or
`README.md` describe — a moved/renamed/deleted file, a dependency that's
gone, a section describing behavior that no longer exists. Update the
affected section(s) in the same change, describing the resulting state
plainly (what the code does/looks like now), not as a diff against what it
used to be ("X used to do Y, now it does Z" reads as changelog noise to a
fresh session that never saw Y). A stale doc costs the next cold-start
session exactly as much time as a wrong one.

## App structure and duel-game-core integration

A single track, single car example (duel-game-core's own multi-table
lobby is what this game uses — see below — there's just nothing here to
choose beyond a table and a seat), plain TypeScript with no framework:

- `src/main.ts` wires the gameplay/physics/rendering services together by
  hand (plain `new X(...)` calls, dependency order matters — see its
  header comment) and bundles with esbuild (`npm run build`, see
  `README.md`) — no `@angular/*`, no NgModules, no decorators. The
  service/model classes under `src/app/modules/gameplay/` are one class
  per file with constructor-injected dependencies.
- duel-game-core's own generic screens (`index.html`'s `#screen`, driven
  by `src/duel/duel-app.js` + `src/duel/duel-racing-plugin.js`) own
  everything before and after a race: creating/browsing/joining a table,
  choosing a seat, waiting for an opponent, rematch, debrief. There is
  exactly one track and one car (see `../CLAUDE.md`) — no settings UI, no
  login, no user menu, no car/map selection. The camera mode, step-control color,
  shadow resolution, and texture filtering are fixed constants, hardcoded
  at their call sites (`player-view.service.ts`,
  `control-scene.service.ts`, `world-scene.service.ts`); the camera is
  always the static view — don't add a settings UI or a camera-mode
  switch without being asked.
- `src/duel/duel-app.js` builds `agent`'s identity from a FRESH Ed25519
  keypair generated on every page load (`Ed25519KeyIdentity.generate()`,
  no seed), not the plain anonymous identity `HttpAgent.create({ host })`
  defaults to. This game has no login, but `ic-websocket-cdk`'s
  `ws_open` hard-rejects an anonymous caller outright ("Anonymous
  principal is not allowed") — with no `identity` passed, the WS
  handshake (and with it the whole app, since there's no polling
  fallback) never came up at all; that's the real bug behind a console
  full of repeating `ws_open: Anonymous principal is not allowed` errors
  and a lobby that never leaves the loading state.
  **Do NOT derive that identity's seed from this tab's own `sid`** so it
  stays the same across a plain reload: `ic-websocket-cdk@0.4.1`'s own
  `remove_client` cleans up its principal->client_key lookup by
  PRINCIPAL alone, not scoped to the specific `client_key` being removed.
  A plain reload gives the OLD page's own `ws_close()` no guarantee of
  completing before the tab is torn down, so if that stale close (or its
  eventual keep-alive-timeout eviction) lands AFTER the NEW page has
  re-registered under the SAME principal, it silently erases the NEW,
  perfectly-live connection's own lookup entry — surfacing as
  `ws_message: Client with principal ... doesn't have an open
  connection` immediately, and "Connection closed — reload to
  reconnect." once the ack keep-alive can no longer be sent either.
  Retry logic alone can't paper over this — `../../../frontend/ws/
  gateway-client.js`'s send retries and `_invalidateAndRetry()` reopen on
  failure, but neither stops a live connection's lookup entry from being
  erased out from under it in the first place; only NOT sharing a
  principal across reload (this fresh-per-load identity) does. `sid`
  itself — the engine's actual player identity — already persists across
  reload via sessionStorage regardless, completely independent of this
  principal, so nothing player-visible is lost by not also pinning the
  WS-layer identity. If "Connection closed" or this exact `ws_message`
  error ever comes back, check whether something reintroduced a
  stable-across-reload principal before assuming it's a new bug.
  `duel-app.js` loads `Actor`/`HttpAgent` from `@icp-sdk/core@6.1.0/agent`
  and `Ed25519KeyIdentity` from `@icp-sdk/core@6.1.0/identity` on
  esm.sh, both pinned to the same exact version — `agent` and `identity`
  are submodules of the SAME package, so one shared version pin keeps
  them mutually consistent with no further query-string tricks needed.
- `lobby-connection.service.ts`'s `init()` fires an immediate `status`
  `request()` the moment `getDuelWs()` resolves, ahead of the shared
  connection's own first poll tick. This is safe only because
  `../../../frontend/ws/gateway-client.js`'s `send()`/`request()`
  themselves coalesce on `_ensureOpen()` and wait for the `ws_open`
  handshake to actually finish before sending anything (see
  `../../../frontend/README.md`'s "Real-time push" section) — calling
  `request()` before the connection is known-open is safe precisely
  because of that coalescing. Don't add a "wait for onopen first"
  workaround here: if a call fired this early ever again surfaces as
  "duel status request failed" in the console with a `null` `client_key`
  (`Invalid record ... field client_key -> Cannot read properties of
  null (reading 'hasOwnProperty')`), the bug is that `_ensureOpen()`'s
  own coalescing regressed, not that this file needs its own open-wait.
- `game-communication/services/lobby-connection.service.ts` shares the
  SAME `GatewayWs` duel-game-core's own chrome uses for push (one
  connection via `window.duelWsReady`, one session id via
  `sessionStorage` — see `duel-actor.ts`), and turns whatever view it
  delivers into the `{ slot, step }[]` event shape (`nextStep`,
  `emitNextStep`, `lobbyData`, ...) `gameplay.service.ts` expects. It has
  **no polling of its own**: `init()` subscribes to the connection's
  `message` event (`GatewayWs` extends `EventTarget`, so this doesn't
  steal duel-app.js's own `ws.onmessage` — see
  `../../../frontend/ws/gateway-client.js`), and `emitNextStep()`
  submits a move via `request(sid, req)` (not `send()`), which resolves
  to THAT call's own `{ view } | { err }` — correlated to this specific
  submission, not whichever view the shared connection's push stream
  happens to deliver next — so `gameplay.service.ts`'s existing
  rejection/retry logic needed no changes. This service must keep having
  NO poll loop of its own: `GatewayWs` runs exactly one poll loop shared
  by chrome and race alike, so two independent fetches can never resolve
  out of order and race each other. One sharp edge is still worth
  knowing before touching `SelfGatewayTransport` (in
  `../../../frontend/ws/gateway-transport.js`): its `gateway_principal`
  is this tab's own stable identity, unchanged across a reconnect, and
  the CDK's outgoing queue is keyed by that principal (not by
  `client_key`) — so the queue itself persists across a reconnect too.
  Its polling nonce must therefore only ever be set once, in the
  constructor, and never reset in `open()`; resetting it on reconnect
  would replay the whole persisted queue from the start, re-delivering
  already-processed `#view` pushes in a fast burst — visible as a car
  briefly animating backwards before "teleporting" to the correct
  position — before catching up to the real current one. If this symptom
  shows up, look for "something got reset that should have persisted
  across a reconnect."
  `duel-game-core` ships no plain-polling fallback anywhere — no `?ws=0`
  flag, no `app.js`-side poll loop, no `ws/poller.js` module: `ws` is
  unconditionally required end to end, and the backend has no plain
  mutating Candid method to poll in the first place (see
  `../CLAUDE.md`/`../../../backend/src/ws.mo`'s doc header).
- The in-race HUD (speedometer / minimap / position+time panel) is
  `app/modules/gameplay/game-viewport/hud/hud.ts` — one plain class that
  subscribes to `GameStateService`'s subjects directly and pokes the DOM
  by hand (a CSS `conic-gradient` ring for the speedometer, no
  tick-mark/needle trigonometry). `GameStateService.raceTime` is a plain
  getter with no observable behind it, so the HUD polls it on a
  `setInterval`; its backing fields are reset via `resetRaceClock()`,
  called from `gameplay.service.ts`'s `startRace()` — remember this
  "page-lifetime singleton means someone has to reset per-race state
  explicitly" pattern if you add more per-race state elsewhere in this
  file.

## Gameplay controls (not WASD)

This is a **step/trajectory-selection racing game**, not a directly-driven car game.
While in a race, the UI shows a fan-shaped arc in front of (and behind) the car.
Clicking a point inside the arc picks the next movement trajectory (distance +
curvature) and the car animates along it over about a second, accelerating each
step. There is no continuous throttle/steering input. Holding `w`/`ArrowUp` does
nothing — control logic lives in `player-control.service.ts`
(`askForSelectedPosition` / `calculateSelectedTrajectory`), driven by mouse clicks
against `ControlSceneService.controlPlane`, not keyboard.

To drive "forward" reliably: click near the tip (apex) of the forward arc each
step — that picks max distance / ~zero curvature. The apex point moves every
frame as the car turns, so a fixed screen coordinate only works for a couple of
clicks before the car drifts into the shoulder; re-screenshot and re-aim each
time for sustained driving.

### `onStepComplete` already animates cars to their END position before `startNewIteration` runs

In `gameplay.service.ts`, `onStepComplete(data)` calls `await this.playAnimations(steps)`
(for every step past the first) *before* calling `this.startNewIteration(data)`.
`playAnimations` mutates the shared `Car` objects in `gameStateService.cars` via
`car.setFullPositioning(...)` all the way to each step's **final** position as
part of driving the ~1s move animation. So by the time `startNewIteration` runs,
`car.getFullPositioning()` no longer reflects where that step's trajectory
*started* — it's already the destination. Any logic that needs the pre-move
starting positioning for a given step (e.g. re-deriving whether a trajectory
collided with the map, via `findTrajectoryCollisionWithMap`/`hasCrashed`) must
capture it in `onStepComplete`'s first loop (the one that builds `steps[]`),
*before* `playAnimations` is awaited — not read it fresh inside
`startNewIteration`. Doing the latter silently tests the trajectory against
the wrong basis point and can produce spurious collision results (a real bug
that manifested as crash-penalty logic triggering on ordinary non-crashing
moves — fixed by moving the check into the `steps[]`-building loop).

## Local verification workflow (headless, no GPU display)

`claude-in-chrome` (the browser extension) **cannot reach locally-served
canister URLs** in this environment — e.g. `icp deploy`'s local
`http://frontend.local.localhost:8000/` (see `../CLAUDE.md`) reliably fails
with "Frame with ID 0 is showing error page" even though `curl` succeeds and
the extension works fine against real internet sites. Root cause not fully
diagnosed (suspect a Private-Network-Access-style restriction on the
extension's browser process); don't waste time retrying it for this project.

What actually works: a **local headless Chromium via Playwright**, driven from
Bash, with a persistent CDP session so multiple short Node scripts can share one
running page (`chromium.connectOverCDP('http://127.0.0.1:9333')`):

```bash
npx playwright install chromium   # first time only, ~200MB, no sudo needed if you skip --with-deps
```

If a Chromium build is already cached under `~/.cache/ms-playwright/` from a
prior session, it can be a **different revision** than what a freshly
`npm install`ed `playwright` package expects (compare
`node_modules/playwright-core/browsers.json`'s `chromium.revision` against
the cached `chromium-<rev>` directory name) — launching against the mismatched
cache can fail. Just (re-)run `npx playwright install chromium`; it's a no-op
if versions already match and downloads the right one (~170MB) if not.

Launch once with:
```bash
chrome --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 \
  --headless=new --no-sandbox --use-gl=angle --use-angle=swiftshader \
  --enable-unsafe-swiftshader --ignore-gpu-blocklist
```
`disown` it, then in later scripts `connectOverCDP` to the same port, reusing
`context.pages()[0]`. Calling `browser.close()` on a CDP-*connected* Browser only
disconnects Playwright — it does **not** kill the underlying Chromium — so it's
safe to call at the end of every short script.

**Don't launch with `--use-gl=swiftshader --no-sandbox --disable-gpu`** — that
combination (an earlier, plausible-looking guess) makes WebGL context creation
fail outright (`THREE.WebGLRenderer: A WebGL context could not be created`,
`BindToCurrentSequence failed`), and the app never reaches gameplay. In
particular `--disable-gpu` conflicts with getting a working software-GL
context here — drop it. `--use-angle=swiftshader` + `--enable-unsafe-swiftshader`
is the combination that actually renders.

The app boots straight to duel-game-core's own lobby screen (`#screen` in
`index.html`, driven by `duel/duel-app.js`), which needs a real `backend`
canister to talk to (`icp deploy` locally — see `../CLAUDE.md`). Reaching
gameplay means actually joining a seat against a live canister, in two
tabs/sessions (see `../CLAUDE.md`'s "one round = one step" model) or by
seeding a table directly the way the Motoko test suites do
(`../test/RaceTestHelpers.mo`) if you're testing the rules rather than the
browser.

### The render loop only redraws while the car is moving

The WebGL canvas does **not** re-render on every frame when the car is
stationary (see `ThreeScene`/`renderingService` — rendering is
event/interaction-driven, not a free-running `requestAnimationFrame` loop).
Mutating the Three.js scene graph directly (e.g. via a `window.__THREE_DEVTOOLS__`
hook, see below) and then screenshotting will show a **stale frame** unless you
also trigger an actual game interaction (a trajectory click) afterward to force
a redraw. `window.dispatchEvent(new Event('resize'))` and mouse-move alone do
*not* trigger it.

### Inspecting the live Three.js scene graph without app code changes

Three.js calls `window.__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent('observe', { detail: this }))`
from `Scene`/`Object3D` constructors, and a `'register'` event from
`WebGLRenderer`, *if* that global exists — this is meant for the real Three.js
devtools extension, but you can fake it with `page.addInitScript` before
`page.goto` to capture live object references (Scene, proxy groups, meshes) for
free, e.g. to assert prop counts/positions/scale after a map load. No camera
object is emitted this way (`isPerspectiveCamera` never appears in captured
events) — the app's camera isn't reachable this way, only Scene/Object3D/Renderer.

### Screenshots lag behind fast state changes — don't trust screenshot timing for transient UI states

In this headless/software-rendered (swiftshader) setup, `page.screenshot()`
itself can take 0.5–1.5s to encode. If the state you're trying to catch
(e.g. a UI element visible for only one game step between two fast steps)
changes faster than that, a `waitForFunction(condition)` immediately followed
by `screenshot()` will often capture a **later** state than the one that made
the condition true — the screenshot silently lands after state has already
moved on, with no error. Two screenshots taken this way can even come out
pixel-identical despite genuinely different underlying app state at the
moments they were requested.

Prefer reading state **synchronously** via `page.evaluate()` instead of
inferring it from pixels whenever the thing under test has a queryable value
— e.g. a Three.js material's `.opacity`, or an RxJS `BehaviorSubject.getValue()`
exposed via a temporary debug hook (see below). Reserve screenshots for
genuinely visual-only checks (layout, color, geometry shape), and even then
prefer holding the state steady rather than racing a `waitForFunction` against
one.

### Reaching internal app state for testing: temporary `window` debug hooks

The app doesn't expose its services on `window`. To read or force state
that's impractical to reach through real UI interaction alone (e.g. testing a
crash-penalty state without actually maneuvering the car into the map
boundary), temporarily add a one-liner to the relevant service's constructor
or `init()`:
```ts
(window as any).__gameStateDebug = this; // TEMP-DEBUG-REMOVE
```
then drive it from Playwright via
`page.evaluate(() => window.__gameStateDebug.someSubject.next(...))`.
TypeScript `private` is compile-time only, so even a component/service's
private fields are reachable this way once you have a handle on the instance.
Grep for `TEMP-DEBUG-REMOVE` before finishing and delete every line tagged
with it — these are throwaway and never meant to ship.

## `src/assets/` format and naming conventions

`src/assets/` ships pre-built resources directly (checked into git, no
generation step): each model directory has an `<name>.glb` (the mesh
geometry) plus an `<name>.meta` JSON sidecar with two arrays — `dummies`
(name, position, Euler rotation, and a `properties` map of custom
key/value pairs) for point markers, and `curves` (name + an ordered list
of spline points) for paths/boundaries. `model-loader.service.ts` loads
both; `map-loader.service.ts` matches specific names out of them:
- `map-polygon_outer` / `map-polygon_inner` (curves) — drivable-area
  boundary polygons.
- `player-position_NN` (dummies) — race start positions.
- `road_path` (a curve) — the road centerline.
- `proxy_<id>` (dummies, optionally suffixed `.001`, `.002`, ...) —
  places the proxy model at `assets/proxies/<id>.glb`, positioned/rotated
  to match the dummy and scaled by its `scale` property (default 1) if
  present. This is how hand-placed decorations (trees, buildings, etc.)
  get into a map — don't reintroduce a random runtime scatterer without
  being asked.

Adding a new car, map, or proxy means producing a matching `.glb`/`.meta`
pair through whatever external toolchain and dropping it under
`src/assets/` in this same layout — this repo has no built-in asset
authoring/export pipeline.
