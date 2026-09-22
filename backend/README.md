# duel-game-core for Motoko

## Overview

A generic 2-player multi-table lobby session engine for the Internet
Computer. It solves the plumbing every simultaneous-reveal, turn-based
2-player game needs — and knows nothing about any particular game's
rules:

- **Tables** — anyone may open a new table: `#open` (joinable outright by
  anyone browsing the lobby) or protected with an access code shared with
  a friend out of band. Both are discoverable through the same browsable
  table list — a protected table just flagged as such, so a visitor knows
  a code is needed (and who, if anyone, already holds a seat) before
  attempting to join it. Any number of tables run independently and
  simultaneously; a shared `Registry` creates them and routes every
  session's calls to the right one.
- **Seating** — two players join a table (seats `#p1` / `#p2`); a third
  caller is turned away while a match is in progress on it.
- **Rounds** — a `#simultaneous` game has each seated player submit one
  move per round; once both are in, the game's own `resolve` function
  runs and either continues the game or ends it with a verdict. An
  `#alternating` game instead resolves the instant the one seat
  currently on turn submits their move — there's no second move to wait
  on (see "Design" below for both modes).
- **Debrief** — a finished game puts BOTH players in a debrief (win /
  lose / draw), with the final game state attached.
- **Early leave** — a player may leave mid-game; both players get a
  shared `#aborted` debrief instead of the game silently vanishing.
- **Rematch** — from the debrief, either player can request a rematch,
  reusing the SAME table; two simultaneous rematch clicks converge
  race-free (see Design). Leaving a debrief dismisses it for you
  specifically: your own `status` stops showing it (and `joinTable`/
  `rematch` stop treating you as one of its two participants) right
  away, even though the underlying table can legitimately linger in that
  debrief until your partner also leaves (or it expires) — their own
  rematch option isn't cut short by your exit. Requesting a rematch
  against a partner who already left doesn't reserve a seat for them
  either — that seat opens immediately, since nobody's coming back to
  accept it. And the reserved partner isn't limited to accepting or
  waiting it out: `leave` while looking at `#awaitingRematch` declines
  it, freeing just the reservation (the requester's own staging survives,
  now open to anyone).
- **Idle takeover** — after a configurable timeout, third parties may
  reclaim a squatted staging seat, reset a dead game, or start fresh over
  an expired debrief — discoverable through the browsable table list
  the same as any other joinable table. No table is occupied forever by
  a player who vanished, and a table nobody ever revisits is eventually
  garbage-collected — including pruning any `#endedByOther` notice nobody
  plausibly still owes a look at, so a participant who's never coming
  back to acknowledge one can't pin that table's id in the registry
  forever — so ids don't accumulate without bound.
- **Claim a win** — once your own move has sat pending against your
  opponent's silence for longer than a second, independent, much shorter
  timeout (`claimTimeoutNs`), you may optionally claim the win outright
  instead of waiting them out — never automatic, and never at the expense
  of giving them more time if you'd rather.
- **Status views** — every caller gets one truthful, per-caller
  `SessionStatus`: either the browsable table list, or a specific table's
  own `View` — including a proactive `#endedByOther` notice when their
  game was ripped out from under them by an idle takeover.

It does **not** know how to play any game — that's entirely up to you.
Pair it with [`duel-game-core` for npm](../frontend/README.md), the
matching client plumbing.

### Links

Not yet published. Once it ships, this package will be on
[MOPS](https://mops.one/duel-game-core) and GitHub, with generated API
docs linked from the MOPS listing.

### Motivation

Every 2-player game backend ends up re-solving the same handful of hard,
game-independent problems: how players find and claim a seat, how one
player's move becomes visible to the other, what happens when a player
disconnects mid-game or never comes back, how a rematch avoids stranding
one player if both click "play again" at once, and how to avoid either a
game that never lets go of the table or a client that can bypass its own
UI to cheat. Those problems are identical whether the game is chess, a
duel, or something not yet imagined — only `init`/`validate`/`resolve`
differ. This package implements the shared half once, as a pure state
machine, so a new game only has to supply the rules.

### Interface

The engine is built around two type parameters a game supplies: `S`
(game state) and `M` (one player's move). Its shared type surface —
`Spec`, `Seat`, `Phase`, `View`, `Err`, `Res`, `Table`, `Registry`, and
everything else below — lives in `src/types.mo` and is re-exported by
`src/lib.mo` (`mo:duel-game-core`, no subpath) so a host actor can name
all of them off one import. The two layers of actual operations are
separate sibling modules, both built on those same types:

- `Spec<S, M>` — the three pure functions a game implements: `init`,
  `validate`, `resolve` (see Design). Tagged by `Mode`
  (`#simultaneous`/`#alternating`) — a game builds exactly one arm,
  `#simultaneous { init; validate; resolve }` (both seats act every
  round — `resolve` takes both moves; the common case) or
  `#alternating { init; validate; resolve }` (seats take turns —
  `resolve` takes just the one seat on turn and their move). See
  Design's "Alternating-turn games" section.
- `src/table.mo` (`mo:duel-game-core/table`) — `Table<S, M>`, the stable
  session state for ONE board, and the low-level primitive `Registry`
  (below) is built from: `Table.new(idleTimeoutNs, claimTimeoutNs,
visibility, createdBy)` plus `join`/`submit`/`rematch`/`leave`/`reset`/
  `claimWin`/`ackEnded`/`status`/`sweep` on the table it returns (Motoko
  dot-notation call sugar — plain functions taking the table as their
  first argument). A game that genuinely wants exactly one fixed board
  with no lobby of its own can use this directly instead of `Registry`.
- `src/registry.mo` (`mo:duel-game-core/registry`) — `Registry<S, M>`,
  the stable multi-table registry: created once per host actor with
  `Registry.new(idleTimeoutNs, claimTimeoutNs)`. `createTable`/
  `listTables`/`joinTable` create, discover, and join a specific table;
  `submit`/`rematch`/`leave`/`reset`/`claimWin`/`ackEnded`/`status`
  resolve the caller's own current table (via a `SessionId -> TableId`
  mapping the registry keeps) and delegate straight into the matching
  `Table` operation above — no game logic is reimplemented at this
  layer. `sweep` idle-evicts and garbage-collects across every table.
  `attachMetrics(pt : PT.Tracker)`, from `mo:promtracker`, is a separate,
  entirely optional call some time after `Registry.new` — see "Metrics"
  below.
- Eight per-table operations, on either `Table<S, M>` or `Registry<S,
M>`: `join`/`createTable`+`joinTable`, `submit`, `rematch`, `leave`,
  `reset`, `claimWin`, `ackEnded`, `status` (plus `sweep`, not
  caller-facing). Every one that can mutate takes `spec` and the current
  time (`now : Int`, nanoseconds) as explicit parameters — see
  Implementation notes. At the
  `Registry` layer, every mutating operation is called ONLY from inside
  `mo:duel-game-core/ws`'s `ws_message` dispatch — they are not, and
  must not be, exposed as plain Candid methods on a host actor (see
  "Real-time push" below for why). `status` is the exception: it stays a
  plain public `query` too, since it's side-effect-free and carries no
  race risk.
- `View<S>` — one table's own per-caller screen: exactly one of `#lobby`,
  `#busy`, `#stagingYou`, `#awaitingRematch`, `#inGame`, `#debrief`,
  `#endedByOther`. `SessionStatus<S>` wraps it for the multi-table case:
  either `#browsing { tables : [TableSummary] }` (not currently at any
  table) or `#atTable { id : TableId; view : View<S> }`.

## Usage

### Install with mops

You need `mops` installed. In your project directory run:

```
mops add duel-game-core
```

(Unpublished: add it as a local/git path dependency in `mops.toml` until
it ships to mops.one.)

In the Motoko source file import the package as:

```motoko
import TP "mo:duel-game-core";

```

### Example

A game is a pure `Spec<S, M>`, tagged by `Mode`:

```motoko
public type Spec<S, M> = {
  #simultaneous : {
    init : () -> S;
    validate : (S, Seat, M) -> ?Text; // null = legal; ?text = rejection
    resolve : (S, M, M) -> { state : S; verdict : ?Verdict }; // both moves at once
  };
  #alternating : {
    init : () -> S;
    validate : (S, Seat, M) -> ?Text;
    resolve : (S, Seat, M) -> { state : S; verdict : ?Verdict }; // one seat, on turn
  };
};

```

A game builds exactly one arm — see "Alternating-turn games" under
Design for the `#alternating` case.

A host actor forwards every call to the engine, supplying `Time.now()`
and your `Spec` — but only `status` is a plain Candid method. Everything
that can mutate state (`createTable`/`joinTable`/`submit`/`rematch`/
`leave`/`reset`/`claimWin`/`ackEnded`) is driven exclusively through
`mo:duel-game-core/ws`'s `ws_message`, wired alongside `status` in the
SAME actor — there is no plain Candid method for any of them, and no
fallback: see "Real-time push" below for why, and for the idle-sweep
timer that also belongs in this actor. A minimal host actor's non-WS
half:

```motoko
import TP "mo:duel-game-core";
import Registry "mo:duel-game-core/registry";
import Rules "YourGameRules"; // your module, implementing TP.Spec<S, M>
import Time "mo:core/Time";
import Timer "mo:core/Timer";

persistent actor {
  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new(60_000_000_000, 15_000_000_000); // 60s idle timeout, 15s claim-win window, shared by every table

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Rules.spec(), Time.now(), sid);
  };

  // Frees every abandoned table on its own — with only 2 players per
  // table, there's often nobody left to visit an idle one and trigger
  // the lazy, visitor-driven eviction `joinTable`/`reset` already do.
  // This bare top-level call reruns automatically on every upgrade too
  // (no `postupgrade` override needed), so the timer never stays dead
  // after one.
  func startSweeping<system>() {
    ignore Timer.recurringTimer<system>(
      #seconds(30),
      func() : async () {
        registry.sweep(Time.now());
      },
    );
  };
  startSweeping<system>();

  // ...wire mo:duel-game-core/ws here — see "Real-time push" below for
  // the full `ActorMixin` wiring (all four `ws_*` methods plus this same
  // idle-sweep timer, in one `include`), which is what actually drives
  // createTable/joinTable/submit/rematch/leave/reset/claimWin/ackEnded.
};

```

`Registry<S, M>` (and the `Table<S, M>` it's built from) is a
stable type whenever `S` and `M` are stable types — the `Spec`
(functions) is passed on every call and never stored, so the engine
survives canister upgrades with no migration code.

From there, generate (or hand-write) the Candid interface for this
service and pair it with a **GamePlugin** on the frontend — see
[`../frontend/README.md`](../frontend/README.md).

### Real-time push

Every game on this engine is driven by `duel-game-core/ws.js` on the
frontend — a `GatewayWs` that speaks this section's protocol directly
against your canister's `ws_*` Candid methods, the ONLY way a client can
mutate game state (see that package's README for the frontend half in
full; `ws` is required, there's no plain-polling fallback). A direct
update call bypassing this transport is exactly the race it exists to
close: two independent update calls have no guaranteed relative
processing order once both are in flight, so a plain `submit` racing
this transport's own traffic could resolve out of order against it —
which is why `createTable`/`joinTable`/`submit`/`rematch`/`leave`/
`reset`/`claimWin`/`ackEnded` are not exposed as plain Candid methods at
all, only reachable via `ws_message`.

`src/ws.mo` — imported separately as `mo:duel-game-core/ws`, never merged
into the engine itself — is built on
[`ic-websocket-cdk`](https://github.com/omnia-network/ic-websocket-cdk-mo)
(mops). The IC has no native WebSocket support; `ic-websocket-cdk`'s
normal deployment shape has the browser open a real WebSocket to an
off-chain relay, the **WS Gateway**, which polls the canister's
`ws_get_messages` and relays both directions. This repo runs it
differently, and deliberately: `ic-websocket-cdk` doesn't require a
pre-registered Gateway principal — a client's own `ws_open` call
supplies whichever principal it wants registered as its
`gateway_principal`, and the CDK accepts that dynamically (see
`ic-websocket-cdk-mo`'s `State.mo`, `REGISTERED_GATEWAYS`) — so
`duel-game-core/ws.js`'s `GatewayWs` has each browser tab register
**itself** as its own Gateway and poll its own messages, exactly as a
real Gateway process would poll on a client's behalf. No relay process
to run, no `ic-websocket-js` dependency, no second signing identity — a
genuinely separate relay process buys nothing a 2-player casual game
actually needs. That CDK's last upstream release (`0.4.1`, Oct 2024)
predates this repo, so it's vendored here at
`backend/src/ic-websocket-cdk/src` rather than pulled from the mops
registry — which also let it be migrated in place from `mo:base` to
`mo:core` (this package's own code never uses `mo:base` — see the root
`CLAUDE.md`'s toolchain rule), so it no longer carries that legacy
dependency itself. It does still depend on the third-party
`ic-certification` mops package for its Merkle certification tree, and
that package's own code still uses `mo:base` internally — genuinely
outside this repo's control, unlike the vendored CDK. Keeping the CDK
confined to `ws.mo` means a host actor that never imports
`mo:duel-game-core/ws` never compiles any of that in; `src/lib.mo` stays
exactly as pure as the architecture rules require.

**Disappearance handling.** Real WS close detection is exactly what
makes it possible for the backend to tell a genuinely vanished player
apart from one merely thinking — `attach()`'s `onClose` (see `ws.mo`)
drives an implicit `Registry.leave` on behalf of whichever session's
connection just closed, whether that close was the client's own
cooperative goodbye or the CDK's internal keep-alive timeout catching an
involuntary disappearance (crash, force-quit, network drop): a live game
someone vanished from ends in a shared debrief instead of leaving the
opponent staring at a move that's never coming, and if the OTHER
participant is also found disconnected at that point, their side of the
same debrief is acked too, freeing the table immediately instead of it
sitting occupied with nobody left to poll it free. The CDK's keep-alive
timeout is fixed at 60s (not configurable via `WsInitParams`), so an
involuntary disappearance has a real detection floor of roughly
60-120s depending on where in the ack cycle it happens — not instant,
but bounded, and independent of `Registry.sweep` (see `src/registry.mo`),
which stays in place underneath this as a second, timeout-based
backstop for anything that reaches the engine outside this transport at
all (e.g. a canister upgrade dropping every live connection until
browsers reconnect on their own).

**Push overhead.** Internally, `attach()`'s push helpers
(`pushTo`/`pushStatus`/`afterMutation`, plus `finishClose`/
`sweepAndPush`) are `async*`/`await*`, not plain `async`/`await` — only
`pushTo`'s own call into `IcWebSocketCdk.send` is a genuine send; the
rest are thin fan-out/dispatch wrappers around it with nothing to await
themselves. On the IC, a plain `async` call is its own message with its
own commit point regardless of whether it suspends, so e.g. broadcasting
to both seats of an `#active` game would otherwise cost two extra round
trips through the scheduler on top of the one real send. `async*`/
`await*` inlines a wrapper into its caller's own async state machine
instead of starting a new one, so the whole dispatch tree down to
`pushTo`'s single real `await` compiles to one message, not one per
wrapper — same number of genuine sends, far fewer commit points and
continuation-closure allocations. `disconnectSession` goes further still
and isn't `async` at all: it only calls `Registry.leave` (synchronous
engine code), so there's no async state machine to build. See `ws.mo`'s
own comments on `Attached`/`pushTo` before "fixing" one of these back to
plain `async`/`await` for readability — it silently reintroduces that
per-wrapper overhead.

**The wire protocol.** `ic-websocket-js` requires ONE application-message
type shared by both directions (it reads the type straight off the
canister's `ws_message` method's second Candid parameter at runtime) — so
`Ws.Msg<S, M>` is a variant covering client→canister requests
(`#req { sid; req; reqId }`, where `req` mirrors `Registry`'s own
mutating operations plus an explicit `#status` resync) AND
canister→client pushes (`#view { reqId; view }` / `#err { reqId; err }`),
not two separate types — `view` here is a `TP.SessionStatus<S>`, not a
bare `View<S>`, since a push has to say WHICH table (if any) it's about.
Every mutating request re-uses `registry.mo`'s own operations
(`createTable`, `joinTable`, `submit`, ...) directly — `ws.mo`
reimplements no game logic or table routing, and these are the ONLY
place those operations are ever called from a host actor, since none of
them is exposed as a plain Candid method — and, after each one, pushes a
fresh status to whoever needs to see it changed: the affected table's
own current occupants (once a match has two fixed seats, `#active`/
`#debrief`, that's read directly off the table's own `p1`/`p2` fields —
plus a `#staging` rematch reservation's own named partner, so an
invitation reaches them proactively — so a connection routinely receives
a push it never asked for whenever the OTHER seat, or a rematch partner,
is the one who acted) and, whenever the open-table list itself might
have changed (a table created, filled, freed, or garbage-collected),
every OTHER session `Hub` currently knows is connected AND isn't
currently at any table (see below). Either way, a client can receive a
status it never requested. `reqId` is an opaque token the CLIENT makes
up for a `#req` it wants correlated to its own reply; `ws.mo` only ever
echoes it straight back on that SAME session's own push, never
inspecting or generating it — a push to anyone else always carries
`reqId = null`, since it's a broadcast, not a reply to anything they
asked. This exists because, without it, a client has no way to tell "the
reply to my own request" apart from "an unrelated broadcast that
happened to arrive around the same time" — a real bug this closes: a
client-side FIFO match-next-message-to-oldest-pending-request scheme let
an opponent's broadcast steal the slot meant for this connection's own
reply, silently hanging the real one forever. `Hub` is the other half of
the bridge: the engine's identity is a client-chosen `SessionId`
(`Text`), decoupled from any IC principal by default, but a WebSocket
connection is keyed by principal — `Hub` learns the `sid <-> principal`
pairing from the `sid` every inbound message carries, and forgets it on
`ws_close`.

**Player identity: anonymous and logged-in players, treated equally, both
non-spoofable.** `Table`/`Registry` never look at a `SessionId` beyond
comparing it for equality, so an anonymous player (today's default — no
login required) and a real, permanently identified player (someone who
logged in via Internet Identity) sit at the very same tables with no
special-casing anywhere in the engine. Both are non-spoofable, though: `Ws`
is the layer bridging `sid` to a caller's authenticated principal, and it
recognizes two reserved `sid` namespaces, each a pure, permanent function of
a principal — `Ws.sidFor(prefix, p) = prefix # Principal.toText(p)`.
`Ws.PRINCIPAL_SID_PREFIX` (`"ii:"`) is a real Internet Identity login;
`Ws.ANON_SID_PREFIX` (`"an:"`) is a locally generated keypair a frontend
persists on its own, with no login step at all — either way the id is
"issued" for free the moment the principal is first seen (nothing to
allocate or store) and can never change for as long as the same
keypair/login keeps resolving to the same principal. `onMessage` rejects
any inbound `sid` whose principal doesn't match the connection's own
`args.client_principal` under its own namespace's scheme — or that names no
recognized namespace at all — with `Err.#unauthorized`, before the request
ever reaches `Hub` or `Registry`. There is no third, client-asserted tier:
every legal `sid` is principal-bound. See `../frontend/README.md`'s
"Logging in with Internet Identity" section for the matching frontend half
(`duel-game-core/identity.js`'s `resolveAnonymousIdentity()`/
`resolveIdentity()`, which compute the identical `sidFor` values).

**Replay safety.** `#submit`/`#leave`/`#reset`/`#claimWin` each carry a
`gen : Nat` (and `#submit` additionally a `turn : Nat`) — the match
generation (and,
for submit, round number) the client last saw in a `View`. A client can't
always tell whether a mutating call it believes failed (a dropped
connection, a decode error) actually reached `ws.mo`'s `onMessage` —
`ws/gateway-client.ts`'s resend queue exists to retry exactly that
ambiguous case — so without this, a resent `submit` whose original copy
secretly already resolved the round (or ended the match) would be
silently replayed against whatever round/match is current by the time the
resend lands, and a resent `leave`/`reset` could silently abort a
brand-new match the SAME session later started (typically a same-partner
rematch) instead of the one it actually meant to end. `Registry.submit`/
`leave`/`reset`/`claimWin` reject a mismatch as `Err.#stale` instead of
applying it;
the client's fix is always the same regardless of cause — refetch
`status` (or just look at the next pushed status) and act on the real,
current one. `#createTable`/`#joinTable`/`#rematch`/`#ackEnded` carry no
such binding: each already recomputes its effect from live state
(current partner, current seat availability, current debrief membership)
rather than applying a stale payload, so a replay of any of them is
already either a no-op or a pre-existing, harmless error — see `lib.mo`'s
doc-header guarantee 6 for the full reasoning.

**Wiring it into a host actor** — extending the example above:

```motoko
import Ws "mo:duel-game-core/ws";
import ActorMixin "mo:duel-game-core/actor_mixin";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";

persistent actor {
  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new(60_000_000_000, 15_000_000_000);

  // ...`status` from the example above, unchanged...

  // `IcWebSocketCdk.IcWebSocket` holds live connections/closures — not a
  // stable type. `transient` rebuilds it fresh on every upgrade; no game
  // state is lost, since `registry` is untouched by any of this and
  // browser clients reconnect on their own.
  transient let wsHub : Ws.Hub = Ws.createHub();
  transient let attached = Ws.attach<system, Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    wsHub,
    // Built here, where S/M are concrete — sidesteps any question of
    // whether to_candid/from_candid specialize inside a function still
    // generic over S/M.
    {
      encode = func(m : Ws.Msg<Rules.State, Rules.Action>) : Blob = to_candid (m);
      decode = func(b : Blob) : ?Ws.Msg<Rules.State, Rules.Action> = from_candid (b);
    },
    // 65s: the fastest legal ack interval above the CDK's hardcoded 60s
    // keep-alive timeout (send_ack_interval_ms must exceed it) — keeps
    // the involuntary-disappearance detection floor as tight as the
    // dependency allows (see this section's "Disappearance handling").
    IcWebSocketCdkTypes.WsInitParams(null, ?65_000),
  );
  attached.ws.init<system>(); // starts the CDK's keep-alive/ack timers —
  // this bare top-level call (like `wsHub`/`attached` themselves) reruns
  // automatically on every upgrade too, so no `postupgrade` override is
  // needed to restart it

  // Supplies `ws_open`/`ws_close`/`ws_message`/`ws_get_messages` AND the
  // idle-sweep timer in one `include` — no host actor hand-declares any
  // of the four. Wiring `attached.sweep` (not a bare
  // `registry.sweep(Time.now())`) is what makes a
  // still-connected tab whose game the sweep just ended get a fresh push
  // instead of silently keeping a stale status — see `Ws.Attached`'s own
  // doc. `ws_message`'s
  // second Candid parameter (`ActorMixin`'s own `msgType`) is a plain
  // `Blob`, not `Ws.Msg<Rules.State, Rules.Action>` — the mixin only ever
  // holds the already-built `ws`, with no `S`/`M` in scope to name a
  // game-specific type with, and the CDK ignores this parameter's VALUE
  // regardless of its declared type (it exists solely to shape the
  // canister's `.did`, for tooling that introspects it). The real message
  // driving this call always arrives through `args`'s own `content`
  // field, decoded via `codec.decode` exactly as before;
  // `from_candid(msgType) : ?Ws.Msg<Rules.State, Rules.Action>` recovers
  // the identical value if you ever need it too.
  include ActorMixin<system>(attached.ws, attached.sweep);
};

```

Add the dependency: `mops add ic-websocket-cdk` (pins `0.4.1`). On the
frontend, `duel-game-core/idl.js`'s `makeIdlFactory` (via its exported
`buildEngineTypes`) already declares the four `ws_*` Candid methods for
every game (fixed CDK shapes plus your game's `Action`/`State` embedded
in `Ws.Msg`, and a plain `blob` for `ws_message`'s otherwise-unused
second parameter) — nothing game-specific to add there;
`duel-game-core/ws.js`'s `connectWs()` calls all four directly (see
`../frontend/README.md`'s "Real-time push" section for the frontend
half).

`examples/007/src/Host.mo` and `examples/racing/src/Host.mo` both wire
`ws.mo` exactly this way — it's the live transport both examples'
frontends actually talk to, not a reference-only add-on. **The Motoko
side has been type-checked and reviewed against the CDK's actual
source; the Candid/CBOR codec on the frontend side has been round-tripped
against the same type descriptions in a standalone script (encode →
decode agreement, no live canister involved). The full round trip — a
real canister, a browser tab registering as its own Gateway, and an
actual push arriving — has not been proven end-to-end.** Treat it as a
solid, carefully-reasoned starting point, not a battle-tested one, and
sanity-check it against a real deploy before relying on it.

### Canister players

`mo:duel-game-core/canister_players` lets a CANISTER take a seat at a table
and play, against a human or another canister, with no polling and no second
inbound entry point for a move to arrive through. The key simplification: `ws.mo`
exists only because the IC has no native WebSocket, so a browser has to fake real-time
push. A canister player needs none of that — two canisters calling each other
with `async`/`await` already IS a real, ordered, request-response
channel, the primitive the whole IC is built on. So the whole feature
reframes to "let the GAME canister call the PLAYER canister directly and
treat the reply as the move" — never a one-way "your turn" notice
followed by the player canister calling back independently, which would
reopen exactly the unordered-second-channel problem `ws.mo`'s own
architecture rule (11) closes. A single `await` whose return value IS
the chosen action needs no second inbound entry point at all: nothing
new is exposed for a stray caller to hit, and there's nothing to spoof —
the reply can only ever come from the one principal this module itself
decided to call.

**Identity: a third `sid` namespace.** Exactly like `ws.mo`'s `ii:`/
`an:`, `CanisterPlayers.CP_SID_PREFIX` (`"cp:"`) is a third reserved
namespace of the same `sidFor(prefix, p)` shape, reusing `Ws.sidFor`
as-is. It's actually simpler here than for a browser: `ws.mo` has to
cross-check a client-ASSERTED `sid` against a separately authenticated
WebSocket connection, because that transport decouples the two. A plain
canister-to-canister Candid call has no such gap — `msg.caller` already
IS the authenticated identity — so every entry point computes
`sidForCanister(caller)` itself and never accepts a client-supplied
`sid` at all. There's nothing to check, because there's nothing to
spoof.

**The call/response protocol.** `notifyAndApply` (internal) builds a
`TP.MoveRequest<S>` from the table's own current, truthful
`Registry.status` (never a second, divergent read of `Table`'s
internals — the same field shape `View.#inGame` already reports, minus
UI countdown cosmetics), hands it to a host-supplied `callBot`, re-reads
`gen`/`turn` FRESH once the bot replies (never the copies closed over
from before that call — the table can legitimately change underneath a
long-running bot call: the human claims a win, leaves, or gets
idle-swept while the bot is still thinking), applies the move via
`registry.submit`, and runs the EXACT SAME push fan-out `ws.mo` itself
runs (`Ws.Attached.afterMutation`, exposed for exactly this reuse — see
`ws.mo`'s own `Attached` doc), so a human opponent's browser learns
about a canister-driven move in real time, same as any other. `callBot`
is continuation-passing —
`(SessionId, MoveRequest<S>, (?M) -> async* ()) -> async* ()`, not a
plain `(...) -> async M` — because Motoko rejects `async M` as a type
for an unconstrained generic `M`; the host's own implementation is the
one place able to `try`/`catch` the actual inter-canister call, since
its own game's `Action` type is concrete there, and calls the
continuation with `?move` on success or `null` on a trapped/errored
call.

**Silence is already a first-class outcome.** A bot canister can fail in
every ordinary way software fails: it traps, it's out of cycles, it's
mid-upgrade, it times out, or it just returns an illegal move. None of
that needs new machinery — this engine already has a complete story for
"a seat didn't move" (`claimTimeoutNs`, `idleTimeoutNs`, `#aborted`
debriefs — see the Design section's guarantee 4), and a misbehaving bot
is, from the engine's point of view, indistinguishable from a human who
put the phone down. So `notifyAndApply`'s own failure handling stays
small: an `#err(#illegalMove _)` reply is retried once; a trapped/
errored call, or any other rejection (the table moved on underneath the
bot — a claim, a leave, an idle takeover), is treated exactly like
silence — do nothing, and let the existing timeout machinery take it
from there. That one retry still gives the bot something to work with:
the retried `MoveRequest<S>`'s `retryReason` field carries the exact
text the game's own `validate` rejected the first reply with, so
`make_move` can inspect why its move was illegal and correct that
specifically, rather than just being asked again with no new
information. `retryReason` is `null` on every non-retry ask; a
trapped/errored call never reaches a retry at all, since there's no
rejection text to carry.

**When a canister seat gets asked, claims a win, or acks a finished
debrief.** `ws.mo` stays completely unchanged — it's still the only
transport a human ever mutates through (rule 11). That means nothing in
it eagerly tells a bot "your turn again" once a HUMAN's own move
resolves a round, nothing in it ever calls `claimWin` on a canister's
behalf, and nothing in it ever acks a finished debrief on a canister's
behalf either — a human's own frontend does that itself (`leave`/
`ackEnded`, wired to a "return to lobby" click) the moment they're done,
but a canister seat has no such click, so left alone it would stay
pinned to that finished table — refusing `createTable`/`joinTable` for
that same `cp:` session — until the far slower, passive idle-sweep timer
eventually force-clears it. `nudge(now)` is the fix for all three: a
periodic scan over every table checking, per canister seat, exactly
what's due right now. In an `#active` table: due to move (`View.
#inGame.youSubmitted` is `false` — that one Boolean already means "due
to move" in EITHER mode, the same way it means "the waiting seat" that
may `claimWin` — see `Table.status`'s own doc), in which case it's asked
via `callBot`; or, if it already submitted and is the WAITING seat,
whether `claimWinAvailable` has since turned true, in which case `nudge`
claims the win on its behalf outright. In a `#debrief` table: if the
OTHER seat is no longer a live participant of that SAME debrief either
(`Table.activeDebriefSeat` returns `null` for a seat that's already
acked, or was never filled) — or is itself canister-seated, so there's
nobody around to decide on a rematch at all — `nudge` acks the canister
seat's own side immediately (via `registry.leave`, the same call a
human's "return to lobby" makes), freeing it for a fresh
`createTable`/`joinTable` with no wait. A still-deciding HUMAN partner's
own rematch window is never cut short by this: their own debrief seat
staying unacked is exactly what keeps the canister seat's from firing.
The move-asking case is additionally guarded by a one-bit-per-(table,
seat) in-flight flag so an overlapping tick can never ask the same due
seat twice while the first ask is still pending. Wire
`nudge` onto its own fast timer (a few seconds — independent of the
existing 30s idle-sweep timer, which is far too slow for a game round to
wait on):

```motoko
ignore Timer.recurringTimer<system>(
  #seconds(3),
  func() : async () {
    await* cpAttached.nudge(Time.now());
  },
);

```

A canister-initiated mutation additionally triggers the SAME check
eagerly, right after it succeeds — `joinTable`/`rematch`'s own
implementations call it internally, and so does a canister's own move
landing via `notifyAndApply` (in case that move just ended the game) —
so a bot-vs-bot match starting, resolving a round, or settling its own
debrief never waits for the next tick; only a HUMAN-caused transition
needs `nudge` itself to catch it.

**Wiring it into a host actor** — extending the `ws.mo` example above:

```motoko
import CanisterPlayers "mo:duel-game-core/canister_players";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Timer "mo:core/Timer";

import BotIface "BotIface"; // this game's own CanisterPlayer actor type

persistent actor {
  // ...registry / status / wsHub / attached / ActorMixin from the
  // `ws.mo` example above, unchanged...

  transient let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    attached.afterMutation, // reuses ws.mo's own push fan-out — see above
    func(session, req, k) : async* () {
      let p = Principal.fromText(
        Text.trimStart(session, #text(CanisterPlayers.CP_SID_PREFIX))
      );
      let bot : BotIface.CanisterPlayer = actor (Principal.toText(p));
      try { await* k(?(await bot.make_move(req))) } catch (_) { await* k(null) };
    },
  );

  public shared ({ caller }) func create_table_as_canister(seat : TP.Seat, visibility : TP.TableVisibility) : async TP.Res<TP.TableId> {
    await* cpAttached.createTable(caller, seat, visibility);
  };
  public shared ({ caller }) func join_table_as_canister(id : TP.TableId, seat : TP.Seat, code : ?Text) : async TP.Res<TP.JoinOk> {
    await* cpAttached.joinTable(caller, id, seat, code);
  };
  public shared ({ caller }) func leave_as_canister(gen : Nat) : async TP.Res<()> {
    await* cpAttached.leave(caller, gen);
  };
  public shared ({ caller }) func rematch_as_canister() : async TP.Res<TP.RematchOk> {
    await* cpAttached.rematch(caller);
  };
  public shared ({ caller }) func ack_ended_as_canister() : async () {
    await* cpAttached.ackEnded(caller);
  };
  public shared ({ caller }) func claim_win_as_canister(gen : Nat) : async TP.Res<()> {
    await* cpAttached.claimWin(caller, gen);
  };
  public shared ({ caller }) func reset_as_canister(gen : Nat) : async TP.Res<()> {
    await* cpAttached.reset(caller, gen);
  };

  ignore Timer.recurringTimer<system>(
    #seconds(3),
    func() : async () {
      await* cpAttached.nudge(Time.now());
    },
  );
};

```

Note what's absent: no `submit_as_canister`. A canister player's move
never arrives as an independent inbound call under this design — it's
always the direct reply to the call `notifyAndApply` itself made, applied
by the same code that made it (see "The call/response protocol" above).

**Unattended, canister-vs-canister matches.** `claimWin`/`Table.claimWin`
is shaped for a human: someone looks at the screen and decides to stop
waiting. In an all-canister match there's nobody looking. `nudge` covers
this automatically — its periodic scan checks not just "is this canister
seat due to move" but also "is this canister seat the WAITING one, with
`View.#inGame.claimWinAvailable` now true," and claims the win on its
behalf the instant that's so, no separate wiring needed. The same
"nobody's looking" reasoning applies once that claim (or any other route
into a shared debrief) leaves both seats canister-occupied: a still-
deciding human partner is exactly who a canister seat's own debrief-ack
waits on (see "When a canister seat gets asked, claims a win, or acks a
finished debrief" above) — but two canister seats waiting on EACH
OTHER'S own ack first would simply deadlock, since neither `nudge` tick
would ever see the other as "gone." So when the OTHER seat is also
canister-seated, `nudge` acks both sides unconditionally instead,
settling an all-canister match's own debrief immediately rather than
leaving it stuck until the idle-sweep timer eventually clears it.
`claim_win_as_canister`/`reset_as_canister` exist alongside that mainly
so a canister PARTICIPANT that wants to act the moment it's entitled to
— rather than wait out the nudge timer's own interval — can call either
directly; both route through the caller's own `cp:` session exactly like
`leave_as_canister` does (only ever "my own table," never an arbitrary
one by table id — a supervising tournament-orchestrator canister
resetting or claiming ANY table, not just one it's seated at, is a
further capability this module doesn't provide).

A lobby frontend needs no new field to show "vs 🤖" either:
`TableSummary.p1Session`/`p2Session` already carry the raw `SessionId`
text, so a client-side check against the `cp:` prefix
(`CanisterPlayers.isCanisterSession`, or just
`Text.startsWith(session, #text "cp:")` on the frontend) is purely
cosmetic, reading data the engine already exposes.

**Flow 2: eager dual-seat assignment.** Flow 1 above (self-join) has the
bot claim its own seat, on its own account, once someone hands it a
table id/seat/access code. `Registry.createTableReserving` is the
alternative: a creator names BOTH seats in one call — themselves, and
`reservedFor`, some OTHER already-known `SessionId` — and the table
lands directly in `#active`, with no second `joinTable` needed from
either side:

```motoko
switch (registry.createTableReserving(spec, now, mySession, #p1, #open, CanisterPlayers.sidForCanister(botPrincipal))) {
  case (#ok id) { /* both seats are already live */ };
  case (#err e) { /* ... */ };
};

```

This is the whole of the feature: a small, generic `Registry` addition
(rejecting a self-reservation, and a `reservedFor` already busy
elsewhere, the same way `createTable` itself rejects a creator who's
already busy elsewhere), proven end to end against `canister_players.mo`
in `backend/test/CanisterPlayers.test.mo` — a canister seated this way
is due to move the instant the table exists, picked up by the very next
ordinary `nudge` tick, with no `joinTable` call from the bot at all.
Deliberately NOT wired any further than that here: `ws.mo`'s own `Msg`
protocol has no request variant reaching this call, and no game in this
repo calls it from a browser tab — `examples/racing`'s own `Add Bot`
control (see its own `CLAUDE.md`'s `frontend/` bullet) uses Flow 1
instead, since it fills an ALREADY-STAGED table's open seat, which this
call structurally can't do (it only ever seats both sides of a BRAND NEW
table, atomically, in the one call — there's no "join the other seat of
a table that already exists" version of it). The scenario this call
_would_ suit — an orchestrator seating two bots against each other with
nobody waiting on a `#staging` screen at all — is left for whoever wants
it to build as its own feature: most naturally a privileged Motoko
caller invoking `registry.createTableReserving` directly (an admin
canister, a test harness, a tournament orchestrator), not a new
`ws.mo`/frontend request path, since `ws.mo`'s own request/push protocol
is built around one human's own browser tab, not a third party
launching two OTHER sessions' game for them.

### Metrics

Unlike `ws.mo`, this is entirely opt-in: a host actor that never wires
this section gets no metrics and pays no cost for skipping it —
`Registry`'s own state (`gamesStarted`/`activeGames`/`roundsPerGame`/
`matchmakingWaitSecs`, all `?PT.Counter`/`?PT.Gauge`) simply stays `null`
throughout, and every metrics call inside `registry.mo` is a no-op
against `null`. Add the dependency: `mops add promtracker` (pins
`1.0.1`).

`Registry.attachMetrics(pt : PT.Tracker)` — called once, right after
`Registry.new` — registers four metrics on that tracker, all scoped to
that one `Registry` (so a canister with several independent registries
can `attachMetrics` each onto its own child tracker and tell them apart
by label):

- `games_started` (counter) — bumped once per game that actually starts
  (a fresh `#staging -> #active` transition, whether from `joinTable`
  seating the second player or a `rematch` both sides agreed to).
- `active_games` (gauge) — recomputed by scanning every table's current
  phase after any call that could change how many are `#active` (join,
  submit, rematch, claimWin, leave, reset, sweep) — the live count of
  in-progress games on this registry right now.
- `rounds_per_game` (gauge) — set to the just-finished game's own round
  count (`Debrief.turns`) every time a game ends, by any of the four
  paths that can end one (a resolved final round, a claimed win, or an
  abort via `leave`/`reset`). Like every metric here, this is a snapshot
  at the moment of the event, not a running average — a Prometheus
  scrape between two games' endings sees whichever game ended last;
  query `avg_over_time`/`quantile_over_time` over the scraped series if
  you want a distribution across many games.
- `matchmaking_wait_seconds` (gauge) — set every time a game starts, to
  how long that table sat in `#staging` (its `since` timestamp) before
  the second seat filled it, in whole seconds. Same snapshot caveat as
  `rounds_per_game`.

A minimal wiring, extending the host actor above (see
`examples/racing/src/Host.mo` for the full worked example, including the
`/metrics` HTTP endpoint):

```motoko
import PT "mo:promtracker";
import Http "mo:promtracker/mixins/http";

persistent actor {
  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics); // IC/RTS metrics (cycles, heap, ...) — optional but nearly free
  renderer.addValue(pt.toValue());

  let registry = Registry.new<Rules.State, Rules.Action>(60_000_000_000, 15_000_000_000);
  registry.attachMetrics(pt);

  // ...status/Ws.attach/ActorMixin exactly as above...

  include Http(renderer.renderExposition, "/metrics"); // scrape endpoint
};

```

`pt` itself (`PT.Tracker`) is a plain data record — no function values —
so, left `transient`-free like `registry`, it's a genuinely stable field:
every counter/gauge it holds survives a canister upgrade intact, same as
the rest of the game state. `PT.Renderer` is the opposite: it's a class
holding closures (the `Value`s passed to `addValue`), so it must be
`transient`, like `wsHub`/`attached` above — cheap to rebuild from
scratch on every upgrade (`renderer.addValue(pt.toValue())` just wraps
the surviving `pt` again), and it holds no metric data of its own to
lose.
`mo:promtracker/mixins/http`'s `Http` mixin (`include Http(text, route)`)
supplies a `http_request` query returning `text()`'s result — here,
`renderer.renderExposition()`, the Prometheus text-exposition format — at
whichever `route` you pick; consuming it is subject to the same toolchain
note as `mo:duel-game-core/actor_mixin` (see the root `CLAUDE.md`'s
toolchain section) since both are defined the same way, as a Motoko
`mixin`. `PT.allSystemMetrics` is optional but nearly free to add
alongside your own tracker — it bundles cycles balance, canister version,
and Motoko RTS metrics (heap size, GC stats) without needing a `Tracker`
of its own.

### Build & test

We need up-to-date versions of `node`, `moc` and `mops` installed.

Then run:

```
mops install
mops test
```

### Benchmark

Run

```
mops bench
```

`bench/engine.bench.mo` measures the engine's own overhead — not any
game's `resolve` cost — using the same throwaway `Spec`
(`test/FakeGame.mo`) the test suites use, across `join`+`leave`, a full
submitted round, and repeated `status` queries (the one plain Candid
method a real host actor still exposes directly).

## Design

**Alternating-turn games:** `Spec<S, M>` is tagged by `Mode`, so a game
picks its own shape — `#simultaneous` (both seats submit every round;
everything described in this section) or `#alternating` (seats take
turns in order). A `#alternating` game's `resolve : (S, Seat, M) -> {
state : S; verdict : ?Verdict }` takes just the one seat currently on
turn and their move, and runs the instant that seat submits — there is
no waiting on a second seat's move. The engine tracks whose turn it is
on its own, from the match's own round counter (`p1` moves first, then
it alternates every resolved round); a game's own `S` never needs a turn
flag, and an off-turn submission is rejected by the engine itself
(`Err.#notYourTurn`) before that game's `validate` ever runs. Idle
takeover and claim-a-win both still apply exactly as described
elsewhere in this file, with one restriction on the latter: only the
seat currently WAITING on the other's turn may claim — the seat whose
own turn it is can't, since they're the one holding up the game, not the
one waiting on it.

**Rule contract for `Spec<S, M>`:**

- **Pure.** No actor, no shared functions, no storage, no `Time` calls.
  State transitions build new immutable records; they never mutate.
- **`validate` is the only legality gate.** In `#simultaneous` mode the
  engine calls it separately for each seat's own submission over the
  course of a round; in `#alternating` mode it's called once, for
  whichever seat is currently on turn. Either way, a client bypassing
  disabled UI buttons cannot cheat.
- **`resolve` runs once the round's move(s) are ready.** For
  `#simultaneous`, once both seats have submitted; for `#alternating`,
  immediately once the on-turn seat's single move is validated. Return
  the next state and, if the game just ended, a `?Verdict` (`#p1Wins` /
  `#p2Wins` / `#draw`).

**Claiming an overdue win:** once a player's own move has sat pending
against their opponent's silence for at least `claimTimeoutNs` — a
second, independent timeout from `idleTimeoutNs`, and normally set well
below it — `claimWin` lets THAT player end the match outright, crediting
themselves the win (`End.#claimed seat`) without touching `spec.resolve`
at all: the opponent's move never arrived, so there's nothing for
`resolve` to run against, and the game state simply stays exactly as it
was. It's an entirely optional escape hatch, never automatic — nothing
in `sweep` or anywhere else ever calls it on a player's behalf, and a
player who'd rather give their opponent more time just doesn't click it.
A `claimWin` sent before the window has actually elapsed comes back
`Err.#notOverdue { secondsLeft }`, the same shape `#notIdle` already
uses elsewhere. In a `#alternating` game "a player's own move has sat
pending against their opponent's silence" means the same thing from a
different angle — it's currently the OTHER seat's turn and they haven't
taken it — so only the seat NOT currently on turn may call `claimWin`;
the on-turn seat gets `Err.#wrongPhase` instead, same as any other
misuse.

**Design guarantees** — each maps to a bug class commonly found in
ad-hoc 2-player game backends. Stated here at the per-table primitive
level (`Table.join`/`rematch`/...); every one holds equally at the
`Registry` layer (`Registry.joinTable`/`rematch`/...), which just adds
table creation/discovery/routing on top without changing any of them:

1. **Race-free rematch.** `rematch` from a debrief stages a new game with
   the open seat RESERVED for the partner — unless the partner already
   acked (left) this same debrief, in which case the seat opens
   unreserved instead of waiting on someone who's gone for good; the
   partner's own `rematch` (or `join`) pattern-matches that staging and
   gets seated, or `leave` (with the `gen` `#awaitingRematch` carries)
   DECLINES it, freeing just the reservation. Because an IC actor
   serializes update messages, two simultaneous rematch clicks always
   execute as create-then-join — nobody is stranded.
2. **No ghost lobbies.** Every phase carries its own timestamp (`since` /
   `lastActivity`), stamped at creation — a first joiner who vanishes is
   evictable after the idle timeout, not squatting forever.
3. **Server-side legality.** The engine calls `spec.validate` on every
   submitted move for BOTH players — a game plugged in here cannot be
   cheated by a client bypassing UI button states.
4. **No silent endings.** Aborting yields a shared `#aborted` debrief; an
   overdue opponent may instead be claimed as a win (`#claimed seat`, via
   `claimWin` — the submitter's own optional choice, never automatic);
   an idle takeover records the evicted players so `status` shows them
   `#endedByOther` until they acknowledge (`ackEnded` / any re-entry) —
   or, failing that (nobody plausibly still coming back to look), until
   `Table.pruneEnded` drops the notice on its own during a later `sweep`,
   so one participant who never returns can't pin the notice — and, at
   the `Registry` layer, the table it lives on — forever.
5. **Leave means left.** `status`/`join`/`rematch` all treat a session
   that already acked its own debrief (via `leave`) as no longer a
   participant of it, even while the phase itself lingers in `#debrief`
   for the still-deciding partner. Without this, "Return to lobby" kept
   showing that same player the identical debrief screen — with live
   Rematch/Leave buttons — until the partner ALSO left: visually
   indistinguishable from the button doing nothing at all.
6. **Replay-safe.** `submit`/`leave`/`reset`/`claimWin` all take a `gen`
   (and, for `submit`, `turn`) the caller must have last observed via
   `status`; a
   mismatch against the table's CURRENT generation/round comes back
   `#stale` instead of being applied — see this file's "Replay safety"
   section above for the concrete scenario it closes.

## Implementation notes

- **The engine owns time.** `now : Int` (nanoseconds — pass `Time.now()`
  at the host) is an explicit parameter on every operation that needs
  it; the engine module itself never imports `Time`. This is what makes
  the test suites deterministic and side-effect-free.
- **`status` is pure and safe as a `query`.** Idle-state resets are lazy
  and only ever happen inside a mutating call — never inside `status`.
- **Pending moves are hidden by construction.** `status` exposes only
  Booleans for whether the opponent has moved this round, never the move
  itself — there is no way for the frontend to leak it even by accident.
- **`src/lib.mo` is the shared type surface,** imported as
  `mo:duel-game-core` (no subpath needed) — `Spec`, `Seat`, `Phase`,
  `View`, `Err`, `Res`, `Table`, `Registry`, and everything else are
  defined once in `src/types.mo` and re-exported from here. The actual
  operations live in two sibling modules, both importable by their own
  subpath: `src/table.mo` (`mo:duel-game-core/table`), the single-table
  primitive, and `src/registry.mo` (`mo:duel-game-core/registry`), the
  multi-table router built on top of it. `src/ws.mo`
  (`mo:duel-game-core/ws`) is a separately-imported, but MANDATORY,
  module layered on top of both — never merged into `lib.mo` purely to
  confine its `ic-websocket-cdk` dependency (see the root `CLAUDE.md`'s
  toolchain note), not because wiring it is optional. `src/actor_mixin.mo`
  (`mo:duel-game-core/actor_mixin`) supplies the four `ws_*` Candid
  methods plus the idle-sweep timer, `include`d in the host actor
  alongside it — see "Real-time push" above.
- `test/FakeGame.mo` is a deliberately trivial `Spec` used only by the
  test suites and benchmarks to exercise the engine — it is not a real
  game and ships no rendering.

## Copyright

MR Research AG, 2026

## Authors

Main author: TimoHanke

Contributors: AndyGura

## License

Apache-2.0
