# duel-game-core

Rules-agnostic browser client for any canister built on the
[`duel-game-core`](../backend/README.md) Motoko engine, in three layers a
game takes as much or as little of as it wants:

- **`client.js`, the headless client.** `createDuelClient({ ws, session })`
  owns the transport, the current `Status`, the one call in flight, error
  lifetime, the session-identity lock, and the stale-view resync, and
  publishes an immutable state snapshot to subscribers. No DOM, no HTML.
  A game with its own UI (any framework, any look) binds this and nothing
  else.
- **`render.js`, the default UI components.** Pure `view -> HTML` functions
  for every screen that is the same for every game — the multi-table
  lobby, staging, rematch offer, busy countdown, debrief chrome, the
  `#endedByOther` notice — each exported on its own, plus the leaderboard,
  bot list, and seat picker a game mounts itself.
- **`app.js`, the default shell.** `start({ plugin, ws, session })` wires
  the two together into `#screen`: delegated clicks, the per-button
  spinner, the local countdowns, the header controls, the error banner,
  and the confirm and access-code overlays. Any screen or overlay is
  replaceable in place (`screens`, `confirm`, `promptCode`), and `start()`
  returns the client it built.

In every layer a game supplies the same small **GamePlugin**: two Candid
types, seat labels, and how to draw the board and action buttons.

TypeScript, published pre-compiled: `npm run build` produces `dist/`,
which every import (`duel-game-core/app.js`, ...) resolves to. Consumers
need no build step. Dependency-free except for three documented files:
`transport.js` (`@icp-sdk/core/candid`), `identity.js`
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
  // and for a debrief's final state, and must show the opponent's most
  // recent move in both (see "Showing moves"). `yourTurn` (true/false
  // live, undefined in a debrief) is for a game whose interaction lives
  // on the board itself; a plugin with a separate action panel can
  // ignore it.
  renderBoard(gameState, mySeat, oppSeat, yourTurn) {
    return `<pre>${JSON.stringify(gameState, null, 2)}</pre>`;
  },

  // Action buttons, only ever called while `mySeat` may move. Each button
  // carries its move via `actionAttr` so the generic click handling can
  // submit any Action shape as-is.
  renderActions(gameState, mySeat) {
    return `<button ${actionAttr({ pass: null })}>Pass</button>`;
  },

  // Optional: `gameState` with `mySeat`'s `move` applied, drawn while the
  // submit is in flight; null draws the board as it is. A cosmetic mirror
  // of `resolve` (see "Showing moves").
  applyLocal(gameState, mySeat, move) {
    return { ...gameState, passes: gameState.passes + 1 };
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
rematch/leave/forfeit buttons, claim-win controls) is the default chrome
driven by `InGameView`, replaceable per screen (below) or wholesale
("The headless client").

## Showing moves

Two things a player must always see, whatever the UI:

- **The opponent's most recent move**, on the live board and on the
  debrief. The game's last move is on screen when the debrief replaces
  the board, so a debrief that drops the board (a custom one showing
  only a score) drops it too. Mark it on the board (a highlighted cell,
  the origin and landing of a piece, captured pieces as ghosts), replay
  it as an animation, or show both picks of the last round. When `State`
  carries no record of the last move, diff consecutive `game`s in the
  plugin; `examples/tic-tac-toe`, `checkers` and `chopsticks` do.
- **Your own move, at once.** A submit is a round trip, and against a
  canister bot your move's view often arrives together with the bot's
  reply. With `applyLocal`, `start()` draws the in-game screen from
  `withLocalMove(status, pending, plugin.applyLocal)` while the submit is
  out: the board with your move applied and the seat already waiting
  (for `#alternating`, the opponent on turn and the turn counter
  advanced). The reply, a later view, or a rejection (which leaves
  `status` untouched) puts the real view back in the same frame. A
  `#simultaneous` game whose hidden pick changes nothing visible returns
  `gameState` as-is, which still flips the screen to "locked in".
  `applyLocal` mirrors `resolve` the way move highlighting mirrors
  `validate`: purely cosmetic, never sent, and `validate` still decides.

## Wiring it up

You build the `actor` (this package imports no agent and no CDN), a
`session` (required), and a `ws` over the same identity (required, no
polling mode):

```js
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { makeIdlFactory } from "duel-game-core/idl.js";
import { start } from "duel-game-core/app.js";
import { connectTransport } from "duel-game-core/transport.js";
import { resolveIdentity } from "duel-game-core/identity.js"; // or anon-identity.js
import { plugin } from "./my-game-plugin.js";

const session = await resolveIdentity();
const agent = await HttpAgent.create({ host, identity: session.identity });
const actor = Actor.createActor(makeIdlFactory(plugin.idlTypes), {
  agent,
  canisterId,
});
const ws = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });

const client = start({ plugin, ws, session });
```

`start()` returns the `DuelClient` it drives the screen with, so game code
outside the shell (a bot-challenge dialog, a stats panel) reads
`client.getState()`, subscribes, and calls `client.createTable(...)` and
friends instead of hand-building `ws.request` calls; the shell's spinner
and identity lock follow either way.

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
- `error` — transient rejections, auto-hidden after 5s (`errorTtlMs`).
  "Reconnecting…" while a lost connection is redone (the screen stays
  live; clicks queue behind the reopen). A closed transport is terminal:
  the banner stays with a "Reload to reconnect" button and every button
  is disabled.

## Replacing screens

`start({ screens })` takes any subset of the `Screens` map and merges it
over `defaultScreens`:

```js
import { debriefVerdict } from "duel-game-core/render.js";

start({
  plugin,
  ws,
  session,
  screens: {
    debrief(v, plugin) {
      const me = Object.keys(v.seat)[0];
      const { title, outcome } = debriefVerdict(v.end, me);
      return `<h2 class="verdict ${outcome}">${title}</h2>
        <div class="board">${plugin.renderBoard(v.finalGame, me, me === "p1" ? "p2" : "p1")}</div>
        <button data-rematch class="primary">Again</button>
        <button data-leave class="ghost">Lobby</button>`;
    },
  },
});
```

The keys are `connecting`, `browsing`, `tableBadge`, `lobby`, `busy`,
`stagingYou`, `awaitingRematch`, `inGame`, `debrief`, `endedByOther`,
each with the same signature as the `render*` function it replaces. A
custom screen keeps the shell's click handling, spinner, and countdowns
by using the same hooks the defaults do:

| Hook                                                                                                 | Dispatches                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------- |
| `data-create-table="p1"` + the `table-visibility` radios, `#create-code`, `table-variant` radios     | `createTable`                   |
| `data-join-table-id="3" data-join-table="p2"` (+ bare `data-protected` to prompt for a code)         | `joinTable`                     |
| `data-act='<json>'` (via `actionAttr`)                                                               | `submit`                        |
| `data-rematch`, `data-leave`, `data-reset`, `data-claim-win`, `data-ack`                             | the matching call               |
| `data-confirm="Sure?"` on any of the above                                                           | asks first                      |
| `id="duel-idle-warning"`, `id="duel-claim-warning"`, `id="duel-claim-button"`, `data-wait-base="12"` | patched by the local countdowns |

`confirm` (`(msg) => Promise<boolean>`) and `promptCode` (`() =>
Promise<string>`, resolving `null` to cancel) replace the two overlays the
same way. `examples/rock-paper-scissors` replaces its debrief this way,
keeping the final round's two picks on it.

## The headless client

For a UI that is not "our screens plus CSS" — a framework app, a canvas
game with its own lobby, a different interaction model — skip `app.js`
and bind `client.js` yourself:

```js
import {
  createDuelClient,
  localSecondsLeft,
  viewOf,
} from "duel-game-core/client.js";

const client = createDuelClient({ ws, session });
client.subscribe((state, prev) => {
  // `state` is a fresh immutable snapshot after every change.
  render(state);
});
```

`ClientState`:

| Field            | Meaning                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`     | `"connecting"` / `"open"` / `"reconnecting"` (lost, being redone; calls queue) / `"closed"` (terminal: reload)                                          |
| `status`         | the last `Status` received (the first may be `ws.queryStatus`'s, still `"connecting"`), `null` before one; structurally equal views never re-notify     |
| `statusAt`       | `Date.now()` when `status` last changed — every `secondsUntilX` is only as fresh as that; `localSecondsLeft(secs, statusAt)` counts down from it        |
| `pending`        | `{ key, req }` while one call is out (`create:p1`, `jointable:3:p2`, `act:{"pass":null}`, `rematch`, `leave`, `reset`, `claim-win`, `ack`); at most one |
| `error`          | a transient message (cleared after `errorTtlMs`), or the permanent "Connection closed."                                                                 |
| `authPending`    | a login/logout/regenerate is under way                                                                                                                  |
| `identityLocked` | disable "new sid" and login/logout: seated, a join in flight, an identity change in flight, or closed                                                   |

Actions: `createTable(seat, visibility?, variant?)`, `joinTable(id, seat,
code?)`, `submit(move)`, `rematch()`, `leave()`, `reset()`, `claimWin()`,
`ackEnded()`. Each stamps `gen`/`turn` from the last status and resolves
with a `CallOutcome`: `{ ok: true, view }`, or `{ ok: false, reason }`
where `reason` is `"inFlight"` (one is already out), `"closed"`,
`"stale"` (a `#wrongPhase` create/join or `#stale` mutation: the view was
behind, a silent `refresh()` is on its way), `"rejected"` (`err` and its
`message`, also shown in `state.error`), or `"failed"` (transport,
`message`). A `"rejected"` or `"failed"` call also sends a `refresh()`,
so a screen the server has moved past (the table is gone, the seat was
lost) is replaced by the real status. When the first status after a
reconnect finds a session that was seated back in the lobby,
`state.error` says so (`ENDED_WHILE_AWAY_MESSAGE`). `refresh()` is a sync
ping. `showError`/`clearError` put a
UI's own messages on the same lifetime. `login()`, `logout()`,
`regenerateSid()` wrap the session's own functions and drive
`authPending`. `dispose()` detaches from `ws`.

Selectors, all pure: `viewTagOf(status)`, `viewOf(status, "inGame")`,
`isSeated`, `genOf`, `turnOf`, `claimRoleOf(inGame)` (`"waiting"` may
claim, `"atRisk"` is the mirror), `oppSeatOf`, `localSecondsLeft`,
`localSecondsElapsed`, `pendingKeyOf(req)`, `pendingMoveOf(pending)`,
`withLocalMove(status, pending, applyLocal)`, plus `tag`/`val`/`errText`.

A custom UI shows its own move at once the way `start()` does: draw from
`withLocalMove(state.status, state.pending, plugin.applyLocal)` and redraw
when `status` or `pending` changes. The reply clears `pending` and lands
its `status` in one snapshot, so the board never flashes back to the
pre-move position. Anything derived from consecutive views (a move log,
an opponent-move replay) should read the same local status: it then sees
your move and the opponent's as two steps even when the server delivers
both in one view.
`render.js`'s text helpers (`debriefVerdict`, `opponentStatusText`, the
warning thresholds and texts) are pure too and free to reuse or ignore.

`examples/007` is the worked example: every screen, the header, the
alert bar, two native `<dialog>`s, and its own stylesheet, over nothing
but `client.js`, the plugin, and `renderLeaderboard`. `examples/chopsticks`
is the second: an existing app's design (opponent and rules pickers,
modal dialogs, an opponent-move replay driven by diffing consecutive
`view.game`s, a move-history sidebar, all over `withLocalMove`) over the
same client.

## Transport

`connectTransport()` builds a `DuelTransport` (`transport.js`) that
speaks `mo:duel-game-core/transport`'s two methods. A request is one
`duel_request` update call whose reply is this session's own fresh
status. What the other seat causes arrives by polling the `duel_poll`
query every `intervalMs` (500): the canister answers `unchanged` until
the session's revision moves, then hands over the current status.
Nothing is queued on either side, so a client always gets the latest
snapshot and may skip intermediate ones. The transport drops any view
whose revision is not newer than the last it applied, which orders a
reply against a polled view.

**Presence and goodbye.** After `pingMs` (120000) without any other
request the transport sends a `#status`, which is all the canister needs
to count the session as present. On `pagehide` it sends `#bye`, the one
goodbye the canister treats as leaving. A throttled background tab, a
sleeping laptop, a phone in another app keeps its seat; genuine absence
is the engine's claim and idle timeouts' business.

**First paint.** `queryStatus(sid)` calls the host's plain `status`
query (every host declares it, and `makeIdlFactory` includes it).
`createDuelClient` uses it when the transport offers it, so the first
screen lands in one query round trip while the first `#status`, an
update call, is still on its way; whatever the transport then delivers
supersedes it.

**The actor must sign as the session's identity** — the one that
produced `session.sid`. The backend rejects a `sid` that doesn't match
the caller's principal, and an anonymous caller outright, so never
build the agent without an identity. `resolveIdentity()`/
`resolveAnonymousIdentity()` return a matched `{ identity, principal,
sid }`. A reload is safe: each page load (and each resume) picks a new
`epoch`, and the canister ignores a `#bye` from an older one.

**Dependencies.** `transport.js` uses `@icp-sdk/core/candid` only.
`duel_poll` is an uncertified query; every mutation's reply comes from
an update call.

**No other transport.** A host built on this framework has no plain
mutating method. The client only needs the four handlers and
`send(msg)`, so a hand-rolled object of the same shape (a test mock)
can replace `DuelTransport`.

**Relinking.** Only `close()` ends a `DuelTransport`; anything the
canister forgets is redone with no `onclose`. `duel_poll` answering
`unknown` (after an upgrade, or once a lapsed link was pruned), two
failed polls in a row, or an update call that kept failing makes the
next tick send a `#status` under a new epoch, backing off up to 5 s.
`onconnecting` fires when the link is lost; `onopen` fires again on
every confirmed relink (`client.js` asks for a fresh `#status` then,
coalesced with the transport's own). Coming back — the tab visible
again, `online`, `pageshow` — ticks at once. Between `pagehide` and
`pageshow` the loop is suspended, so nothing undoes the goodbye; a
back/forward-cache restore relinks. `onerror` fires only on a second
consecutive failure, since a lone blip self-heals within a tick.

**Requests go out one at a time, in order**: two in-flight update calls
have no ordering guarantee. `send()`/`request()` are safe at any time; a
request waits its turn behind earlier ones. An update call that throws
may or may not have landed, so it is resent (after 0.5 s, then 1.5 s);
`#stale`/`#alreadySubmitted` on a resend can only mean the original
landed, and settles with a fresh `#status` instead of an error.

**Sharing one `ws`.** `DuelTransport` extends `EventTarget`; game code
can `ws.addEventListener("message", ...)` on the same transport instead
of opening a second one. `ws.send(msg)` is fire-and-forget;
`ws.request(sid, req)` returns a Promise of that exact call's `{ view }
| { err }`. See
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
by `style.css`), so live status views re-rendering `#screen` never
clobber it. `opts.yourSid` badges the caller's row ("You", `.you`);
`playerKeyOf(sid)` mirrors `Transport.playerKey`. A canister player's row shows
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
staging screen (tracked off the live status) skips the seat step;
the leaderboard's Challenge button, reachable while browsing, goes
through it.

**Rematch against a bot.** The human's Rematch stages the same table
with the seat reserved for the bot's `cp:` session. Nothing asks a bot
to accept, so the frontend remembers the last bot, complexity, and table
id of each successful `play` (in `sessionStorage`) and re-issues the
identical `play` when a `stagingYou` view for that table arrives with
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

| Module             | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idl.js`           | `makeIdlFactory(buildGameTypes)`, `buildEngineTypes({IDL, Action, State})`, `buildBotPlayIdlFactory({IDL})`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `render.js`        | `renderStatus(status, plugin, screens?)`, `renderView`, `defaultScreens`, `resolveScreens`, one `render*` per screen (`renderBrowsing`, `renderTableRow`, `renderLobby`, `renderBusy`, `renderStagingYou`, `renderAwaitingRematch`, `renderInGame`, `renderDebrief`, `renderEndedByOther`, `renderConnecting`, `renderTableBadge`), `debriefVerdict`, `opponentStatusText`, `renderLeaderboard(entries, plugin, opts?)`, `renderBotList`, `renderSeatChoice`, `playerKeyOf`, `isCanisterPlayer`, `parseCanisterPlayer`, `botDisplayName`, `displayPlayerId`, `DEFAULT_BOT_COMPLEXITY`, `errText`, `actionAttr`, `tag`, `val`, `esc` |
| `client.js`        | `createDuelClient({ ws, session, errorTtlMs? })` -> `DuelClient`; `viewTagOf`, `viewOf`, `isSeated`, `genOf`, `turnOf`, `claimRoleOf`, `oppSeatOf`, `localSecondsLeft`, `localSecondsElapsed`, `pendingKeyOf`, `pendingMoveOf`, `withLocalMove`, `deepEqual`, `tag`, `val`, `errText`                                                                                                                                                                                                                                                                                                                                               |
| `app.js`           | `start({ plugin, ws, session, screens?, confirm?, promptCode?, errorTtlMs?, ...elIds })` -> `DuelClient`; `buttonKey`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `identity.js`      | `resolveIdentity()`, `sidForPrincipal(principalText)`; depends on `@icp-sdk/auth`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `anon-identity.js` | `resolveAnonymousIdentity()`, `regenerateAnonymousIdentity()`, `sidFor(prefix, principalText)`, `ANON_SID_PREFIX`; depends only on `@icp-sdk/core/identity`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ic-env.js`        | `readIcEnv()`, `deriveHost()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `transport.js`     | `connectTransport({ actor, gameIdlTypes, intervalMs?, pingMs? })`, `DuelTransport` — serialized requests, poll loop, heartbeat, relink policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `style.css`        | generic layout primitives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

See [`../backend/README.md`](../backend/README.md) for the `Spec`
contract.
