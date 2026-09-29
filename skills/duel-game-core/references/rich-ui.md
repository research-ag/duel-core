# A rich UI alongside the generic chrome

Read this when the game's UI genuinely doesn't fit buttons and text — a
canvas, a 3D scene, drag-and-drop, anything with persistent DOM state. If
`renderBoard`/`renderActions` returning markup covers your game, skip
this file.

## The one fact that makes or breaks this

`app.js` replaces `screenEl.innerHTML` with `renderStatus(...)` on every
status the `ws` delivers that differs from the last one. Anything with
real state placed inside `#screen` — a mounted framework app, a `<canvas>`
with a WebGL context — is destroyed and reparsed. `render.js` is a pure
`Status -> HTML string` renderer by design; there is no opt-out.

## The pattern that works

1. Run `start({ plugin, ws, session })` unmodified for the chrome.
2. Give your UI its own persistent DOM region, a **sibling** of `#screen`.
3. **Share the same `ws`, actor, and session** — never open a second
   connection (two pollers can deliver views out of order, showing a
   stale position before the fresh one). `GatewayWs` extends
   `EventTarget`, so `ws.addEventListener("message", ...)` coexists with
   the chrome's own `ws.onmessage`. Publish the shared objects via
   Promises created synchronously in an inline `<script>` in `<head>`,
   before either module script runs:
   ```html
   <script>
     window.duelActorReady = new Promise((r) => {
       window.__resolveDuelActor = r;
     });
     window.duelWsReady = new Promise((r) => {
       window.__resolveDuelWs = r;
     });
   </script>
   ```
   Read the session id from the `sessionStorage` key `app.js` writes
   (`"sid"`). To submit moves from your UI, use `ws.request(sid, req)`,
   which resolves with that call's own `{ view } | { err }`.
4. `renderBoard`/`renderActions` can be near-stubs. The turn counter,
   "opponent is deciding"/"locked in", verdict banner, and claim-win
   warnings around them stay correct, since they are driven by the
   engine's own view fields.
5. Detect round boundaries from the shared `ws`'s `message` events (a
   monotonic counter in `State`), not from `renderBoard` being called.

`examples/racing` in the framework repo is the worked example (a Three.js
scene sharing one `ws` with the chrome); its `frontend/CLAUDE.md` and
`lobby-connection.service.ts`'s `emitNextStep()` show a full `request()`
use.

## Adapting an existing framework-based client

The framework usually only supplies dependency injection, routing, and
page composition — and the generic chrome already replaces the last two.
For an Angular app:

- Delete `@Injectable()`/`@Component()`/`@NgModule()` decorators and
  `@angular/*` imports; most services are plain classes underneath.
- Replace the DI container with one entry file constructing every service
  with `new X(...)` in dependency order (do this last, once the
  constructors' parameter lists show the real graph). Components that only
  compose pages get deleted, not converted.
- `HttpClient` → `fetch`; `ElementRef`/`Renderer2` → `document.createElement`;
  routing-triggered modals → delete.
- RxJS is not Angular-specific; keep it.
- esbuild (one `build.js` with `esbuild.build({ entryPoints, bundle,
outfile })` plus `cpSync` for static files) replaces the framework CLI.
  Keep `tsc --noEmit` as the type check — esbuild doesn't type-check.
- Work through the compiler: strip decorators mechanically, then let
  `tsc --noEmit` and the bundler find what's left.
