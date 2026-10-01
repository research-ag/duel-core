# A rich UI: your own screens over the headless client

Read this when the game's UI genuinely doesn't fit buttons and text — a
canvas, a 3D scene, drag-and-drop, a framework app, a lobby of its own
design. If `renderBoard`/`renderActions` returning markup covers your
game, skip this file; if only one or two screens need the game's own
voice, `start({ screens })` (SKILL.md, Step 6) is enough.

## The split that makes this easy

`duel-game-core/client.js` is everything the browser side does except
drawing: `createDuelClient({ ws, session })` owns the connection, the
current `Status`, the one call in flight, error lifetime, the identity
lock, and the stale-view resync, and hands subscribers an immutable
`ClientState` after every change. `duel-game-core/app.js`'s `start()` is
one UI over it. Yours is another; nothing in `start()` is needed.

```js
import {
  createDuelClient,
  viewOf,
  localSecondsLeft,
} from "duel-game-core/client.js";

const client = createDuelClient({ ws, session });
client.subscribe((state, prev) => {
  if (state.status !== prev.status) drawScreen(state);
  toolbar.disabled = state.pending !== null;
  alertBar.hidden = state.error === null;
  alertBar.textContent = state.error ?? "";
});
```

Every screen is a function of `state.status` (`null` before the first
push, `{ browsing }`, or `{ atTable: { id, view } }` with `view` one of
`lobby`/`busy`/`stagingYou`/`awaitingRematch`/`inGame`/`debrief`/
`endedByOther` — the shapes are in `types.js`). Every control calls one
client method: `createTable(seat, visibility?, variant?)`,
`joinTable(id, seat, code?)`, `submit(move)`, `rematch()`, `leave()`,
`reset()`, `claimWin()`, `ackEnded()`. Each resolves with `{ ok: true,
view }` or `{ ok: false, reason }` (`inFlight`, `closed`, `stale`,
`rejected`, `failed`); rejections are already in `state.error`, so a UI
only has to show that field.

What to bind, and where the default shell's equivalent lives, so nothing
is forgotten:

| Concern                                                  | Source of truth                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| which screen                                             | `state.status`                                                                            |
| a call in flight (disable, spin)                         | `state.pending` (`key` names the control: `create:p1`, `act:{"pass":null}`, `rematch`, …) |
| your move, before the reply                              | `withLocalMove(state.status, state.pending, plugin.applyLocal)` (below)                   |
| errors, and the terminal disconnect                      | `state.error`, `state.connection === "closed"`                                            |
| "new sid" / login / logout enabled                       | `!state.identityLocked`; call `client.regenerateSid()`/`login()`/`logout()`               |
| countdowns between pushes                                | `localSecondsLeft(view.secondsUntilX, state.statusAt)` on a local 1 s timer               |
| who may claim                                            | `claimRoleOf(inGame)`: `"waiting"` may, `"atRisk"` is the mirror                          |
| submit's `gen`/`turn`                                    | stamped by the client; never send them yourself                                           |
| a stale view (`#wrongPhase` on join, `#stale` on a move) | handled: the client refreshes silently, `reason: "stale"`                                 |

## Your move at once, the opponent's move marked

The default shell draws a submitted move before the engine confirms it;
a UI of your own does the same with one pure helper:

```js
import { withLocalMove } from "duel-game-core/client.js";

const shown = (state) =>
  withLocalMove(state.status, state.pending, plugin.applyLocal.bind(plugin));

client.subscribe((state, prev) => {
  if (state.status !== prev.status || state.pending !== prev.pending) {
    drawScreen(shown(state));
  }
});
```

While a `submit` is out, `shown(state)` is the in-game view with
`applyLocal`'s board and the seat already waiting; otherwise it is
`state.status` itself. The reply clears `pending` and lands its status in
the same snapshot, and a rejection leaves `status` as it was, so either
way the next draw is the real view with no flash in between. Feed the
same shown status to anything that diffs consecutive views (a move log,
an opponent-move replay): it then sees your ply and the opponent's as
two steps even when the server sends both in one push.

The opponent's last move stays visible on every screen that shows the
board, the debrief included; the move that ended the game is the one
the player most wants to see. Mark it, or replay it as an animation and
then mark it.

## Drawing the board

The plugin still draws the board: `plugin.renderBoard(view.game, mySeat,
oppSeat, yourTurn)` and `plugin.renderActions(view.game, mySeat)` return
HTML you place wherever you like; a click on a `data-act` button becomes
`client.submit(JSON.parse(btn.dataset.act))`. A canvas or 3D board reads
`view.game` directly instead.

`examples/007/frontend/src/mission-ui.js` in the framework repo is the
worked example: ~300 lines covering every screen, the header, the alert
bar, two native `<dialog>`s, and clock patching, over `client.js` and
`esc` alone, with its own stylesheet.
`examples/chopsticks/frontend/src/chopsticks-ui.js` is the second, and
the one to read when porting an existing app's design (there, a React/
Tailwind app) onto the engine: a bot flow that turns `list_bots()`
complexities into pickable characters and calls the bot's `play` after
`client.createTable(...)` resolves, modal dialogs rendered from local
state alongside the screen, an opponent-move replay that keeps drawing
the previous `view.game` while animating the move inferred by diffing it
against the new one (`turn` advanced by one ply; the mover is the seat
on turn), and a move-history sidebar built from the same diffs, both
over `withLocalMove`. A
design that needs the last move should carry it in `State` when it can
change the backend; the diff is the fallback when it cannot.

## Persistent DOM alongside the default shell

The middle road: keep `start()` for the chrome and give a canvas or
framework component its own region. `start()` replaces
`screenEl.innerHTML` on every status that differs from the last, so
anything with real state placed inside `#screen` — a mounted framework
app, a `<canvas>` with a WebGL context — is destroyed and reparsed.

1. Run `const client = start({ plugin, ws, session })` for the chrome.
2. Give your UI its own persistent DOM region, a **sibling** of `#screen`.
3. Drive it from `client.subscribe(...)`. Never open a second connection
   (two pollers can deliver views out of order); `client.submit(move)` is
   the one way to move, and its `gen`/`turn` stamping and the chrome's
   spinner come for free.
4. `renderBoard`/`renderActions` can be near-stubs. The turn counter,
   "opponent is deciding"/"locked in", verdict banner, and claim-win
   warnings around them stay correct, since they are driven by the
   engine's own view fields.
5. Detect round boundaries from `state.status` changes (a monotonic
   counter in `State`), not from `renderBoard` being called.

`examples/racing` in the framework repo is the worked example (a Three.js
scene beside the chrome, sharing one `ws`); its `frontend/CLAUDE.md` and
`lobby-connection.service.ts` show the shared-connection pattern.

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
