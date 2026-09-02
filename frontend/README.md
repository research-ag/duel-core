# duel-game-core

Rules-agnostic browser client for any canister built on the
[`duel-game-core`](../backend/README.md) Motoko engine. It implements every screen
that's the same for every game — lobby, staging, rematch offer, busy
countdown, debrief chrome, the `#endedByOther` notice — plus session
identity and real-time push, so a new game only has to supply a small
**GamePlugin**: the two Candid types, seat labels, and how to draw the
board and action buttons.

No build step is required — every file is plain ESM, dependency-free
except for what you pass in yourself (see below).

```
npm install duel-game-core
```

(Unpublished: reference it as a local/git path dependency until it ships
to npm.)

## The GamePlugin contract

```js
const plugin = {
  // Candid types for your game's move and state, given the same `{ IDL }`
  // the Candid tooling passes to an idlFactory.
  idlTypes({ IDL }) {
    return {
      Action: IDL.Variant({ /* ... */ }),
      State: IDL.Record({ /* ... */ }),
    };
  },

  // Human label for a seat tag ("p1" | "p2").
  seatLabel(seat) {
    return { p1: "White", p2: "Black" }[seat];
  },

  // Full board markup for one game state, from `mySeat`'s point of view.
  // Called for both the live game and a finished debrief's final state —
  // render whatever makes sense in each case from `gameState` alone.
  renderBoard(gameState, mySeat, oppSeat) {
    return `<pre>${JSON.stringify(gameState, null, 2)}</pre>`;
  },

  // Action buttons for `mySeat`, only ever called while it's legal for
  // them to move (the framework hides this once they've submitted).
  // Each button must carry its move value via the `actionAttr` helper
  // from render.js so the framework's click handling can submit it as-is
  // — this works for any Action shape, not just a bare nullary variant.
  renderActions(gameState, mySeat) {
    return `<button ${actionAttr({ pass: null })}>Pass</button>`;
  },
};
```

Only `renderBoard` and `renderActions` return markup for *your* game;
everything else (turn counter, "opponent is deciding" / "locked in"
messages, verdict banner, rematch/leave/forfeit buttons) is handled by
`render.js`'s generic chrome around them.

## Wiring it up

You build the `actor` — this package doesn't import `@dfinity/agent` or
hardcode a CDN, so you're free to load it however you like (esm.sh, a
bundled dependency, a mock for tests) — and a `ws` over it (see "Real-time
push" below; `start()` requires one, there is no plain-polling mode):

```js
import { Actor, HttpAgent } from "@dfinity/agent"; // however you prefer to load it
import { makeIdlFactory } from "duel-game-core/idl.js";
import { start } from "duel-game-core/app.js";
import { connectWs } from "duel-game-core/ws.js";
import { plugin } from "./my-game-plugin.js";

const idlFactory = makeIdlFactory(plugin.idlTypes);
const agent = await HttpAgent.create({ host });
const actor = Actor.createActor(idlFactory, { agent, canisterId });
const ws = connectWs({ actor });

start({ plugin, ws });
```

`start()` expects a handful of element ids in your page (all optional,
shown here with their defaults):

```html
<span id="sid"></span>
<button id="new-sid">new</button>
<p id="error" hidden></p>
<main id="screen"></main>
<link rel="stylesheet" href="node_modules/duel-game-core/style.css" />
```

- `sid` — filled with the current session id (per-tab identity; a second
  browser tab is automatically the second player).
- `new-sid` — optional button to start a fresh session id.
- `screen` — where `renderView`'s output is written; also where clicks
  are delegated from, so re-rendering never leaks event listeners.
- `error` — where a transient rejection (`errText`) is shown.

Override any of the ids: `start({ plugin, ws, sidElId: "...", ... })`.

## Real-time push

`start()` has exactly one transport: a WebSocket-shaped `ws` is
required. Every action is sent through `ws.send()` and the resulting
view arrives via `ws.onmessage`, for both players:

```js
import { connectWs } from "duel-game-core/ws.js";
import { start } from "duel-game-core/app.js";

const ws = connectWs({ actor });
start({ plugin, ws });
```

There's no Gateway process and no extra canister wiring required —
`connectWs()` returns a small poller (`./ws/poller.js`) that calls the
SAME plain `join`/`submit`/`rematch`/`leave`/`reset`/`ackEnded`/`status`
methods `actor` already has, on a fast interval (default 500ms;
`?wsInterval=<ms>` overrides it), and re-shapes the results into the
`onopen`/`onmessage`/`onclose`/`onerror`/`send(msg)` surface `start()`
expects. It's push-shaped polling, not real server push — an opponent's
move shows up on the next tick, not the instant it resolves, which is an
imperceptible difference for a casual 2-player game and a much simpler
stack (no Docker, no relay process, no signing identity, no second wire
protocol to keep in sync with a plain one — there's only ever one
transport). `start()` itself doesn't know or care which kind of `ws` it
got — bring your own WebSocket-like object (a mock for tests, or a real
one talking to `mo:duel-game-core/Ws` — see that module's own doc header
in `../backend/src/Ws.mo` — if you want actual server push over a real
Gateway instead) and skip `ws.js` entirely if `connectWs()`'s choices
don't fit; `start()` only needs the four handlers and `send(msg)`,
nothing about `ws.js`/`PollingWs` specifically.

**Overlap control and liveness.** The periodic timer never starts a new
query while its own previous one is still pending — a bad connection can
leave a `status()` call hanging far longer than `intervalMs`, and firing
a new one every tick regardless piles up unboundedly (dozens of
forever-pending queries on a frozen tab). And since the IC gives no
server-side heartbeat to lean on, liveness is entirely client-side: any
call that resolves at all (a business `{err}` included — even a
rejection proves the network works) counts as "still connected"; after
`disconnectAfterMs` (default 10s; `?wsDisconnectAfter=<ms>` overrides it)
with no successful round trip at all, the poller closes itself rather
than continuing to retry into a dead connection — `ws.onclose` fires,
same as any other close.

**Sharing one `ws` with a game's own runtime code, not just the generic
chrome.** `PollingWs` extends `EventTarget`, same as a real `WebSocket`,
so more than one part of a page can use the SAME poller instead of each
running an independent one — publish it somewhere your other code can
reach (e.g. on `window`, the way `examples/racing` does) and:

```js
ws.addEventListener("message", (ev) => {
  if ("view" in ev.data) /* ...update your own UI... */;
});
```

`ws.send(msg)` stays fire-and-forget (the plain WebSocket contract
`app.js` relies on) — its result only ever shows up as a `message`/`error`
event, racing against the poller's own periodic tick. If you need a
specific call's own response correlated back to you (e.g. "was MY move
rejected?"), use `ws.request(sid, req)` instead: same dispatch, same
`message` event fired as a side effect, but it also returns a Promise of
that exact call's `{ view } | { err }`, and rejects on a genuine transport
failure. See `examples/racing/frontend/src/app/modules/gameplay/
game-communication/services/lobby-connection.service.ts` for a complete,
working example (its own gameplay loop, not just the chrome, runs over
this one shared poller).

## Optional: `ic-env.js`

If you're deploying to the Internet Computer via an asset canister,
`readIcEnv()` and `deriveHost()` extract the canister id and the right
`HttpAgent` host from the `ic_env` cookie the asset canister sets and
from `window.location`. They're generic IC-hosting helpers, unrelated to
any game's rules — use them when building `agent`/`actor`, or don't;
`start()` never calls them itself.

## Modules

| Module        | Exports                                   |
| ------------- | ------------------------------------------ |
| `idl.js`      | `makeIdlFactory(buildGameTypes)` — also declares 4 `ws_*` methods for the optional `Ws.mo`/Gateway path (unused by `ws.js`; see `../backend/src/Ws.mo`) |
| `render.js`   | `renderView(view, plugin)`, `errText(err)`, `actionAttr(value)`, `tag`, `val`, `esc` |
| `app.js`      | `start({ plugin, ws, ...elIds })`          |
| `ic-env.js`   | `readIcEnv()`, `deriveHost()` (optional)   |
| `ws.js`       | `connectWs({ actor, ...opts })` — see "Real-time push"; `start()` requires its result |
| `ws/poller.js`| `PollingWs`, `connectWs()` — the actual implementation behind `ws.js` |
| `style.css`   | generic layout primitives                  |

See [`../backend/README.md`](../backend/README.md) for the matching
backend `Spec` contract.
