# duel-game-core for Motoko

## Overview

A generic 2-player multi-table lobby session engine for the Internet
Computer. It solves the plumbing every simultaneous-reveal, turn-based
2-player game needs — and knows nothing about any particular game's
rules:

- **Tables** — anyone may open a new table: `#open` (discoverable and
  joinable by anyone browsing the lobby) or protected with an access
  code (shared with a friend out of band, never listed). Any number of
  tables run independently and simultaneously; a shared `Registry`
  creates them and routes every session's calls to the right one.
- **Seating** — two players join a table (seats `#p1` / `#p2`); a third
  caller is turned away while a match is in progress on it.
- **Rounds** — each seated player submits one move; once both are in, the
  game's own `resolve` function runs and either continues the game or
  ends it with a verdict.
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
  rematch option isn't cut short by your exit.
- **Idle takeover** — after a configurable timeout, third parties may
  reclaim a squatted staging seat, reset a dead game, or start fresh over
  an expired debrief — discoverable through the browsable table list
  the same as any other joinable table. No table is occupied forever by
  a player who vanished, and a table nobody ever revisits is eventually
  garbage-collected so ids don't accumulate forever.
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
  `validate`, `resolve` (see Design).
- `src/table.mo` (`mo:duel-game-core/table`) — `Table<S, M>`, the stable
  session state for ONE board, and the low-level primitive `Registry`
  (below) is built from: `Table.new(idleTimeoutNs, visibility,
  createdBy)` plus `join`/`submit`/`rematch`/`leave`/`reset`/`ackEnded`/
  `status`/`sweep` on the table it returns (Motoko dot-notation call
  sugar — plain functions taking the table as their first argument). A
  game that genuinely wants exactly one fixed board with no lobby of its
  own can use this directly instead of `Registry`.
- `src/registry.mo` (`mo:duel-game-core/registry`) — `Registry<S, M>`,
  the stable multi-table registry: created once per host actor with
  `Registry.new(idleTimeoutNs)`. `createTable`/`listTables`/`joinTable`
  create, discover, and join a specific table; `submit`/`rematch`/
  `leave`/`reset`/`ackEnded`/`status` resolve the caller's own current
  table (via a `SessionId -> TableId` mapping the registry keeps) and
  delegate straight into the matching `Table` operation above — no game
  logic is reimplemented at this layer. `sweep` idle-evicts and
  garbage-collects across every table.
- Seven per-table operations, on either `Table<S, M>` or `Registry<S,
  M>`: `join`/`createTable`+`joinTable`, `submit`, `rematch`, `leave`,
  `reset`, `ackEnded`, `status` (plus `sweep`, not caller-facing). Every
  one that can mutate takes `spec` and the current time (`now : Int`,
  nanoseconds) as explicit parameters — see Implementation notes. At the
  `Registry` layer, every mutating operation is called ONLY from inside
  `mo:duel-game-core/Ws`'s `ws_message` dispatch — they are not, and
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

A game is a pure `Spec<S, M>`:

```motoko
public type Spec<S, M> = {
  init : () -> S;
  validate : (S, Seat, M) -> ?Text; // null = legal; ?text = rejection
  resolve : (S, M, M) -> { state : S; verdict : ?Verdict };
};

```

A host actor forwards every call to the engine, supplying `Time.now()`
and your `Spec` — but only `status` is a plain Candid method. Everything
that can mutate state (`createTable`/`joinTable`/`submit`/`rematch`/
`leave`/`reset`/`ackEnded`) is driven exclusively through
`mo:duel-game-core/Ws`'s `ws_message`, wired alongside `status` in the
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
  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new(60_000_000_000); // 60 s idle timeout, shared by every table

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Time.now(), sid);
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

  // ...wire mo:duel-game-core/Ws here — see "Real-time push" below for
  // the full `ActorMixin` wiring (all four `ws_*` methods plus this same
  // idle-sweep timer, in one `include`), which is what actually drives
  // createTable/joinTable/submit/rematch/leave/reset/ackEnded.
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
`reset`/`ackEnded` are not exposed as plain Candid methods at all, only
reachable via `ws_message`.

`src/Ws.mo` — imported separately as `mo:duel-game-core/Ws`, never merged
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
confined to `Ws.mo` means a host actor that never imports
`mo:duel-game-core/Ws` never compiles any of that in; `src/lib.mo` stays
exactly as pure as the architecture rules require.

**Disappearance handling.** Real WS close detection is exactly what
makes it possible for the backend to tell a genuinely vanished player
apart from one merely thinking — `attach()`'s `onClose` (see `Ws.mo`)
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
engine code), so there's no async state machine to build. See `Ws.mo`'s
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
(`createTable`, `joinTable`, `submit`, ...) directly — `Ws.mo`
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
up for a `#req` it wants correlated to its own reply; `Ws.mo` only ever
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
(`Text`), decoupled from any IC principal on purpose, but a WebSocket
connection is keyed by principal — `Hub` learns the `sid <-> principal`
pairing from the `sid` every inbound message carries, and forgets it on
`ws_close`.

**Replay safety.** `#submit`/`#leave`/`#reset` each carry a `gen : Nat`
(and `#submit` additionally a `turn : Nat`) — the match generation (and,
for submit, round number) the client last saw in a `View`. A client can't
always tell whether a mutating call it believes failed (a dropped
connection, a decode error) actually reached `Ws.mo`'s `onMessage` —
`ws/gateway-client.ts`'s resend queue exists to retry exactly that
ambiguous case — so without this, a resent `submit` whose original copy
secretly already resolved the round (or ended the match) would be
silently replayed against whatever round/match is current by the time the
resend lands, and a resent `leave`/`reset` could silently abort a
brand-new match the SAME session later started (typically a same-partner
rematch) instead of the one it actually meant to end. `Registry.submit`/
`leave`/`reset` reject a mismatch as `Err.#stale` instead of applying it;
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
import Ws "mo:duel-game-core/Ws";
import ActorMixin "mo:duel-game-core/actor_mixin";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";

persistent actor {
  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new(60_000_000_000);

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
`Ws.mo` exactly this way — it's the live transport both examples'
frontends actually talk to, not a reference-only add-on. **The Motoko
side has been type-checked and reviewed against the CDK's actual
source; the Candid/CBOR codec on the frontend side has been round-tripped
against the same type descriptions in a standalone script (encode →
decode agreement, no live canister involved). The full round trip — a
real canister, a browser tab registering as its own Gateway, and an
actual push arriving — has not been proven end-to-end.** Treat it as a
solid, carefully-reasoned starting point, not a battle-tested one, and
sanity-check it against a real deploy before relying on it.

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

### Format the code

We use `prettier` with the `prettier-plugin-motoko` plugin (configured in `.prettierrc`). The CI checks formatting on every pull request.

To format the code locally run:

```
npx -y prettier --plugin prettier-plugin-motoko --write '**/*.{mo,json,md}'
```

To only check the formatting (as CI does) run:

```
npx -y prettier --plugin prettier-plugin-motoko --check '**/*.{mo,json,md}'
```

## Design

**Alternating-turn games:** this engine is simultaneous-reveal. Model a
strictly-alternating game (chess, tic-tac-toe, ...) with a pass-move
convention: include a `#pass` move, have `validate` force the off-turn
player to `#pass` (track whose turn it is inside `S`), and let `resolve`
apply only the one real move.

**Rule contract for `Spec<S, M>`:**

- **Pure.** No actor, no shared functions, no storage, no `Time` calls.
  State transitions build new immutable records; they never mutate.
- **`validate` is the only legality gate.** The engine calls it for BOTH
  seats on every submission — a client bypassing disabled UI buttons
  cannot cheat.
- **`resolve` runs once both moves are in.** Return the next state and,
  if the game just ended, a `?Verdict` (`#p1Wins` / `#p2Wins` / `#draw`).

**Design guarantees** — each maps to a bug class commonly found in
ad-hoc 2-player game backends. Stated here at the per-table primitive
level (`Table.join`/`rematch`/...); every one holds equally at the
`Registry` layer (`Registry.joinTable`/`rematch`/...), which just adds
table creation/discovery/routing on top without changing any of them:

1. **Race-free rematch.** `rematch` from a debrief stages a new game with
   the open seat RESERVED for the partner; the partner's own `rematch`
   (or `join`) pattern-matches that staging and gets seated. Because an
   IC actor serializes update messages, two simultaneous rematch clicks
   always execute as create-then-join — nobody is stranded.
2. **No ghost lobbies.** Every phase carries its own timestamp (`since` /
   `lastActivity`), stamped at creation — a first joiner who vanishes is
   evictable after the idle timeout, not squatting forever.
3. **Server-side legality.** The engine calls `spec.validate` on every
   submitted move for BOTH players — a game plugged in here cannot be
   cheated by a client bypassing UI button states.
4. **No silent endings.** Aborting yields a shared `#aborted` debrief; an
   idle takeover records the evicted players so `status` shows them
   `#endedByOther` until they acknowledge (`ackEnded` / any re-entry).
5. **Leave means left.** `status`/`join`/`rematch` all treat a session
   that already acked its own debrief (via `leave`) as no longer a
   participant of it, even while the phase itself lingers in `#debrief`
   for the still-deciding partner. Without this, "Return to lobby" kept
   showing that same player the identical debrief screen — with live
   Rematch/Leave buttons — until the partner ALSO left: visually
   indistinguishable from the button doing nothing at all.
6. **Replay-safe.** `submit`/`leave`/`reset` all take a `gen` (and, for
   `submit`, `turn`) the caller must have last observed via `status`; a
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
  multi-table router built on top of it. `src/Ws.mo`
  (`mo:duel-game-core/Ws`) is a separately-imported, but MANDATORY,
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
