# A rich UI alongside the generic chrome

Read this when your game's whole UI genuinely doesn't fit buttons and
text — a canvas, a 3D scene, drag-and-drop, anything with persistent DOM
state that a plain HTML-string re-render would destroy. If a
`renderBoard`/`renderActions` pair returning markup covers your game
(the common case for anything you'd naturally describe as "pick a move
each round"), you don't need this file.

## The one fact that makes or breaks this

`app.js` does `screenEl.innerHTML = renderStatus(...)` on **every message
`ws` delivers** (its poller ticks every 500ms by default, plus
immediately after every action), unconditionally, for as long as the
game is running. Anything with real persistent state — a mounted
framework app, a `<canvas>` with an active WebGL context and event
listeners, anything that isn't a plain string — placed inside `#screen`
gets destroyed and reparsed from scratch every single tick. There is no
way to make `renderBoard`'s return value "skip" this; it's a dumb
unconditional replace, by design (the npm package's `render.js` is meant
to stay a pure `Status -> HTML string` renderer).

## The pattern that works

1. Run the npm package's `start({ plugin, ws })` completely unmodified,
   in its own small bootstrap script, for the chrome (the multi-table
   lobby/staging/rematch/debrief) exactly as the generic-chrome path
   does.
2. Give your real UI its OWN persistent DOM region, a **sibling** of
   `#screen`, never a descendant. Your own bootstrap script (or
   framework of choice) owns that.
3. **Share the SAME `ws` (and actor, and session id) between the two
   halves** — do NOT build a second, independent connection for your
   rich UI. `GatewayWs` extends `EventTarget` specifically so more than
   one consumer can listen (`ws.addEventListener("message", ...)`)
   without stealing the generic chrome's own `ws.onmessage`; a second
   independent connection racing the first one's own fetches with no
   ordering guarantee between them is a real bug, not just wasted
   queries — two unordered views of the same game state can arrive out
   of sequence and visibly show your rich UI's state briefly at a stale
   position before the correct one lands. Publish all three via
   `Promise`s set up **synchronously in an inline (non-module)
   `<script>`** in `<head>`, before either deferred `type="module"`
   script runs:
   ```html
   <script>
     window.duelActorReady = new Promise(r => { window.__resolveDuelActor = r; });
     window.duelWsReady = new Promise(r => { window.__resolveDuelWs = r; });
   </script>
   ```
   This makes load order between the two scripts irrelevant — whichever
   awaits `window.duelActorReady`/`duelWsReady` just waits for the other
   to resolve them. Session id: read the same `sessionStorage` key
   `app.js` already writes (currently `"sid"` — check the installed
   `app.js` for the exact key, don't hardcode a guess into two places).
   If your rich UI needs to submit its own moves (not just render
   state), use the shared `ws`'s `request(sid, req)` — not `send()` — so
   you get THIS call's own correlated `{ view } | { err }` back instead
   of whatever the shared poller's next tick happens to deliver.
4. `renderBoard`/`renderActions` can be near-stubs (return a short
   status note, or even `''`) once the real UI lives elsewhere — the
   turn counter, "opponent is deciding"/"locked in", and verdict banner
   around them are still real and correct (driven by the engine's own
   `youSubmitted`/`oppSubmitted`/`turn`, not by your plugin), so this
   still functions as a lightweight, always-accurate status HUD even
   though your rich UI never provides it any data.
5. To reach a verdict, your rich UI should NOT rely on `renderBoard`
   telling it the round advanced — listen to the shared `ws`'s own
   `message` event (step 3) and detect the round boundary yourself
   (e.g. compare a monotonic round/step counter in `State` between
   consecutive views) and drive your own game loop off that.

See
[`examples/racing`](https://github.com/research-ag/duel-core/tree/main/examples/racing)
in the framework's own repo for a complete worked example (a Three.js
scene, its own gameplay loop, sharing one `ws` connection with the
generic chrome) and its
[`frontend/CLAUDE.md`](https://github.com/research-ag/duel-core/blob/main/examples/racing/frontend/CLAUDE.md)
for the concrete code, including
[`lobby-connection.service.ts`](https://github.com/research-ag/duel-core/blob/main/examples/racing/frontend/src/app/modules/gameplay/game-communication/services/lobby-connection.service.ts)'s
`emitNextStep()` for a full `request()` example.

## Adapting an existing (e.g. third-party, framework-based) client

Don't assume the framework has to go. Angular/React/etc. usually only
touch three things in a client like this: dependency injection, routing,
and top-level page composition — and the generic chrome already replaces
routing and page composition (there's only ever one "page": your game).
What's usually left after removing those is a pile of plain classes with
constructor-injected dependencies, which is *already* framework-agnostic
logic wearing a framework's decorators. Concretely, for an Angular app:

- `@Injectable()`/`@Component()`/`@NgModule()` decorators, and their
  `@angular/core`/`@angular/router` imports, can usually be deleted
  outright — most services underneath are plain classes.
- Angular's DI container becomes one hand-written entry file that
  constructs every service with `new X(...)` in dependency order (read
  each constructor's parameter list to get the order right — do this
  file last, once every service is already decorator-free, so you can
  see the real dependency graph in each constructor signature).
  Components with actual page composition (routing, multi-screen
  orchestration) usually get deleted, not converted — that's exactly
  the layer the generic chrome subsumes.
- `HttpClient` → `fetch`; `ElementRef`/`Renderer2` → plain
  `document.createElement`/`appendChild`; `MatDialog`/routing-triggered
  modals → usually just delete (there's nowhere left to navigate to).
- RxJS itself (`BehaviorSubject`, operators) is NOT Angular-specific —
  it's a plain library. Reactive state built on it can be kept verbatim;
  only the `@Injectable` wiring around it needs to go.
- A minimal bundler (esbuild is enough for e.g. a Three.js game — one
  `build.js` calling `esbuild.build({ entryPoints, bundle, outfile })`
  plus a few `cpSync` calls for static files) replaces a framework CLI's
  build step. Keep `tsc --noEmit` as a separate typecheck — esbuild only
  transpiles, it does not type-check, so a broken build can still bundle
  "successfully."
- Work through the compiler, not by inspection: strip decorators file by
  file (a small script doing the mechanical `@Injectable()`/import-line
  removal across the whole tree is fine — grep afterward for anything it
  couldn't have caught, like Angular-specific member usage inside a
  method body), then let `tsc --noEmit` and the bundler's own resolution
  errors find what's left. Fix in that order; don't try to trace the
  whole dependency graph by hand up front.
