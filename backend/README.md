# duel-game-core for Motoko

## Overview

A generic 2-player global-board session engine for the Internet Computer.
It solves the plumbing every simultaneous-reveal, turn-based 2-player game
needs — and knows nothing about any particular game's rules:

- **Seating** — two players join a single global board (seats `#p1` /
  `#p2`); a third caller is turned away while a match is in progress.
- **Rounds** — each seated player submits one move; once both are in, the
  game's own `resolve` function runs and either continues the game or
  ends it with a verdict.
- **Debrief** — a finished game puts BOTH players in a debrief (win /
  lose / draw), with the final game state attached.
- **Early leave** — a player may leave mid-game; both players get a
  shared `#aborted` debrief instead of the game silently vanishing.
- **Rematch** — from the debrief, either player can request a rematch;
  two simultaneous rematch clicks converge race-free (see Design).
  Leaving a debrief dismisses it for you specifically: your own `status`
  stops showing it (and `join`/`rematch` stop treating you as one of its
  two participants) right away, even though the underlying board can
  legitimately linger in that debrief until your partner also leaves (or
  it expires) — their own rematch option isn't cut short by your exit.
- **Idle takeover** — after a configurable timeout, third parties may
  reclaim a squatted staging seat, reset a dead game, or start fresh over
  an expired debrief. No lobby is occupied forever by a player who
  vanished.
- **Status views** — every caller gets one truthful, per-caller `View`,
  including a proactive `#endedByOther` notice when their game was ripped
  out from under them by an idle takeover.

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

The engine is one module (`src/lib.mo`) built around two type parameters
a game supplies: `S` (game state) and `M` (one player's move).

- `Spec<S, M>` — the three pure functions a game implements: `init`,
  `validate`, `resolve` (see Design).
- `Table<S, M>` — the stable session state for one global board; created
  once per host actor with `create(idleTimeoutNs)`.
- Seven operations: `join`, `submit`, `rematch`, `leave`, `reset`,
  `ackEnded`, `status`. Every one that can mutate takes `spec` and the
  current time (`now : Int`, nanoseconds) as explicit parameters — see
  Implementation notes. Six of them (everything but `status`) are called
  ONLY from inside `mo:duel-game-core/Ws`'s `ws_message` dispatch — they
  are not, and must not be, exposed as plain Candid methods on a host
  actor (see "Real-time push" below for why). `status` is the exception:
  it stays a plain public `query` too, since it's side-effect-free and
  carries no race risk.
- `View<S>` — the per-caller result of `status`: exactly one of `#lobby`,
  `#busy`, `#stagingYou`, `#awaitingRematch`, `#inGame`, `#debrief`,
  `#endedByOther`.

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
  validate : (S, Seat, M) -> ?Text;   // null = legal; ?text = rejection
  resolve : (S, M, M) -> { state : S; verdict : ?Verdict };
};
```

A host actor forwards every call to the engine, supplying `Time.now()`
and your `Spec` — but only `status` is a plain Candid method. Everything
that can mutate state (`join`/`submit`/`rematch`/`leave`/`reset`/
`ackEnded`) is driven exclusively through `mo:duel-game-core/Ws`'s
`ws_message`, wired alongside `status` in the SAME actor — there is no
plain Candid method for any of them, and no fallback: see "Real-time
push" below for why, and for the idle-sweep timer that also belongs in
this actor. A minimal host actor's non-WS half:

```motoko
import TP "mo:duel-game-core";
import Rules "YourGameRules";       // your module, implementing TP.Spec<S, M>
import Time "mo:core/Time";
import Timer "mo:core/Timer";

persistent actor {
  let table : TP.Table<Rules.State, Rules.Action> =
    TP.create(60_000_000_000); // 60 s idle timeout

  public query func status(sid : Text) : async TP.View<Rules.State> {
    TP.status(table, Time.now(), sid);
  };

  // Frees an abandoned board on its own — with only 2 players, there's
  // often nobody left to visit the board and trigger the lazy,
  // visitor-driven eviction `TP.join`/`TP.reset` already do. Timers don't
  // survive an upgrade, so restart in `postupgrade` too.
  func startSweeping<system>() {
    ignore Timer.recurringTimer<system>(#seconds(30), func() : async () {
      TP.sweep(table, Time.now());
    });
  };
  startSweeping<system>();

  // ...wire mo:duel-game-core/Ws here — see "Real-time push" below for
  // the full four-method forward, which is what actually drives
  // join/submit/rematch/leave/reset/ackEnded.

  system func postupgrade() {
    // ...ws.init<system>() too, see "Real-time push" below.
    startSweeping<system>();
  };
};
```

`Table<S, M>` is a stable type whenever `S` and `M` are stable types —
the `Spec` (functions) is passed on every call and never stored, so the
engine survives canister upgrades with no migration code.

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
which is why `join`/`submit`/`rematch`/`leave`/`reset`/`ackEnded` are not
exposed as plain Candid methods at all, only reachable via `ws_message`.

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
to run, no `ic-websocket-js` dependency, no second signing identity (an
earlier version of this package shipped a self-hosted Gateway Docker
setup and a separate `ws.js` client for it; both were dissolved once it
became clear a genuinely separate relay process bought nothing a
2-player casual game actually needed — see git history around "self-
hosted gateway websockets"/"dissolved gateway code into client library"
if you want the full story). That CDK depends on the legacy `mo:base`
(this package's own code never does — see the root `CLAUDE.md`'s
toolchain rule), and its last release (`0.4.1`, Oct 2024) predates this
repo. Keeping it confined to `Ws.mo` means a host actor that never
imports `mo:duel-game-core/Ws` never compiles any of that in; `src/lib.mo`
stays exactly as pure as the architecture rules require.

**Disappearance handling.** Real WS close detection is exactly what
makes it possible for the backend to tell a genuinely vanished player
apart from one merely thinking — `attach()`'s `onClose` (see `Ws.mo`)
drives an implicit `TP.leave` on behalf of whichever session's
connection just closed, whether that close was the client's own
cooperative goodbye or the CDK's internal keep-alive timeout catching an
involuntary disappearance (crash, force-quit, network drop): a live game
someone vanished from ends in a shared debrief instead of leaving the
opponent staring at a move that's never coming, and if the OTHER
participant is also found disconnected at that point, their side of the
same debrief is acked too, freeing the board immediately instead of it
sitting occupied with nobody left to poll it free. The CDK's keep-alive
timeout is fixed at 60s (not configurable via `WsInitParams`), so an
involuntary disappearance has a real detection floor of roughly
60-120s depending on where in the ack cycle it happens — not instant,
but bounded, and independent of `TP.sweep` (see `src/lib.mo`), which
stays in place underneath this as a second, timeout-based backstop for
anything that reaches the engine outside this transport at all (e.g. a
canister upgrade dropping every live connection until browsers
reconnect on their own).

**The wire protocol.** `ic-websocket-js` requires ONE application-message
type shared by both directions (it reads the type straight off the
canister's `ws_message` method's second Candid parameter at runtime) — so
`Ws.Msg<S, M>` is a variant covering client→canister requests
(`#req { sid; req; reqId }`, where `req` mirrors the engine's six mutating
operations plus an explicit `#status` resync) AND canister→client pushes
(`#view { reqId; view }` / `#err { reqId; err }`), not two separate types.
Every mutating request re-uses `lib.mo`'s own plain engine operations
(`TP.join`, `TP.submit`, ...) directly — `Ws.mo` reimplements no game
logic, and these are the ONLY place those six operations are ever called
from a host actor, since none of them is exposed as a plain Candid
method — and, after each one,
pushes a fresh view to whoever needs to see it changed: once a match has
two fixed seats (`#active`/`#debrief`), that's read directly off
`table.phase`'s `p1`/`p2` fields, so a connection routinely receives a
push it never asked for whenever the OTHER seat is the one who acted.
Before that (`#empty`/`#staging`) there IS no fixed pair yet — a seat
opening or closing needs to reach anyone watching the lobby, not just
whoever happens to be seated, so that case instead pushes to every
session `Hub` currently knows is connected at all (see below). Either
way, a client can receive a view it never requested. `reqId` is an opaque token the
CLIENT makes up for a `#req` it wants correlated to its own reply; `Ws.mo`
only ever echoes it straight back on that SAME session's own push, never
inspecting or generating it — a push to the other, non-acting participant
always carries `reqId = null`, since it's a broadcast, not a reply to
anything they asked. This exists because, without it, a client has no way
to tell "the reply to my own request" apart from "an unrelated broadcast
that happened to arrive around the same time" — a real bug this closes:
a client-side FIFO match-next-message-to-oldest-pending-request scheme
let an opponent's broadcast steal the slot meant for this connection's
own reply, silently hanging the real one forever. `Hub` is the other half
of the bridge: the engine's identity is a client-chosen `SessionId`
(`Text`), decoupled from any IC principal on purpose, but a WebSocket
connection is keyed by principal — `Hub` learns the `sid <-> principal`
pairing from the `sid` every inbound message carries, and forgets it on
`ws_close`.

**Wiring it into a host actor** — extending the example above:

```motoko
import Ws "mo:duel-game-core/Ws";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";

persistent actor {
  let table : TP.Table<Rules.State, Rules.Action> = TP.create(60_000_000_000);

  // ...`status` and the idle-sweep timer from the example above, unchanged...

  // `IcWebSocketCdk.IcWebSocket` holds live connections/closures — not a
  // stable type. `transient` rebuilds both fresh on every upgrade; no game
  // state is lost, since `table` is untouched by any of this and browser
  // clients reconnect on their own.
  transient let wsHub : Ws.Hub = Ws.createHub();
  transient let ws = Ws.attach<Rules.State, Rules.Action>(
    Rules.spec(), table, wsHub,
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
  ws.init<system>(); // starts the CDK's keep-alive/ack timers

  public shared ({ caller }) func ws_open(args : IcWebSocketCdkTypes.CanisterWsOpenArguments) : async IcWebSocketCdkTypes.CanisterWsOpenResult {
    await ws.ws_open(caller, args);
  };
  public shared ({ caller }) func ws_close(args : IcWebSocketCdkTypes.CanisterWsCloseArguments) : async IcWebSocketCdkTypes.CanisterWsCloseResult {
    await ws.ws_close(caller, args);
  };
  public shared ({ caller }) func ws_message(args : IcWebSocketCdkTypes.CanisterWsMessageArguments, msgType : ?Ws.Msg<Rules.State, Rules.Action>) : async IcWebSocketCdkTypes.CanisterWsMessageResult {
    await ws.ws_message(caller, args, msgType);
  };
  public shared query ({ caller }) func ws_get_messages(args : IcWebSocketCdkTypes.CanisterWsGetMessagesArguments) : async IcWebSocketCdkTypes.CanisterWsGetMessagesResult {
    ws.ws_get_messages(caller, args);
  };

  // IC timers don't survive an upgrade on their own — reschedule them.
  system func postupgrade() { ws.init<system>() };
};
```

Add the dependency: `mops add ic-websocket-cdk` (pins `0.4.1`). On the
frontend, `duel-game-core/idl.js`'s `makeIdlFactory` (via its exported
`buildEngineTypes`) already declares the four `ws_*` Candid methods for
every game (fixed CDK shapes plus your game's `Action`/`State` embedded
in `Ws.Msg`) — nothing game-specific to add there;
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
ad-hoc 2-player game backends:

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
- **`src/lib.mo` is the single entry point,** imported as `mo:duel-game-core`
  (no subpath needed). `src/Ws.mo` (`mo:duel-game-core/Ws`) is a
  separately-imported, but MANDATORY, module layered on top — never
  merged into `lib.mo` purely to confine its `ic-websocket-cdk` dependency
  (see the root `CLAUDE.md`'s toolchain note), not because wiring it is
  optional.
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
