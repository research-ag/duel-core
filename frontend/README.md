# duel-game-core

Rules-agnostic browser client for any canister built on the
[`duel-game-core`](../backend/README.md) Motoko engine. It implements every screen
that's the same for every game — lobby, staging, rematch offer, busy
countdown, debrief chrome, the `#endedByOther` notice — plus session
identity and real-time push, so a new game only has to supply a small
**GamePlugin**: the two Candid types, seat labels, and how to draw the
board and action buttons.

Written in TypeScript, published pre-compiled: `npm install` in this
package builds `dist/` (`npm run build`, plain `tsc`) and everything a
consumer imports — `duel-game-core/app.js` etc. — resolves there, with
`.d.ts` types alongside. No build step is required of the CONSUMER: the
files you get from `node_modules/duel-game-core` are plain, already-
compiled ESM `.js`, dependency-free except for what you pass in yourself
and the narrow, documented `ws/gateway-*.js` exception (see below).

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

You build the `actor` — this package doesn't import `@icp-sdk/core/agent`
(the successor to the deprecated `@dfinity/agent`) or hardcode a CDN, so
you're free to load it however you like (esm.sh, a bundled dependency, a
mock for tests) — and a `ws` over it (see "Real-time push" below;
`start()` requires one, there is no plain-polling mode):

```js
import { Actor, HttpAgent } from "@icp-sdk/core/agent"; // however you prefer to load it
import { makeIdlFactory } from "duel-game-core/idl.js";
import { start } from "duel-game-core/app.js";
import { connectWs } from "duel-game-core/ws.js";
import { plugin } from "./my-game-plugin.js";

const idlFactory = makeIdlFactory(plugin.idlTypes);
const agent = await HttpAgent.create({ host });
const actor = Actor.createActor(idlFactory, { agent, canisterId });
const principal = await agent.getPrincipal();
const ws = connectWs({ actor, principal, gameIdlTypes: plugin.idlTypes });

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

const principal = await agent.getPrincipal();
const ws = connectWs({ actor, principal, gameIdlTypes: plugin.idlTypes });
start({ plugin, ws });
```

**`principal` must not be the anonymous principal — and should be a
FRESH one every page load, not stable across a reload.** `agent`'s
identity doesn't need to mean anything — the engine's own identity is
the client-chosen `sid`, decoupled from any IC principal on purpose (see
`../backend/src/Ws.mo`'s doc header) — but `ic-websocket-cdk`'s
`ws_open` hard-rejects an anonymous caller outright ("Anonymous
principal is not allowed"), so a game with no login step (the common
case — see both `examples/`) must not build `agent` with
`HttpAgent.create({ host })` and nothing else, since that defaults to
the anonymous identity: the WS handshake, and with it the whole app
(there is no polling fallback by default), never comes up. See
`examples/racing/frontend/src/duel/duel-app.js` for the worked example
(`Ed25519KeyIdentity.generate()`, no seed).

Resist the temptation to derive that identity's seed from `sid` so it
stays the same across a plain reload (a previous version of this
worked example did exactly that) — it actively causes `ws_message:
Client with principal ... doesn't have an open connection` and
"Connection closed — reload to reconnect.": `ic-websocket-cdk@0.4.1`'s
own `remove_client` (in its `State.mo`) deletes its
principal->client_key lookup by PRINCIPAL ALONE, not scoped to the exact
client_key being removed. A plain reload gives the OLD page's own
`ws_close()` no guarantee of completing before the tab is torn down, so
if that stale close (or its eventual keep-alive-timeout eviction) lands
AFTER the NEW page has re-registered under the SAME principal, it
silently erases the new, perfectly-live connection's own lookup entry.
A fresh random principal every load means no two registrations ever
share a principal, so this collision can't happen at all — and nothing
player-visible is lost, since `sid` (the engine's actual player
identity) already persists across reload on its own, completely
independent of this principal.

`connectWs()` builds a `GatewayWs` (`./ws/gateway-client.js`) that
speaks `mo:duel-game-core/Ws`'s real `ic-websocket-cdk` protocol
directly against `actor` — genuine canister-driven push, not client-side
polling wearing a push-shaped interface. There is still no separate
Gateway *process* to run: `ic-websocket-cdk` doesn't require a
pre-registered Gateway principal — its `ws_open` lets a caller register
**itself** as its own Gateway — so this tab calls
`ws_open`/`ws_get_messages`/`ws_message`/`ws_close` on the canister
directly, polling itself the way a real Gateway would poll on a client's
behalf (see `./ws/gateway-transport.js`'s own header for the full
story). This is also what makes an opponent's disappearance a genuine
server-side signal instead of a guess: the CDK's own canister-side timer
(periodic ack → wait for a keep-alive reply → evict) calls `on_close` on
its own if a connection goes quiet, independent of any explicit goodbye
— see `../backend/src/Ws.mo`'s doc header for what the backend does with
that (ends/frees the affected game) and the resulting detection floor
(that timeout is fixed at 60s inside the CDK, not configurable — expect
roughly 60-120s for an involuntary disappearance to be noticed, not
instant; a cooperative one, e.g. the tab closing normally, is much
faster since `GatewayWs` proactively calls `ws_close` itself on
`pagehide`/backgrounding).

**Dependencies and the trade-off that buys.** This is the one place in
this package that pulls in real npm dependencies — `@icp-sdk/core/candid`
(Candid encode/decode of the message content blob; the maintained
successor to the deprecated `@dfinity/candid`) and `cborg`
(CBOR-decoding `ws_get_messages`' envelope) — confined to
`./ws/gateway-*.js`, the same narrow, documented exception
`ic-websocket-cdk` gets on the backend (see the root `CLAUDE.md`'s rule
10). `GatewayWs` also deliberately skips verifying the `cert`/`tree`
fields `ws_get_messages` returns: the CDK certifies its queue so a
client can trust a *Gateway's* relay without trusting the Gateway
itself, but since our "gateway" here is the player's own tab (already
as trusted as the plain `status()` query already implicitly is), that
property buys nothing and would cost a real BLS-verification dependency
to check — a documented trade-off, not an oversight.

**There is no plain-polling fallback.** A canister built on this
framework has no `join`/`submit`/`rematch`/`leave`/`reset`/`ackEnded`
Candid method to poll in the first place — the ONLY way to mutate game
state is `mo:duel-game-core/Ws`'s `ws_message` (see
`../backend/src/Ws.mo`'s doc header for why: a direct update call is
exactly the race a single, ordered WS channel exists to close). Every
canister built on this package MUST wire `Ws.mo`. `start()` itself
doesn't know or care which kind of `ws` it got — bring your own
WebSocket-like object entirely (a genuine mock for tests, or a
hand-rolled one talking to a real EXTERNAL Gateway relay instead of
`GatewayWs`'s self-registered one) if `connectWs()`'s `GatewayWs` doesn't
fit; `start()` only needs the four handlers and `send(msg)`, nothing
about `ws.js`/`GatewayWs` specifically.

**Overlap control and reconnection.** `GatewayWs` never starts a new
poll while its own previous one is still pending, and drains a backlog
faster than its usual interval when the canister reports more is
waiting (`is_end_of_queue`). If the canister's transient WS state gets
wiped — an upgrade, see `Host.mo`'s own comment on that — the very next
poll OR send failure (an ack-reply, `send()`, or `request()` — see
`_invalidateAndRetry()`) is treated as presumptively that: `GatewayWs`
transparently redoes the `ws_open` handshake and resumes, with no
`onclose` firing for what the caller never has to notice happened. This
is defense in depth, not the primary fix, for the SAME
`ic-websocket-cdk@0.4.1` cleanup bug the "Real-time push" section above
warns against causing in the first place (a stale close erasing a live
registration's principal->client_key lookup, keyed by principal alone):
the actual fix is not reusing one principal across a reload to begin
with (see above); `_invalidateAndRetry()` just means that if this ever
happens anyway — some OTHER same-principal-reuse scenario, or a
genuinely wiped upgrade — recovery takes about one poll interval instead
of up to the 60-120s it'd otherwise take for the canister's own
keep-alive timeout to notice and evict.

**`send()`/`request()` are safe to call before the connection has
opened.** Both await the same handshake `GatewayWs`'s own poll loop
uses (coalesced onto one in-flight `ws_open`, never two racing opens)
before building the outgoing message — so a caller doesn't have to wait
for `onopen`/an `open` event first. This matters for any game-specific
code sharing the connection (see below) that fires its own request the
instant it gets hold of `ws`, e.g. `examples/racing`'s
`lobby-connection.service.ts` sending an immediate `status` right after
`getDuelWs()` resolves: without this coalescing, calling `request()`
before the very first tick's own `ws_open` has completed would build the
message with a `null` `client_key` (not yet assigned), which the
canister's own Candid decoder rejects with an opaque "Invalid record ...
Cannot read properties of null" — a real failure mode this guards
against, not a hypothetical one.

**Every outgoing `ws_message` is serialized, never sent concurrently.**
`ic-websocket-cdk` tracks a strict per-connection expected sequence
number and evicts the client outright (`WrongSequenceNumber` — surfaces
here as `onclose`/"Connection closed — reload to reconnect") the instant
a message arrives out of order — and two independent `ws_message` update
calls, once both are actually in flight, have no guaranteed relative
processing order on the IC, regardless of which was dispatched first.
The periodic keep-alive ack-reply (driven by the poll loop) and a
user-triggered `send()`/`request()` are two such independent sources
that can otherwise both have a call in flight at once — a real,
load-dependent race (the more actively a game is played, the more often
it fires), not a hypothetical one. `GatewayWs` chains every send behind
the one before it (`_serialSend()`) so the next is only ever dispatched
once the previous has fully completed — real added per-message latency,
but what a strict sequence protocol requires.

**Sharing one `ws` with a game's own runtime code, not just the generic
chrome.** `GatewayWs` extends `EventTarget`, same as a real `WebSocket`,
so more than one part of a page can use the
SAME connection instead of each running an independent one — publish it
somewhere your other code can reach (e.g. on `window`, the way
`examples/racing` does) and:

```js
ws.addEventListener("message", (ev) => {
  if ("view" in ev.data) /* ...update your own UI... */;
});
```

`ws.send(msg)` stays fire-and-forget (the plain WebSocket contract
`app.js` relies on) — its result only ever shows up as a `message`/`error`
event. If you need a specific call's own response correlated back to
you (e.g. "was MY move rejected?"), use `ws.request(sid, req)` instead:
same dispatch, same `message` event fired as a side effect, but it also
returns a Promise of that exact call's `{ view } | { err }`, and rejects
on a genuine transport failure. See `examples/racing/frontend/src/app/
modules/gameplay/game-communication/services/lobby-connection.service.ts`
for a complete, working example (its own gameplay loop, not just the
chrome, runs over this one shared connection).

**Any number of `request()`s can be genuinely in flight at once, from
any code sharing this `ws`.** This connection's incoming stream isn't
only replies to its own calls — `Ws.mo`'s `pushRelevant` pushes a fresh
view to BOTH seats of a match on almost every mutation, so this same
connection routinely gets an unsolicited push whenever the OTHER seat
acts, indistinguishable on the wire from a genuine reply unless
something says otherwise. `GatewayWs` mints a fresh `reqId` per
`request()` call and `Ws.mo` echoes it back verbatim on that request's
own `#view`/`#err` (`null` on a push to the non-acting seat — see
`../backend/README.md`'s "The wire protocol" section); `_handle()`
matches replies to their own pending `request()` by that id, rather than
assuming "the next incoming message" belongs to "the oldest
still-pending `request()`" — a FIFO scheme like that would require every
caller sharing this `ws` to serialize their own calls to stay correct,
and a real bug an opponent's own broadcast could trigger under it: it
could steal the slot meant for this connection's own reply, silently
hanging that `request()` forever (the real reply arrives to an
already-empty queue) while resolving the wrong caller with someone
else's payload. Matching by id needs no such serialization —
`app.js`'s own `refresh()`-on-`onopen` (a `send()`, so it carries no
`reqId` and is never itself waited on) and something like
`lobby-connection.service.ts`'s own concurrent `request()` calls can
freely overlap.

## Optional: `ic-env.js`

If you're deploying to the Internet Computer via an asset canister,
`readIcEnv()` and `deriveHost()` extract the canister id and the right
`HttpAgent` host from the `ic_env` cookie the asset canister sets and
from `window.location`. They're generic IC-hosting helpers, unrelated to
any game's rules — use them when building `agent`/`actor`, or don't;
`start()` never calls them itself.

## Modules

| Module                   | Exports                                   |
| ------------------------ | ------------------------------------------ |
| `idl.js`                 | `makeIdlFactory(buildGameTypes)`, `buildEngineTypes({IDL, Action, State})` — `status`'s own type plus the `Ws.mo`/CDK protocol types both `makeIdlFactory` and `ws/gateway-protocol.js` build on |
| `render.js`              | `renderView(view, plugin)`, `errText(err)`, `actionAttr(value)`, `tag`, `val`, `esc` |
| `app.js`                 | `start({ plugin, ws, ...elIds })`          |
| `ic-env.js`              | `readIcEnv()`, `deriveHost()` (optional)   |
| `ws.js`                  | `connectWs({ actor, principal, gameIdlTypes, ...opts })` — see "Real-time push"; `start()` requires its result |
| `ws/gateway-client.js`   | `GatewayWs` — the public class `ws.js`'s `connectWs()` builds |
| `ws/gateway-transport.js`| `SelfGatewayTransport` — moves bytes (the embedded-Gateway registration/poll/send/close calls); swap this for a real-external-Gateway transport without touching the other two `ws/gateway-*.js` files |
| `ws/gateway-protocol.js` | `GatewayProtocol` — Candid encode/decode, sequence bookkeeping, and interpreting a decoded envelope; transport-agnostic |
| `style.css`              | generic layout primitives                  |

See [`../backend/README.md`](../backend/README.md) for the matching
backend `Spec` contract.
