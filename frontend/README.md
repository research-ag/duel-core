# duel-game-core

Rules-agnostic browser client for any canister built on the
[`duel-game-core`](../backend/README.md) Motoko engine. It implements every screen
that's the same for every game — the multi-table lobby (create a table,
browse open ones, join by code), staging, rematch offer, busy countdown,
debrief chrome, the `#endedByOther` notice — plus session identity and
real-time push, so a new game only has to supply a small **GamePlugin**:
the two Candid types, seat labels, and how to draw the board and action
buttons.

Written in TypeScript, published pre-compiled: `npm install` in this
package builds `dist/` (`npm run build`, plain `tsc`) and everything a
consumer imports — `duel-game-core/app.js` etc. — resolves there, with
`.d.ts` types alongside. No build step is required of the CONSUMER: the
files you get from `node_modules/duel-game-core` are plain, already-
compiled ESM `.js`, dependency-free except for what you pass in yourself
and three narrow, documented exceptions: `ws/gateway-*.js` (see
"Real-time push"), `anon-identity.js`, and `identity.js` (see "Logging in
with Internet Identity") — `identity.js` re-exports `anon-identity.js`'s
lighter surface, so importing only the latter pulls in just
`@icp-sdk/core/identity`, not `@icp-sdk/auth` too.

```
npm install duel-game-core --legacy-peer-deps
```

(Unpublished: reference it as a local/git path dependency until it ships
to npm.) `--legacy-peer-deps` is needed because `@icp-sdk/auth`
(`identity.js`'s own dependency) currently declares a peer dependency on
`@icp-sdk/core@^5`, one major behind the `@icp-sdk/core@^6.1.0` this
package and its consumers actually use — the small surface `identity.ts`
touches is stable across that skew, but plain `npm install` still refuses
to resolve the conflicting ranges without the flag.

## The GamePlugin contract

```js
const plugin = {
  // Candid types for your game's move and state, given the same `{ IDL }`
  // the Candid tooling passes to an idlFactory.
  idlTypes({ IDL }) {
    return {
      Action: IDL.Variant({/* ... */}),
      State: IDL.Record({/* ... */}),
    };
  },

  // Human label for a seat tag ("p1" | "p2").
  seatLabel(seat) {
    return { p1: "White", p2: "Black" }[seat];
  },

  // Full board markup for one game state, from `mySeat`'s point of view.
  // Called for both the live game and a finished debrief's final state —
  // render whatever makes sense in each case from `gameState` alone.
  // `yourTurn` (true/false during a live game, undefined for a debrief)
  // is only there for a game that puts its own interaction directly on
  // the board — a plugin that keeps `renderActions`' own separate panel
  // can ignore it entirely, same as this one does.
  renderBoard(gameState, mySeat, oppSeat, yourTurn) {
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

  // Optional. Renders one leaderboard entry's raw `score` (a `bigint`,
  // via `get_leaderboard()` — see "Leaderboard" below) for display.
  // Omit it entirely if your score already IS the number to show, e.g.
  // an ELO rating — that's the default `renderLeaderboard` falls back to.
  // Supply it when your backend stores a CONVERTED score instead (a
  // best-lap-time game storing `3,600,000 - lapMs` so higher still means
  // better — see `../backend/README.md`'s "Leaderboard" section) and
  // invert that conversion here, so the panel shows a real time instead
  // of the padded number the board actually sorts on.
  formatScore(score) {
    return score.toString();
  },

  // Optional pair, present only for a game with more than one rules
  // variant of its own (see `../backend/README.md`'s "Table variants"
  // section). `variantChoices()`'s FIRST entry is the default selection;
  // its `key`s are exactly what a table creator's pick sends as
  // `WsRequest.createTable.variant` and, on the backend, what
  // `Spec.init(variant)` receives. `formatVariant` turns a stored
  // `TableSummary.variant` back into display text for a browsing
  // visitor. A game with no modes implements neither — `renderBrowsing`
  // then shows no picker, and no table row shows variant text either.
  variantChoices() {
    return [
      { key: "classic", label: "Classic" },
      { key: "well", label: "Well" },
    ];
  },
  formatVariant(variant) {
    return { classic: "Classic", well: "Well" }[variant] ?? variant;
  },
};
```

Only `renderBoard` and `renderActions` return markup for _your_ game;
everything else (turn counter, "opponent is deciding" / "locked in"
messages, verdict banner, rematch/leave/forfeit buttons) is handled by
`render.js`'s generic chrome around them — including for a backend game
built in the engine's `#alternating` (strictly turn-based) mode instead
of the default `#simultaneous` one: `render.js` reads `InGameView.mode`
and adjusts that same chrome's wording ("Your turn"/"Opponent's turn"
instead of "locked in"/"deciding") automatically, with no `GamePlugin`
changes required either way — `renderActions` is still only ever called
while it's legal for `mySeat` to move, in both modes.

## Wiring it up

You build the `actor` — this package doesn't import `@icp-sdk/core/agent`
or hardcode a CDN, so you're free to load it however you like (esm.sh, a
bundled dependency, a mock for tests) — a `session` (see "Logging in with
Internet Identity" below; `start()` requires one, and its own `identity`
is what the `actor`'s `agent` must be built with — see that section for
why), and a `ws` over the same identity (see "Real-time push" below;
`start()` requires one, there is no plain-polling mode):

```js
import { Actor, HttpAgent } from "@icp-sdk/core/agent"; // however you prefer to load it
import { makeIdlFactory } from "duel-game-core/idl.js";
import { start } from "duel-game-core/app.js";
import { connectWs } from "duel-game-core/ws.js";
import { resolveIdentity } from "duel-game-core/identity.js"; // or anon-identity.js
import { plugin } from "./my-game-plugin.js";

const idlFactory = makeIdlFactory(plugin.idlTypes);
const session = await resolveIdentity();
const agent = await HttpAgent.create({ host, identity: session.identity });
const actor = Actor.createActor(idlFactory, { agent, canisterId });
const ws = connectWs({
  actor,
  principal: session.principal,
  gameIdlTypes: plugin.idlTypes,
});

start({ plugin, ws, session });
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
  browser tab is automatically the second player). A real, non-spoofable
  id by construction (see "Logging in with Internet Identity" below) —
  `start()` no longer generates one of its own.
- `new-sid` — optional button that discards this tab's persisted
  anonymous keypair for a fresh one and reloads the page (see
  `session.regenerate()`'s own doc) — hidden entirely for a session that
  doesn't support it (a real Internet Identity login, or a bare
  `resolveAnonymousIdentity()` result a game wired up without a
  `regenerate` hook of its own). Disabled automatically while the current
  sid still holds a seat (`stagingYou`/`inGame`/`debrief`) — swapping
  identities there would abandon that seat instead of freeing it, leaving
  it stuck until idle takeover reclaims it.
- `screen` — where `renderStatus`'s output is written (the multi-table
  lobby or a specific table's own screen, depending on the current
  status); also where clicks are delegated from, so re-rendering never
  leaks event listeners.
- `error` — where a transient rejection (`errText`) is shown, auto-hiding
  after 5s. `ws.onclose` uses this same element differently: a closed
  transport is terminal, not transient (this `GatewayWs` instance never
  revives itself — see "Real-time push" below), so that banner stays up
  for good with its own "Reload to reconnect" button instead of fading
  out, and every button on the page (including `new-sid`) is disabled at
  the same time — a live-looking board a dead connection can no longer
  update is exactly the bug this replaced (007 defect report, finding 04).

Override any of the ids: `start({ plugin, ws, sidElId: "...", ... })`.

## Real-time push

`start()` has exactly one transport: a WebSocket-shaped `ws` is
required. Every action is sent through `ws.send()` and the resulting
view arrives via `ws.onmessage`, for both players:

```js
import { connectWs } from "duel-game-core/ws.js";
import { start } from "duel-game-core/app.js";
import { resolveIdentity } from "duel-game-core/identity.js"; // or anon-identity.js

const session = await resolveIdentity();
const agent = await HttpAgent.create({ host, identity: session.identity });
const actor = Actor.createActor(idlFactory, { agent, canisterId });
const ws = connectWs({
  actor,
  principal: session.principal,
  gameIdlTypes: plugin.idlTypes,
});
start({ plugin, ws, session });
```

**`principal` must be `session.principal` — the exact same identity that
produced `session.sid`, and it must not be the anonymous principal.**
Every legal `sid` is principal-bound (see `../backend/src/ws.mo`'s
`isAuthorizedSid`): the backend rejects any request whose `sid` doesn't
match the WS connection's own authenticated principal, so the identity
opening the connection and the identity `sid` was derived from can never
drift apart. `resolveIdentity()`/`resolveAnonymousIdentity()` (see
"Logging in with Internet Identity" below) already return a matched
`{ identity, principal, sid }` triple for exactly this reason — don't
build `agent` from a separate, unrelated identity. `ic-websocket-cdk`'s
`ws_open` also hard-rejects an anonymous caller outright ("Anonymous
principal is not allowed"), so `agent` must never be built with
`HttpAgent.create({ host })` and nothing else — that defaults to the
anonymous identity, and the WS handshake (with it, the whole app: there
is no polling fallback by default) never comes up.

A persisted identity's keypair staying the same across a reload is safe
and, for the default anonymous case, deliberate: `resolveAnonymousIdentity()`
persists it in `sessionStorage` (see `anon-identity.js`'s own doc) so
`sid` — and the WS connection's own authenticated principal — survive a
reload of that tab unchanged, exactly the continuity a real Internet
Identity login already had. `ws.mo`'s own spoofing guard
(`Ws.isAuthorizedSid`) has teeth precisely because the WS connection is
genuinely authenticated as that same principal every time. A same-
principal reconnect (any reload, for either identity kind) is handled
correctly at both layers: `Hub.generation`'s own deferred-close mechanism
(see `../backend/src/ws.mo`) protects `ws.mo`'s OWN sid<->principal
bookkeeping from the race, and the vendored `ic-websocket-cdk`'s
`remove_client` (in its `State.mo`) scopes its `client_key` removal to
the exact, current connection rather than the bare principal — a stale
close for an old, already-superseded connection can no longer erase a
newer, still-live one's lookup entry.

`connectWs()` builds a `GatewayWs` (`./ws/gateway-client.js`) that
speaks `mo:duel-game-core/ws`'s real `ic-websocket-cdk` protocol
directly against `actor` — genuine canister-driven push, not client-side
polling wearing a push-shaped interface. There is still no separate
Gateway _process_ to run: `ic-websocket-cdk` doesn't require a
pre-registered Gateway principal — its `ws_open` lets a caller register
**itself** as its own Gateway — so this tab calls
`ws_open`/`ws_get_messages`/`ws_message`/`ws_close` on the canister
directly, polling itself the way a real Gateway would poll on a client's
behalf (see `./ws/gateway-transport.js`'s own header for the full
story). This is also what makes an opponent's disappearance a genuine
server-side signal instead of a guess: the CDK's own canister-side timer
(periodic ack → wait for a keep-alive reply → evict) calls `on_close` on
its own if a connection goes quiet, independent of any explicit goodbye
— see `../backend/src/ws.mo`'s doc header for what the backend does with
that (ends/frees the affected game) and the resulting detection floor
(that timeout is fixed at 60s inside the CDK, not configurable — expect
roughly 60-180s for an involuntary disappearance to be noticed, not
instant; a cooperative one, e.g. the tab closing normally, is much
faster since `GatewayWs` proactively calls `ws_close` itself on
`pagehide`/backgrounding).

**Dependencies and the trade-off that buys.** This is the one place in
this package that pulls in real npm dependencies — `@icp-sdk/core/candid`
(Candid encode/decode of the message content blob) and `cborg`
(CBOR-decoding `ws_get_messages`' envelope) — confined to
`./ws/gateway-*.js`, the same narrow, documented exception
`ic-websocket-cdk` gets on the backend (see the root `CLAUDE.md`'s rule
10). `GatewayWs` also deliberately skips verifying the `cert`/`tree`
fields `ws_get_messages` returns: the CDK certifies its queue so a
client can trust a _Gateway's_ relay without trusting the Gateway
itself, but since our "gateway" here is the player's own tab (already
as trusted as the plain `status()` query already implicitly is), that
property buys nothing and would cost a real BLS-verification dependency
to check — a documented trade-off, not an oversight.

**There is no plain-polling fallback.** A canister built on this
framework has no `createTable`/`joinTable`/`submit`/`rematch`/`leave`/
`reset`/`claimWin`/`ackEnded` Candid method to poll in the first place — the ONLY
way to mutate game
state is `mo:duel-game-core/ws`'s `ws_message` (see
`../backend/src/ws.mo`'s doc header for why: a direct update call is
exactly the race a single, ordered WS channel exists to close). Every
canister built on this package MUST wire `ws.mo`. `start()` itself
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
of up to the 60-180s it'd otherwise take for the canister's own
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
here as `onclose`/a persistent "Connection closed" banner) the instant
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
  if ("view" in ev.data) /* ...update your own UI... */ ;
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
only replies to its own calls — `ws.mo`'s `pushRelevant` pushes a fresh
view to BOTH seats of a match on almost every mutation, so this same
connection routinely gets an unsolicited push whenever the OTHER seat
acts, indistinguishable on the wire from a genuine reply unless
something says otherwise. `GatewayWs` mints a fresh `reqId` per
`request()` call and `ws.mo` echoes it back verbatim on that request's
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

## Logging in with Internet Identity

Every player gets a real, non-spoofable identity by default — no login,
no setup required. `identity.js`'s `resolveIdentity()` (the call `start()`
requires a `session` from — see "Wiring it up" above) resolves one of two
kinds:

```js
import { HttpAgent, Actor } from "@icp-sdk/core/agent"; // however you prefer to load it
import { makeIdlFactory } from "duel-game-core/idl.js";
import { start } from "duel-game-core/app.js";
import { connectWs } from "duel-game-core/ws.js";
import { resolveIdentity } from "duel-game-core/identity.js";
import { plugin } from "./my-game-plugin.js";

const session = await resolveIdentity();
const agent = await HttpAgent.create({ host, identity: session.identity });
const actor = Actor.createActor(makeIdlFactory(plugin.idlTypes), {
  agent,
  canisterId,
});
const ws = connectWs({
  actor,
  principal: session.principal,
  gameIdlTypes: plugin.idlTypes,
});

start({ plugin, ws, session });
```

```html
<button id="duel-auth-btn"></button>
```

That's the entire integration. `resolveIdentity()`:

- Checks for an already-active Internet Identity login. If there is one,
  `session.identity`/`session.principal` are that real, permanent
  identity, and `session.sid` is `sidForPrincipal(principal.toText())` —
  the exact value `../backend/src/ws.mo`'s `Ws.sidForPrincipal` expects
  and enforces.
- Otherwise, falls back to `anon-identity.js`'s `resolveAnonymousIdentity()`
  — a keypair this tab generates once and persists in `sessionStorage`
  (so it, and `session.sid`, survive a reload of this tab unchanged; a
  second tab is automatically a second player, same as it always was),
  with `session.sid` = `` `an:${principal.toText()}` `` — a different
  reserved namespace than a real login's, but bound to the connection's
  own authenticated principal exactly the same way (see
  `../backend/src/ws.mo`'s `isAuthorizedSid`). A game that wants this
  anonymous-but-non-spoofable identity with no login option at all can
  import `resolveAnonymousIdentity()` directly from
  `duel-game-core/anon-identity.js` instead of `identity.js` — it depends
  only on `@icp-sdk/core/identity`, not `@icp-sdk/auth`, so a game that
  never imports `identity.js` pulls in neither.
- Returns `login()`/`logout()`, each of which opens/closes the Internet
  Identity session and then reloads the page, and `regenerate()`
  (anonymous sessions only — a no-op for a logged-in one), which discards
  the persisted keypair for a fresh one and reloads — there is no
  in-place actor/ws teardown-and-rebuild anywhere in this package, so a
  reload is always how a freshly (re)authenticated identity takes effect
  (same pattern as `app.js`'s own `showDisconnected()` recovery).

`start({ session, authBtnId })` (default id `"duel-auth-btn"`) wires that
one button entirely on its own: labeled and enabled for "Log in with
Internet Identity" while anonymous, "Log out" once logged in (left
untouched if `session` provides no `login`/`logout` — e.g. a bare
`resolveAnonymousIdentity()` result), with errors surfaced through the
same `error` element every other action uses. `new-sid` is wired to
`session.regenerate()` and permanently hidden once `session.isLoggedIn` —
a real login isn't meant to be randomized away — or if `session` provides
no `regenerate` at all.

Logged-in and anonymous sessions sit at the very same tables with no
special-casing anywhere: `Table`/`Registry` only ever compare a
`SessionId` for equality, never inspect how it was produced — but every
legal `SessionId` is principal-bound at the transport layer regardless of
which kind produced it (see `../backend/README.md`'s "Player identity"
section).

## Leaderboard

Optional, and independent of `start()`/`ws` entirely: a host that wires
`mo:duel-game-core/leaderboard` (see `../backend/README.md`'s
"Leaderboard" section) exposes `get_leaderboard()` as a plain, read-only
Candid `query` — `idl.js` declares it unconditionally on every actor
`makeIdlFactory` builds, so it's callable directly off the same `actor`
you already built for `start()`, with no `ws` round-trip:

```js
import { renderLeaderboard } from "duel-game-core/render.js";

// Fetched together (both plain Candid queries, no `ws` round-trip either)
// purely so a bot's own row can show its self-reported name — see
// `opts.botNames` below. A `list_bots()` failure (or a host with no bot
// discovery wired) still lets the leaderboard render, just with no alias.
const [entries, bots] = await Promise.all([
  actor.get_leaderboard(),
  actor.list_bots().catch(() => []),
]);
leaderboardPanelEl.innerHTML = renderLeaderboard(entries, plugin, {
  yourSid: session.sid,
  botNames: new Map(bots.map((b) => [b.principal.toString(), b.name])),
});
```

Unlike the lobby/staging/debrief chrome `render.js` also supplies, a
leaderboard has no fixed place in every game's own layout, so
`renderLeaderboard` is never wired into `renderView`/`renderStatus`
automatically — call it wherever you mount your own panel. The common
shape (all three example games use it, see each one's own `CLAUDE.md`):
a small icon-only 🏆 toggle button in the header, positioned FIRST in
`.session` — before the player id, `new`, and `duel-auth-btn` — that
opens a dedicated full-page overlay (`position: fixed; inset: 0`, styled
by `style.css`'s own `#leaderboard-panel` rules) with its own "← Back"
button, rather than a small inline panel: a leaderboard fetch is a plain
one-off query, not something the generic chrome's own live status pushes
need to coexist with underneath it, so a full takeover avoids any risk of
a push re-rendering `#screen` out from under an inline panel sitting
alongside it. `opts.yourSid` — pass the caller's own `session.sid` —
picks out and badges that player's own row (a "You" pill, plus a `.you`
class row highlight in `style.css`) if they're on the ranked list; omit
it, or a caller simply not being ranked yet, and no row is marked. A
canister-seated player's own row gets a 🤖 icon and reads
`"<principal> (<complexity>)"` — or, when `opts.botNames` (built from a
`list_bots()` call, keyed by bare principal text) names that exact
principal, `"<name> (<complexity>)"`, e.g. "CheckersBot (Hard)". A bot's
leaderboard key is `cp:<principal>:<complexity>` (`CanisterPlayers.leaderboardKey`
— see `../backend/README.md`'s "Leaderboard" section's own
player-identity note): its `cp:` marker is stripped for display, same as
a human's own key, which already carries no prefix at all (`Ws.playerKey`
strips `ii:`/`an:` before a score is ever stored; a `cp:` one is added
back deliberately by whichever `Host.mo` wires canister players, to key a
bot by its own stable principal rather than one of its many per-table
sids), and the complexity it played that game at is always spelled out,
"Default" included, because each of a bot's complexities is its own
separately-rated row — see `isCanisterPlayer`/`parseCanisterPlayer`/
`botDisplayName`/`displayPlayerId`, exported from `render.js` for a game
that wants the same distinction elsewhere. The row's own `title`
attribute always carries the full, raw `player` text regardless, so the
principal itself is still one hover away even when a name is shown, and
its Challenge button carries that row's exact complexity (see "Bot
registry" below). `opts.botNames` is entirely optional — omit it (or a
principal it simply doesn't name) and that row falls back to the bare
principal. It renders a ranked
list (rank, each entry's own `score` run through `plugin.formatScore` —
see "The GamePlugin contract" above; the player id itself is rendered in
full and left to `.leaderboard-player`'s own CSS to clip responsively
against whatever width it actually gets, rather than pre-truncated to a
fixed character count the way `renderTableRow`'s lobby rows are — a
leaderboard panel has real width to spare) and an empty-state message
instead of an empty list when nobody's finished a game yet.

## Bot registry

Optional, and layered on the same actor `get_leaderboard()` above already
uses — no `ws` round-trip needed here either: a host that wires bot
discovery (`mo:duel-game-core/canister_players`'s `BotDirectory`, see
`../backend/README.md`'s "Canister players" section, "Bot discovery")
exposes `list_bots()`, `register_bot(name, complexities)`, and
`unregister_bot()`; `idl.js` declares all three unconditionally, same
precedent as `get_leaderboard`. A frontend only ever CALLS `list_bots()`
— registration itself is a Motoko-to-Motoko call a bot canister makes to
its own host, not something a browser tab does.

```js
import { renderBotList, renderSeatChoice } from "duel-game-core/render.js";
import { buildBotPlayIdlFactory } from "duel-game-core/idl.js";

const bots = await actor.list_bots(); // BotInfo[], highest-rated bot first, unrated last
botPanelBodyEl.innerHTML = renderBotList(bots, plugin);
```

Each `BotInfo` carries the bot's own self-reported `name` and its
`complexities` — the ways it can play, declared by the bot itself at
registration as opaque strings (an "Easy"/"Medium"/"Hard" ladder, a
"Rabbit"/"Fox"/"Lion" one, "Look-ahead"/"Reactive", or just `"Default"`
for a bot with one way to play; see `../backend/README.md`'s "Canister
players" section, "Complexity"), in the bot's own declared order, each
with its own `elo`. `renderBotList` renders one row per bot AND
complexity, `"<name> (<complexity>)"` — exactly how that same
bot-complexity's row on the leaderboard reads — with that complexity's
`elo` (run through the SAME `plugin.formatScore` `renderLeaderboard`
uses, so a rating reads identically wherever it appears; blank when this
host wires no leaderboard at all, in which case every `elo` comes back
empty alike) and a `Challenge` button carrying
`data-challenge-bot="<principal text>"`/`data-bot-name="<name>"`/
`data-bot-complexity="<complexity>"`. Picking a way of playing IS picking
a row, so there's never a separate complexity-choice step — a bot with
one way to play is simply one row, `"<name> (Default)"`.
`renderLeaderboard` (above) renders the exact same three attributes on
a bot ROW's own Challenge button (the row's own complexity, so clicking
it challenges the bot at the way of playing that row rates), so a game
wires ONE click handler for both entry points — clicking either should
lead to the same challenge flow, not two independent ones.

**The challenge flow.** Once a player picks a bot (at one of its
complexities), get them into a game against it — the SAME plain Candid
call to the bot's own `play(host, tableId, seat, code, complexity)`
Flow 1 always used (see `../backend/README.md`'s "Canister players"
section), built via the shared `buildBotPlayIdlFactory` rather than a
hand-rolled IDL, and targeting the CHOSEN bot's own principal (from
`list_bots()`), never a fixed/env-var canister id, with the CHOSEN
complexity (`data-bot-complexity`) as its last argument — the bot
forwards it to `join_table_as_canister`, and it's what every later
`make_move` ask carries as `MoveRequest.complexity`:

```js
import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { errText, tag } from "duel-game-core/render.js";

// Already on the "Waiting for an opponent" screen for a table you made
// yourself? Fill its own open seat directly — no new table needed. See
// `renderSeatChoice` below otherwise.
const res = await botActor.play(
  hostPrincipal,
  tableId,
  openSeat,
  code,
  complexity
);
```

If the player ISN'T already staging a table, show `renderSeatChoice(plugin)`
first (the same two-button `p1`/`p2` picker `renderView`'s own "Start a
new table" section uses, standalone so a challenge dialog living OUTSIDE
`#screen` can render it without touching `render.js`'s own generically-
owned markup — its buttons carry `data-challenge-seat`, never
`data-create-table`), then create the table yourself, directly over the
shared `ws` rather than through `start()`'s own internal click handling
(`ws.request`, the same correlatable, scoped-reply call this package's
own lobby-bridging code already relies on — still the one `ws.mo`
channel; which JS module issues the request is not what
`../backend/CLAUDE.md`'s architecture rule 11 is about):

```js
const res = await ws.request(session.sid, {
  createTable: {
    seat: { [chosenSeat]: null },
    visibility: { open: null },
    variant: "",
  },
});
// res.view.atTable.id / res.view.atTable.view.stagingYou name the fresh
// table/seat/code to hand `botActor.play(...)` next.
```

Build `botActor` with `Actor.createActor(buildBotPlayIdlFactory, { agent, canisterId: principalText })`
— `principalText` is the CHOSEN bot's own `BotInfo.principal.toString()`
(or a leaderboard row's already-`cp:`-stripped `player` text), never a
`PUBLIC_CANISTER_ID:bot`-style env var: nothing in this design assumes a
deploy bundles its own single bot canister.

**Two entry points, one flow.** `renderBotList` (a dialog's own list) and
`renderLeaderboard` (a bot row's Challenge button) both fire the same
`data-challenge-bot` attribute, but they don't need identical GATING —
each example wires its own trigger to fit where it sits:

- An **"Add Bot" control shown only on the "Waiting for an opponent"
  screen** (`StagingYouView`, tracked the same way `render.js`'s own
  reclaim-warning countdown is — off the live status push, never a
  one-shot check) opens the dialog straight into `renderBotList`; since a
  seat's already been picked (the ordinary "Start a new table" flow), the
  challenge flow above always takes the `seat === undefined` path — no
  `renderSeatChoice` step. This is Flow 1's own human-facing entry point,
  unchanged in spirit from before bots were discoverable — only WHICH bot
  it calls is new.
- The **leaderboard's own Challenge button** is reachable from anywhere
  (browsing included, since the leaderboard panel is), so it can't assume
  an open seat already exists — that's the one path that reaches
  `renderSeatChoice` first.

**Rematch against a bot.** The engine's own `rematch` treats a bot like
any other partner: the human's Rematch click from the debrief stages the
SAME table with the open seat reserved for the bot's own `cp:` session
(`StagingYouView.reservedForPartner`). A bot has no "Accept rematch"
click of its own, though, and nothing on the host ever asks one to
accept — so the frontend does it. Remember the bot, complexity, and
table id of every successful `play` call, and when a `stagingYou` push
for THAT table arrives carrying `reservedForPartner`, re-issue the
identical `play` call (the same `seat === undefined` path as the "Add
Bot" case — the staging's own open seat and code) instead of showing the
"Waiting for an opponent" screen at all; the player sees "Inviting
<bot>…" straight away. This works because `join_table_as_canister`
derives the bot's session from its principal, the table id, and the
complexity — all three unchanged on a rematch (a `Registry` rematch
reuses the same `TableId`) — so the bot lands on exactly the session the
reservation names, pattern-matching it the same way a human partner's own
accept does. Clear the remembered bot the moment the session's status is
anywhere but that table (browsing, another table): "Return to lobby" is
the player saying they're done with that opponent, whereas Rematch is
them asking for the same one again. The examples keep it in
`sessionStorage` so a mid-game reload doesn't lose it.

See `examples/racing/frontend/src/duel/duel-app.js`/
`examples/checkers/frontend/src/app.js` for the full worked flow —
`#bot-add-panel`'s own trigger button (a sibling of `#screen`, exactly
where a hardcoded single-bot version of this control used to live) for
the first case, `#bot-challenge-panel` (a full-page overlay, opened by
either entry point) for the dialog itself.

## Optional: `ic-env.js`

If you're deploying to the Internet Computer via an asset canister,
`readIcEnv()` and `deriveHost()` extract the canister id and the right
`HttpAgent` host from the `ic_env` cookie the asset canister sets and
from `window.location`. They're generic IC-hosting helpers, unrelated to
any game's rules — use them when building `agent`/`actor`, or don't;
`start()` never calls them itself.

## Modules

| Module                    | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idl.js`                  | `makeIdlFactory(buildGameTypes)`, `buildEngineTypes({IDL, Action, State})` — `status`/`get_leaderboard`/`list_bots`'s own types plus the `ws.mo`/CDK protocol types both `makeIdlFactory` and `ws/gateway-protocol.js` build on; `buildBotPlayIdlFactory({IDL})` — a ready-to-use `idlFactory` for a discovered bot's own `play` method, see "Bot registry"                                                                                                      |
| `render.js`               | `renderStatus(status, plugin)` — the top-level entry point; `renderView(view, plugin)` for a single table's own screen, `renderLeaderboard(entries, plugin, opts?)`, `renderBotList(bots, plugin)`, `renderSeatChoice(plugin)`, `playerKeyOf(sid)`, `isCanisterPlayer(player)`, `parseCanisterPlayer(player)`, `botDisplayName(name, complexity)`, `displayPlayerId(player)`, `DEFAULT_BOT_COMPLEXITY`, `errText(err)`, `actionAttr(value)`, `tag`, `val`, `esc` |
| `app.js`                  | `start({ plugin, ws, session, ...elIds })`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `identity.js`             | `resolveIdentity()`, `sidForPrincipal(principalText)` — see "Logging in with Internet Identity"; depends on `@icp-sdk/auth`/`@icp-sdk/core/identity`, same narrow-exception treatment as `ws/gateway-*.js`                                                                                                                                                                                                                                                       |
| `anon-identity.js`        | `resolveAnonymousIdentity()`, `regenerateAnonymousIdentity()`, `sidFor(prefix, principalText)`, `ANON_SID_PREFIX` — the persisted-keypair anonymous identity `identity.js` re-exports; depends only on `@icp-sdk/core/identity`, not `@icp-sdk/auth`                                                                                                                                                                                                             |
| `ic-env.js`               | `readIcEnv()`, `deriveHost()` (optional)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ws.js`                   | `connectWs({ actor, principal, gameIdlTypes, ...opts })` — see "Real-time push"; `start()` requires its result                                                                                                                                                                                                                                                                                                                                                   |
| `ws/gateway-client.js`    | `GatewayWs` — the public class `ws.js`'s `connectWs()` builds                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ws/gateway-transport.js` | `SelfGatewayTransport` — moves bytes (the embedded-Gateway registration/poll/send/close calls); swap this for a real-external-Gateway transport without touching the other two `ws/gateway-*.js` files                                                                                                                                                                                                                                                           |
| `ws/gateway-protocol.js`  | `GatewayProtocol` — Candid encode/decode, sequence bookkeeping, and interpreting a decoded envelope; transport-agnostic                                                                                                                                                                                                                                                                                                                                          |
| `style.css`               | generic layout primitives                                                                                                                                                                                                                                                                                                                                                                                                                                        |

See [`../backend/README.md`](../backend/README.md) for the matching
backend `Spec` contract.
