# @research-ag/duel-game-core

Rules-agnostic browser client for any canister built on the
[`duel-game-core`](https://github.com/research-ag/duel-core/blob/main/backend/README.md) Motoko engine, in three layers a
game takes as much or as little of as it wants:

- **`client.js`, the headless client.** `createDuelClient({ transport, session })`
  owns the transport, the current `Status`, the one call in flight, error
  lifetime, the session-identity lock, and the stale-view resync, and
  publishes an immutable state snapshot to subscribers. No DOM, no HTML.
  A game with its own UI (any framework, any look) binds this and nothing
  else.
- **`render.js`, the default UI components.** Pure `view -> HTML` functions
  for every screen that is the same for every game — the multi-table
  lobby, staging, rematch offer, busy countdown, debrief chrome, the
  `#endedByOther` notice — each exported on its own, plus the leaderboard,
  bot list, and seat picker a game mounts itself (`bots.js` mounts all
  three as overlays).
- **`app.js`, the default shell.** `start({ plugin, transport, session })` wires
  the two together into `#screen`: delegated clicks, the per-button
  spinner, the local countdowns, the header controls, the error banner,
  and the confirm and access-code overlays. Any screen or overlay is
  replaceable in place (`screens`, `confirm`, `promptCode`), and `start()`
  returns the client it built.

In every layer a game supplies the same small **GamePlugin**: three
Candid types, seat labels, and how to draw the board and action buttons.

TypeScript, published pre-compiled: `npm run build` produces `dist/`,
which every import (`@research-ag/duel-game-core/app.js`, ...) resolves to. Consumers
need no build step. Dependency-free except for five documented files:
`transport.js` (`@icp-sdk/core/candid`), `identity.js`
(`@icp-sdk/auth`, `@icp-sdk/core/identity`), `anon-identity.js`
(`@icp-sdk/core/identity` only), and `bots.js` and `module-store.js`
(`@icp-sdk/core/agent`, `@icp-sdk/core/principal`).

```
npm install @research-ag/duel-game-core
```

## The GamePlugin contract

```js
const plugin = {
  // Candid types for the game's action, what a seat sees of the state
  // (the rules module's `View`), and a table's options (`IDL.Record({})`
  // for a game without any).
  idlTypes({ IDL }) {
    return {
      Action: IDL.Variant({/* ... */}),
      View: IDL.Record({/* ... */}),
      Options: IDL.Record({}),
    };
  },

  seatLabel(seat) {
    return { p1: "White", p2: "Black" }[seat];
  },

  // Board markup from `mySeat`'s point of view, from the seat's `View`.
  // Called for a live game and for a debrief's final view, and must show the opponent's most
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

  // Optional pair for a game with table options. The first choice is the
  // default; `options` is the typed value sent to `duel_create_table`
  // (the rules module's `Options`, Nat fields as bigint), `key` only
  // names the radio button. `formatOptions` labels a table's stored
  // options in the lobby listing.
  optionChoices() {
    return [
      {
        key: "classic",
        label: "Classic",
        options: { variant: { classic: null }, winsNeeded: 3n },
      },
      {
        key: "well",
        label: "Well",
        options: { variant: { well: null }, winsNeeded: 3n },
      },
    ];
  },
  formatOptions(options) {
    const variant = Object.keys(options.variant)[0];
    return `${{ classic: "Classic", well: "Well" }[variant]} · first to ${options.winsNeeded}`;
  },
};
```

Only `renderBoard`/`renderActions` return game markup. Everything else
(step counter, "opponent is deciding"/"locked in" or "Your turn"/
"Opponent's turn" for a `turnBased` table — `InGameView.toMove` says
whose, `step` counts applied actions —, verdict banner,
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
  it as an animation, or show both picks of the last round. When `View`
  carries no record of the last move, diff consecutive `game`s in the
  plugin; `examples/tic-tac-toe`, `checkers` and `chopsticks` do.
- **Your own move, at once.** A submit is a round trip, and against a
  canister bot your move's view often arrives together with the bot's
  reply. With `applyLocal`, `start()` draws the in-game screen from
  `withLocalMove(status, pending, plugin.applyLocal)` while the submit is
  out: the board with your move applied and the seat already waiting
  (for `turnBased`, `toMove` cleared and the step counter advanced). The
  reply, a later view, or a rejection (which leaves `status` untouched)
  puts the real view back in the same frame. A `simultaneous` game whose
  hidden pick changes nothing visible returns `gameState` as-is, which
  still flips the screen to "locked in". Return `null` for an action
  whose outcome only the server knows (a draw from a face-down pile).
  `applyLocal` mirrors the rules the way move highlighting does: purely
  cosmetic, never sent, and the backend still decides.

## Wiring it up

You build the `actor` (this package imports no agent and no CDN), a
`session` (required), and a `transport` over the same identity (required, no
polling mode):

```js
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { makeIdlFactory } from "@research-ag/duel-game-core/idl.js";
import { start } from "@research-ag/duel-game-core/app.js";
import { connectTransport } from "@research-ag/duel-game-core/transport.js";
import { resolveIdentity } from "@research-ag/duel-game-core/identity.js"; // or anon-identity.js
import { plugin } from "./my-game-plugin.js";

const session = await resolveIdentity();
const agent = await HttpAgent.create({ host, identity: session.identity });
const actor = Actor.createActor(makeIdlFactory(plugin.idlTypes), {
  agent,
  canisterId,
});
const transport = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });

const client = start({ plugin, transport, session });
```

`start()` returns the `DuelClient` it drives the screen with, so game code
outside the shell (a bot-challenge dialog, a stats panel) reads
`client.getState()`, subscribes, and calls `client.createTable(...)` and
friends instead of hand-building `transport.request` calls; the shell's spinner
and identity lock follow either way.

Element ids `start()` uses (all overridable, `start({ ..., sidElId })`):

```html
<span id="sid"></span>
<button id="new-sid">new</button>
<button id="duel-auth-btn"></button>
<p id="error" hidden></p>
<main id="screen"></main>
<link
  rel="stylesheet"
  href="node_modules/@research-ag/duel-game-core/style.css"
/>
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
import { debriefVerdict } from "@research-ag/duel-game-core/render.js";

start({
  plugin,
  transport,
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

| Hook                                                                                                                                         | Dispatches                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `data-create-table="p1"` + the `table-visibility` radios, `#create-code`, `table-variant` radios (one per `optionChoices()` entry, by `key`) | `createTable`                   |
| `data-join-table-id="3" data-join-table="p2"` (+ bare `data-protected` to prompt for a code)                                                 | `joinTable`                     |
| `data-act='<json>'` (via `actionAttr`)                                                                                                       | `submit`                        |
| `data-rematch`, `data-leave`, `data-reset`, `data-claim-win`, `data-ack`                                                                     | the matching call               |
| `data-confirm="Sure?"` on any of the above                                                                                                   | asks first                      |
| `id="duel-idle-warning"`, `id="duel-claim-warning"`, `id="duel-claim-button"`, `data-wait-base="12"`                                         | patched by the local countdowns |

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
} from "@research-ag/duel-game-core/client.js";

const client = createDuelClient({ transport, session });
client.subscribe((state, prev) => {
  // `state` is a fresh immutable snapshot after every change.
  render(state);
});
```

`ClientState`:

| Field            | Meaning                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`     | `"connecting"` / `"open"` / `"reconnecting"` (lost, being redone; calls queue) / `"closed"` (terminal: reload)                                             |
| `status`         | the last `Status` received (the first may be `transport.queryStatus`'s, still `"connecting"`), `null` before one; structurally equal views never re-notify |
| `statusAt`       | `Date.now()` when `status` last changed — every `secondsUntilX` is only as fresh as that; `localSecondsLeft(secs, statusAt)` counts down from it           |
| `pending`        | `{ key, req }` while one call is out (`create:p1`, `jointable:3:p2`, `act:{"pass":null}`, `rematch`, `leave`, `reset`, `claim-win`, `ack`); at most one    |
| `error`          | a transient message (cleared after `errorTtlMs`), or the permanent "Connection closed."                                                                    |
| `authPending`    | a login/logout/regenerate is under way                                                                                                                     |
| `identityLocked` | disable "new sid" and login/logout: seated, a join in flight, an identity change in flight, or closed                                                      |

Actions: `createTable(seat, visibility?, options?)` (`options` is the
game's typed `Options`, `{}` by default), `joinTable(id, seat, code?)`,
`submit(move)`, `rematch()`, `leave()`, `reset()`, `claimWin()`,
`ackEnded()`. Each stamps `gen`/`step` from the last status and resolves
with a `CallOutcome`: `{ ok: true, view }`, or `{ ok: false, reason }`
where `reason` is `"inFlight"` (one is already out), `"closed"`,
`"stale"` (a `#wrongPhase` create/join or `#stale` mutation: the view was
behind, a silent `refresh()` is on its way), `"rejected"` (`err` and its
`message`, also shown in `state.error`), or `"failed"` (transport,
`message`). A `"rejected"` or `"failed"` call also sends a `refresh()`,
so a screen the server has moved past (the table is gone, the seat was
lost) is replaced by the real status. When the first status after a
reconnect finds a player who was seated back in the lobby,
`state.error` says so (`ENDED_WHILE_AWAY_MESSAGE`). `refresh()` is a
resync by query. `showError`/`clearError` put a
UI's own messages on the same lifetime. `login()`, `logout()`,
`regenerateSid()` wrap the session's own functions and drive
`authPending`. `dispose()` detaches from `transport`.

Selectors, all pure: `viewTagOf(status)`, `viewOf(status, "inGame")`,
`isSeated`, `genOf`, `stepOf`, `claimRoleOf(inGame)` (`"waiting"` may
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

**Naming.** The link is `transport` everywhere: `start({ plugin,
transport, session })`, `createDuelClient({ transport, session })`, and
the `Transport` / `TransportRequest` / `TransportPayload` types. (These
replaced `ws`, `DuelWs`, `WsRequest` and `WsPayload` from the WebSocket
era; the old names are gone, so a game written against them must be
renamed.)

`connectTransport()` builds a `DuelTransport` (`transport.js`) that
speaks `mo:duel-game-core/transport`'s methods; [`DESIGN.md`](https://github.com/research-ag/duel-core/blob/main/DESIGN.md)
has the flows as diagrams. The caller's principal is the player; the
`sid` the client passes around is only this tab's label for it.

**Following one source.** Every read is a query. The transport follows
the lobby (`duel_lobby(rev)`) or one table (`duel_table(id, rev)`) —
the newest of the caller's own tables (`yours`) when there is one — and
composes what it sees into the `Status` a client renders:
`{ browsing: { tables } }` or `{ atTable: { id, view } }`. Each source
answers `unchanged` while the `rev` asked with is current, so polling an
idle table every `intervalMs` (500) costs one comparison on the
canister. It goes back to the lobby when its table is `gone` or shows
the caller an outsider's view (`lobby`/`busy`), and moves to a table
when the lobby lists one in `yours`. A view not newer than the last
applied from the same source is dropped, which orders a reply against a
polled view. Nothing is queued on either side, so a client always gets
the latest snapshot and may skip intermediate ones.

**Requests.** A move is one `duel_submit` update whose reply is the
table's fresh view. Every other mutation (`createTable`, `joinTable`,
`rematch`, `leave`, `reset`, `claimWin`, `ackEnded`) is an update
replying with an `Ack` — the table and its `rev` after the call; the
transport follows that table and polls until its view has caught up
(a replica answering the query may lag the update briefly). Table
requests go to the table the transport follows when they are made, and a
resend goes to the same one. A table request with no table followed is
`#notSeated` without a call. `#status` is a resync by query: the lobby,
then the caller's newest table.

**Polls.** A poll unanswered after `pollTimeoutMs` (3000) counts as a
failed one and the loop asks again, so a query the gateway never
answers costs one retry instead of freezing the loop. Its answer still
applies if it arrives late, which keeps a slow link from reading as a
lost one. At most three polls are ever unanswered at once; past that
the loop waits on the newest.

**Keep-alive.** While the shown view is `stagingYou` (waiting at a table
for an opponent), the transport sends `duel_keep_alive()` every
`keepAliveMs` (20000); without it the canister's sweep clears the table
about a minute after the tab is gone. Nothing else needs presence:
there is no goodbye, and a closed tab, a throttled background tab, a
sleeping laptop, a phone in another app all keep their seat in a game.
A player who comes back with the same key continues where they were.
Genuine absence in a game is the engine's claim and idle timeouts'
business; the only explicit departure is the player's own `leave`.

**First paint.** `queryStatus(sid)` composes the status from the same
two queries without touching the link. `createDuelClient` uses it, so
the first screen lands in one or two query round trips; whatever the
transport then delivers supersedes it.

**The actor must sign as the player's identity** — the one that
produced `session.sid`. The canister refuses the anonymous principal,
so never build the agent without an identity. `resolveIdentity()`/
`resolveAnonymousIdentity()` return a matched `{ identity, principal,
sid }`. A reload is safe: the same key is the same player.

**Dependencies.** `transport.js` uses `@icp-sdk/core/candid` only.
`duel_lobby`/`duel_table` are uncertified queries; every mutation's
reply comes from an update call.

**No other transport.** A host built on this framework has no plain
mutating method. The client only needs the four handlers and
`send(msg)`, so a hand-rolled object of the same shape (a test mock)
can replace `DuelTransport`.

**Relinking.** Only `close()` ends a `DuelTransport`. Two failed polls
in a row, or an update call that kept failing, presume the link lost:
`onconnecting` fires and the next tick resyncs, backing off up to 5 s.
`onopen` fires again on every confirmed relink (`client.js` asks for a
fresh `#status` then, coalesced with the transport's own). Coming back
— the tab visible again, `online`, `pageshow` — ticks at once.
`onerror` fires only on a second consecutive failure, since a lone blip
self-heals within a tick.

**Requests go out one at a time, in order**: two in-flight update calls
have no ordering guarantee. `send()`/`request()` are safe at any time; a
request waits its turn behind earlier ones. An update call that throws
may or may not have landed, so it is resent (after 0.5 s, then 1.5 s);
`#stale`/`#alreadySubmitted` on a resend can only mean the original
landed, and settles with a resync instead of an error.

**Sharing one `transport`.** `DuelTransport` extends `EventTarget`; game code
can `transport.addEventListener("message", ...)` on the same transport instead
of opening a second one. `transport.send(msg)` is fire-and-forget;
`transport.request(sid, req)` returns a Promise of that exact call's `{ view }
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
- Takes an optional `identityProvider: { authorizeUrl, canisterId }`
  (both or neither; omitted means mainnet Internet Identity), e.g. for a
  local Internet Identity.
- Returns `login()`/`logout()` (each reloads the page) and `regenerate()`
  (anonymous only; discards the keypair and reloads). Identity changes
  always take effect by reload — nothing rebuilds actor/transport in place.

Both kinds sit at the same tables; the engine only compares session ids
for equality, and the transport binds every legal sid to a principal.

## Bots and the leaderboard

A host wiring canister players and a leaderboard exposes `list_bots()`
and `get_leaderboard()`, plain queries `idl.js` declares on every actor.
A bot is seated by calling its own canister's `play(host, tableId, seat,
code, complexity)`, which joins the open seat as the bot's `cp:` player;
nothing goes through the transport. `bots.js` does all of it.

**The default overlays.** For a game on `start()`:

```js
import {
  botPlayer,
  mountBotChallenge,
  mountLeaderboard,
} from "@research-ag/duel-game-core/bots.js";

const client = start({ plugin, transport, session });
const bots = mountBotChallenge({
  client,
  actor,
  plugin,
  play: botPlayer(agent, canisterId),
});
mountLeaderboard({ actor, plugin, sid: session.sid, onChallenge: bots.pick });
```

with this markup next to `#screen` (styled by `style.css`):

```html
<!-- in .session, first -->
<button id="leaderboard-toggle" title="Leaderboard" aria-label="Leaderboard">
  🏆
</button>

<div id="leaderboard-panel" hidden>
  <div class="leaderboard-header">
    <button id="leaderboard-back" class="ghost">← Back</button>
    <h2>🏆 Top players</h2>
  </div>
  <div id="leaderboard-body" class="leaderboard-list"></div>
</div>

<div id="bot-challenge-panel" hidden>
  <div class="bot-challenge-header">
    <button id="bot-challenge-back" class="ghost">← Back</button>
    <h2>🤖 Bots</h2>
  </div>
  <div id="bot-challenge-body" class="bot-challenge-body"></div>
</div>

<!-- after #screen -->
<div id="bot-add-panel" hidden>
  <button id="bot-add-trigger" class="ghost">
    Add Bot 🤖 to the open seat
  </button>
</div>
```

- `mountBotChallenge` shows "Add Bot" only while this session waits at
  its own table; it opens the bot list (`renderBotList`), and a
  Challenge there fills that table's open seat. `bots.pick(bot)` is the
  same entry from elsewhere: while not waiting, it first asks for a seat
  (`renderSeatChoice`), then creates an open table through
  `client.createTable` with the plugin's first `optionChoices()` entry
  (`options` overrides it). The panel shows "Inviting <bot>…" and the
  bot's error, if any, worded as the bot's (`botErrText`: a bot at its
  own table cap is "already playing N games"). `bots.open()` shows the
  list from any other control (a header 🤖 button).
- `mountLeaderboard` fetches on every open and renders
  `renderLeaderboard(entries, plugin, { yourSid, botNames })`; a bot
  row's Challenge closes it and calls `onChallenge`. Leave `onChallenge`
  out (and `list_bots` off `actor`) for a game without bots.
- Every element id is overridable (`ids: { panel, body, back, addPanel,
addTrigger }` and `ids: { toggle, panel, body, back }`); only each
  panel and body are required.

**Rematch against a bot.** The human's Rematch stages the same table
with the seat reserved for the bot's `cp:` player, and nothing asks a
bot to accept. The inviter remembers the last bot it seated and its
table (`sessionStorage`, `storageKey` `"duel-last-bot"`) and re-issues
the same `play` once per `stagingYou` with `reservedForPartner` on that
table (per `gen`); the memory clears the moment the status is anywhere
but that table.

**A UI of its own.** `createBotInviter({ client, play, options?,
storage?, storageKey? })` is the same logic without DOM: `challenge(bot,
seat?)` (resolves `true` once the bot joined), and a subscribable
`{ staging, inviting, error }`. `botRefOf(clickTarget)` reads the
`data-challenge-bot`/`data-bot-name`/`data-bot-complexity` attributes
`renderBotList` and `renderLeaderboard` put on their Challenge buttons,
and `stagingOf(status)` is this session's waiting table. See
`examples/007/frontend/src/app.js`.

**The pieces.** `renderBotList(bots, plugin)` renders one row per bot
AND complexity, in declared order, `"<name> (<complexity>)"`, with that
complexity's `elo` (via `plugin.formatScore`; blank without a
leaderboard). `renderLeaderboard` badges the caller's row ("You",
`.you`; `playerKeyOf(sid)` mirrors `Transport.playerKey`) and shows a
canister player's row as 🤖 `"<name or principal> (<complexity>)"`,
with the raw key in `title` (`isCanisterPlayer`, `parseCanisterPlayer`,
`botDisplayName`, `displayPlayerId`, `DEFAULT_BOT_COMPLEXITY` are
exported). `botPlayer(agent, backendId)` calls `play` through
`buildBotPlayIdlFactory`, on the principal from `list_bots()`, never an
env var.

## Optional: `ic-env.js`

`deriveHost()` picks the agent host for the current location
(localhost, the parent domain on icp0.io/ic0.app, the page's own origin
on icp.net, `icp-api.io` as a last resort). `start()` never calls it. For the `ic_env` cookie the frontend canister
sets (canister ids, root key), use `safeGetCanisterEnv()` from
`@icp-sdk/core/agent/canister-env`.

## Fetching a game's module

`module-store.js` gets the exact wasm a game canister runs, for a local
copy to build a frontend or a bot against:

```js
import {
  fetchGameModule,
  rawWasm,
} from "@research-ag/duel-game-core/module-store.js";

const mod = await fetchGameModule(backendId); // { hash, bytes, gzipped }
const wasm = await rawWasm(mod); // gunzipped only if stored gzipped
```

1. `readModuleHash(canisterId, agent?)` reads `canister/<id>/module_hash`
   from the IC state tree with `HttpAgent.readState`, which verifies the
   certificate against the root key (a mainnet agent on
   `https://icp-api.io` unless one is passed). No module: an error.
2. The bytes come from hosty.live's public module store,
   `GET https://api.hosty.live/modules/<hash>`. Every module hosty.live
   installs is stored there first, keyed by the hex SHA-256 of the
   module exactly as installed (of the gzipped bytes for a gzipped
   module), which is the IC's `module_hash`.
3. The SHA-256 of the body must equal that hash, or the call rejects;
   so does a module the store does not have (404). `gzipped` is read off
   the verified bytes.

The store sends every module as stored (`application/wasm`, or
`application/gzip` for a gzipped one, never with a `Content-Encoding`),
so the default `fetch` download receives the hashed bytes in browsers
and in Node alike. A body that a proxy decoded on the way no longer
hashes to its key and is rejected. A runtime without `fetch` passes its
own `download` option.

`moduleMeta(hash)` reads `GET /modules/<hash>/meta` (`size`, `gzipped`,
`verified`, `candid`). The store deletes an unverified module after 24
hours; `requestVerification(hash, canisterId)` (`POST
/modules/<hash>/verify`) asks hosty.live to re-read the canister's
module hash and keep the module when it matches.

## Modules

| Module             | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idl.js`           | `makeIdlFactory(buildGameTypes)`, `buildEngineTypes({IDL, Action, View, Options})`, `buildBotPlayIdlFactory({IDL})`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `render.js`        | `renderStatus(status, plugin, screens?)`, `renderView`, `defaultScreens`, `resolveScreens`, one `render*` per screen (`renderBrowsing`, `renderTableRow`, `renderLobby`, `renderBusy`, `renderStagingYou`, `renderAwaitingRematch`, `renderInGame`, `renderDebrief`, `renderEndedByOther`, `renderConnecting`, `renderTableBadge`), `debriefVerdict`, `opponentStatusText`, `renderLeaderboard(entries, plugin, opts?)`, `renderBotList`, `renderSeatChoice`, `playerKeyOf`, `isCanisterPlayer`, `parseCanisterPlayer`, `botDisplayName`, `displayPlayerId`, `DEFAULT_BOT_COMPLEXITY`, `errText`, `actionAttr`, `tag`, `val`, `esc` |
| `client.js`        | `createDuelClient({ transport, session, errorTtlMs? })` -> `DuelClient`; `viewTagOf`, `viewOf`, `isSeated`, `genOf`, `stepOf`, `claimRoleOf`, `oppSeatOf`, `localSecondsLeft`, `localSecondsElapsed`, `pendingKeyOf`, `pendingMoveOf`, `withLocalMove`, `deepEqual`, `tag`, `val`, `errText`                                                                                                                                                                                                                                                                                                                                        |
| `app.js`           | `start({ plugin, transport, session, screens?, confirm?, promptCode?, errorTtlMs?, ...elIds })` -> `DuelClient`; `buttonKey`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `identity.js`      | `resolveIdentity()`, `sidForPrincipal(principalText)`; depends on `@icp-sdk/auth`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `anon-identity.js` | `resolveAnonymousIdentity()`, `regenerateAnonymousIdentity()`, `sidFor(prefix, principalText)`, `ANON_SID_PREFIX`; depends only on `@icp-sdk/core/identity`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ic-env.js`        | `deriveHost()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `bots.js`          | `mountBotChallenge(opts)` -> `BotChallenge`, `mountLeaderboard(opts)`, `createBotInviter(opts)` -> `BotInviter`, `botPlayer(agent, backendId)`, `botRefOf`, `stagingOf`, `botErrText`; depends on `@icp-sdk/core/agent`, `@icp-sdk/core/principal`                                                                                                                                                                                                                                                                                                                                                                                  |
| `module-store.js`  | `fetchGameModule(canisterId, { agent?, readModuleHash?, download? })` -> `{ hash, bytes, gzipped }`, `readModuleHash`, `moduleMeta`, `requestVerification`, `rawWasm`, `sha256Hex`, `isGzip`, `fetchDownload`, `MODULE_STORE`; depends on `@icp-sdk/core/agent`                                                                                                                                                                                                                                                                                                                                                                     |
| `transport.js`     | `connectTransport({ actor, gameIdlTypes, intervalMs?, keepAliveMs?, pollTimeoutMs? })`, `DuelTransport` — lobby/table queries, serialized requests, keep-alive, relink policy                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `style.css`        | generic layout primitives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

See [`backend/README.md`](https://github.com/research-ag/duel-core/blob/main/backend/README.md) for the `Spec`
contract.
