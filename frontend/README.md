# duel-game-core

Rules-agnostic browser client for any canister built on the
[`duel-game-core`](../backend/README.md) Motoko engine. It implements every
screen that is the same for every game — the multi-table lobby, staging,
rematch offer, busy countdown, debrief chrome, the `#endedByOther`
notice — plus session identity and real-time push. A game supplies a
small **GamePlugin**: two Candid types, seat labels, and how to draw the
board and action buttons.

TypeScript, published pre-compiled: `npm run build` produces `dist/`,
which every import (`duel-game-core/app.js`, ...) resolves to. Consumers
need no build step. Dependency-free except for three documented files:
`ws/gateway-*.js` (`@icp-sdk/core`, `cborg`), `identity.js`
(`@icp-sdk/auth`, `@icp-sdk/core/identity`), and `anon-identity.js`
(`@icp-sdk/core/identity` only).

```
npm install duel-game-core --legacy-peer-deps
```

`--legacy-peer-deps` is needed because `@icp-sdk/auth` declares a peer
range on `@icp-sdk/core@^5`, one major behind the `^6.1.0` in use.

## The GamePlugin contract

```js
const plugin = {
  // Candid types for the game's move and state.
  idlTypes({ IDL }) {
    return { Action: IDL.Variant({/* ... */}), State: IDL.Record({/* ... */}) };
  },

  seatLabel(seat) {
    return { p1: "White", p2: "Black" }[seat];
  },

  // Board markup from `mySeat`'s point of view. Called for a live game
  // and for a debrief's final state. `yourTurn` (true/false live,
  // undefined in a debrief) is for a game whose interaction lives on the
  // board itself; a plugin with a separate action panel can ignore it.
  renderBoard(gameState, mySeat, oppSeat, yourTurn) {
    return `<pre>${JSON.stringify(gameState, null, 2)}</pre>`;
  },

  // Action buttons, only ever called while `mySeat` may move. Each button
  // carries its move via `actionAttr` so the generic click handling can
  // submit any Action shape as-is.
  renderActions(gameState, mySeat) {
    return `<button ${actionAttr({ pass: null })}>Pass</button>`;
  },

  // Optional: render a leaderboard `score` (bigint). Default is the plain
  // integer (right for ELO); a game storing a converted score inverts it.
  formatScore(score) {
    return score.toString();
  },

  // Optional pair for a game with rules variants. The first choice is the
  // default; `key` is what `Spec.init(variant)` receives on the backend.
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

Only `renderBoard`/`renderActions` return game markup. Everything else
(turn counter, "opponent is deciding"/"locked in" or "Your turn"/
"Opponent's turn" for an `#alternating` table, verdict banner,
rematch/leave/forfeit buttons, claim-win controls) is generic chrome
driven by `InGameView`.

## Wiring it up

You build the `actor` (this package imports no agent and no CDN), a
`session` (required), and a `ws` over the same identity (required, no
polling mode):

```js
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { makeIdlFactory } from "duel-game-core/idl.js";
import { start } from "duel-game-core/app.js";
import { connectWs } from "duel-game-core/ws.js";
import { resolveIdentity } from "duel-game-core/identity.js"; // or anon-identity.js
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

Element ids `start()` uses (all overridable, `start({ ..., sidElId })`):

```html
<span id="sid"></span>
<button id="new-sid">new</button>
<button id="duel-auth-btn"></button>
<p id="error" hidden></p>
<main id="screen"></main>
<link rel="stylesheet" href="node_modules/duel-game-core/style.css" />
```

- `sid` — the session id (per tab; a second tab is a second player).
- `new-sid` — discards the persisted anonymous keypair and reloads.
  Hidden for a logged-in session or one without `regenerate`; disabled
  while the sid holds a seat, since swapping identity would abandon it.
- `duel-auth-btn` — login/logout, wired only when `session` provides
  both.
- `screen` — where `renderStatus` output goes; clicks are delegated from
  here so re-rendering never leaks listeners.
- `error` — transient rejections, auto-hidden after 5s. A closed
  transport is terminal: the banner stays with a "Reload to reconnect"
  button and every button is disabled.

## Real-time push

`connectWs()` builds a `GatewayWs` (`ws/gateway-client.js`) that speaks
`mo:duel-game-core/ws`'s `ic-websocket-cdk` protocol directly: the tab
registers itself as its own Gateway via `ws_open`, polls
`ws_get_messages`, sends via `ws_message`, and says goodbye with
`ws_close` on `pagehide`. Genuine canister-driven push, and a genuine
server-side disappearance signal (the CDK's fixed 60s keep-alive gives a
60–180s floor for an involuntary drop; a cooperative close is
immediate).

**`principal` must be `session.principal`** — the identity that produced
`session.sid` and signs the `actor`'s calls. The backend rejects a `sid`
that doesn't match the connection's principal, and the CDK rejects an
anonymous caller outright, so never build the agent without an identity.
`resolveIdentity()`/`resolveAnonymousIdentity()` return a matched
`{ identity, principal, sid }`. A same-principal reconnect (any reload)
is safe: `Hub.generation`'s deferred close protects `ws.mo`'s
bookkeeping, and the vendored CDK's `remove_client` is scoped to the
exact connection.

**Dependencies.** `ws/gateway-*.js` uses `@icp-sdk/core/candid` and
`cborg`. Certificate verification of `ws_get_messages`' `cert`/`tree` is
deliberately skipped: the "gateway" is the player's own tab, so the
property buys nothing and would cost a BLS dependency.

**No polling fallback.** A host built on this framework has no plain
mutating method to poll. `start()` only needs the four handlers and
`send(msg)`, so a hand-rolled WebSocket-shaped object (a test mock, a
real external-Gateway transport) can replace `GatewayWs`.

**Reconnection.** Any failed poll or send invalidates the registration;
the next tick redoes `ws_open` transparently, with no `onclose`.
`onopen` fires again on every confirmed reopen so a caller can resync.
`onerror` fires only on a second consecutive failure, since a lone blip
self-heals within a tick.

**`send()`/`request()` are safe before the connection is open** — both
await one coalesced `ws_open`. **Every outgoing `ws_message` is
serialized**: the CDK evicts a client on an out-of-order sequence
number, and two in-flight update calls have no ordering guarantee.

**Sharing one `ws`.** `GatewayWs` extends `EventTarget`; game code can
`ws.addEventListener("message", ...)` on the same connection instead of
opening a second one (two independent pollers can deliver out of order).
`ws.send(msg)` is fire-and-forget; `ws.request(sid, req)` returns a
Promise of that exact call's `{ view } | { err }`, correlated by a
`reqId` `ws.mo` echoes back (a broadcast to the other seat carries
`null`), so any number of requests can be in flight. See
`examples/racing/frontend/src/app/modules/gameplay/game-communication/services/lobby-connection.service.ts`.

## Logging in with Internet Identity

`resolveIdentity()`:

- Uses an active Internet Identity login if present:
  `sid = "ii:" + principal`.
- Otherwise falls back to `anon-identity.js`'s
  `resolveAnonymousIdentity()`: a keypair generated once and persisted in
  `sessionStorage` (survives a reload of this tab; a second tab is a
  second player), `sid = "an:" + principal`. Import only
  `anon-identity.js` for a login-free game without `@icp-sdk/auth`.
- Returns `login()`/`logout()` (each reloads the page) and `regenerate()`
  (anonymous only; discards the keypair and reloads). Identity changes
  always take effect by reload — nothing rebuilds actor/ws in place.

Both kinds sit at the same tables; the engine only compares session ids
for equality, and the transport binds every legal sid to a principal.

## Leaderboard

A host wiring `mo:duel-game-core/leaderboard` exposes `get_leaderboard()`,
a plain query `idl.js` declares on every actor:

```js
import { renderLeaderboard } from "duel-game-core/render.js";

const [entries, bots] = await Promise.all([
  actor.get_leaderboard(),
  actor.list_bots().catch(() => []),
]);
panelEl.innerHTML = renderLeaderboard(entries, plugin, {
  yourSid: session.sid,
  botNames: new Map(bots.map((b) => [b.principal.toString(), b.name])),
});
```

`renderLeaderboard` is never wired into `renderStatus` — mount it where
your layout wants it. All examples use an icon-only 🏆 toggle first in
`.session` that opens a full-page overlay (`#leaderboard-panel`, styled
by `style.css`), so live status pushes re-rendering `#screen` never
clobber it. `opts.yourSid` badges the caller's row ("You", `.you`);
`playerKeyOf(sid)` mirrors `Ws.playerKey`. A canister player's row shows
🤖 and `"<name or principal> (<complexity>)"` — the key is
`cp:<principal>:<complexity>` (`isCanisterPlayer`,
`parseCanisterPlayer`, `botDisplayName`, `displayPlayerId`,
`DEFAULT_BOT_COMPLEXITY` are exported) — with the raw key in `title` and
a Challenge button carrying that row's complexity.

## Bot registry

A host wiring bot discovery exposes `list_bots()`, `register_bot`, and
`unregister_bot` (all declared unconditionally by `idl.js`); a frontend
only calls `list_bots()`.

```js
import { renderBotList, renderSeatChoice } from "duel-game-core/render.js";
import { buildBotPlayIdlFactory } from "duel-game-core/idl.js";

const bots = await actor.list_bots(); // highest-rated first, unrated last
botPanelEl.innerHTML = renderBotList(bots, plugin);
```

`renderBotList` renders one row per bot AND complexity, in declared
order, `"<name> (<complexity>)"`, with that complexity's `elo` (via
`plugin.formatScore`; blank when the host has no leaderboard) and a
Challenge button carrying `data-challenge-bot`/`data-bot-name`/
`data-bot-complexity` — the same attributes `renderLeaderboard`'s bot
rows carry, so one click handler serves both.

**Challenge flow.** Call the chosen bot's own `play(host, tableId, seat,
code, complexity)` via `Actor.createActor(buildBotPlayIdlFactory, { agent,
canisterId: principalText })`, targeting the principal from `list_bots()`,
never an env var. If the player is already on "Waiting for an opponent",
fill that table's open seat directly. Otherwise show
`renderSeatChoice(plugin)` (a standalone `p1`/`p2` picker with
`data-challenge-seat`, for a dialog living outside `#screen`), then create
the table over the shared `ws`:

```js
const res = await ws.request(session.sid, {
  createTable: {
    seat: { [chosenSeat]: null },
    visibility: { open: null },
    variant: "",
  },
});
// res.view.atTable.id / .view.stagingYou give the table, seat, and code for `play`.
```

Two entry points, one flow: an "Add Bot" control shown only on the
staging screen (tracked off the live status push) skips the seat step;
the leaderboard's Challenge button, reachable while browsing, goes
through it.

**Rematch against a bot.** The human's Rematch stages the same table
with the seat reserved for the bot's `cp:` session. Nothing asks a bot
to accept, so the frontend remembers the last bot, complexity, and table
id of each successful `play` (in `sessionStorage`) and re-issues the
identical `play` when a `stagingYou` push for that table arrives with
`reservedForPartner`, showing "Inviting <bot>…" instead of "Waiting for
an opponent". Principal, table id, and complexity are unchanged on a
rematch, so the bot lands on the reserved session. Clear the memory the
moment the status is anywhere but that table. See
`examples/checkers/frontend/src/app.js` and
`examples/racing/frontend/src/duel/duel-app.js`.

## Optional: `ic-env.js`

`readIcEnv()` reads the `ic_env` cookie an asset canister sets;
`deriveHost()` picks the agent host for the current location
(localhost, the parent domain on icp0.io/ic0.app, the page's own origin
on icp.net, `icp-api.io` as a last resort). `start()` never calls them.

## Modules

| Module                    | Exports                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idl.js`                  | `makeIdlFactory(buildGameTypes)`, `buildEngineTypes({IDL, Action, State})`, `buildBotPlayIdlFactory({IDL})`                                                                                                                                                                           |
| `render.js`               | `renderStatus`, `renderView`, `renderLeaderboard(entries, plugin, opts?)`, `renderBotList`, `renderSeatChoice`, `playerKeyOf`, `isCanisterPlayer`, `parseCanisterPlayer`, `botDisplayName`, `displayPlayerId`, `DEFAULT_BOT_COMPLEXITY`, `errText`, `actionAttr`, `tag`, `val`, `esc` |
| `app.js`                  | `start({ plugin, ws, session, ...elIds })`                                                                                                                                                                                                                                            |
| `identity.js`             | `resolveIdentity()`, `sidForPrincipal(principalText)`; depends on `@icp-sdk/auth`                                                                                                                                                                                                     |
| `anon-identity.js`        | `resolveAnonymousIdentity()`, `regenerateAnonymousIdentity()`, `sidFor(prefix, principalText)`, `ANON_SID_PREFIX`; depends only on `@icp-sdk/core/identity`                                                                                                                           |
| `ic-env.js`               | `readIcEnv()`, `deriveHost()`                                                                                                                                                                                                                                                         |
| `ws.js`                   | `connectWs({ actor, principal, gameIdlTypes, intervalMs?, requestTimeoutMs? })`, `GatewayWs`                                                                                                                                                                                          |
| `ws/gateway-client.js`    | `GatewayWs` — poll loop, reconnect policy, request correlation                                                                                                                                                                                                                        |
| `ws/gateway-transport.js` | `SelfGatewayTransport` — moves bytes; swap for a real external-Gateway transport without touching the other two                                                                                                                                                                       |
| `ws/gateway-protocol.js`  | `GatewayProtocol` — Candid encode/decode, sequence bookkeeping, envelope interpretation                                                                                                                                                                                               |
| `style.css`               | generic layout primitives                                                                                                                                                                                                                                                             |

See [`../backend/README.md`](../backend/README.md) for the `Spec`
contract.
