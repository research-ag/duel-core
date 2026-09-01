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
- Seven operations, one per host actor entry point: `join`, `submit`,
  `rematch`, `leave`, `reset`, `ackEnded`, `status`. Every one that can
  mutate takes `spec` and the current time (`now : Int`, nanoseconds) as
  explicit parameters — see Implementation notes.
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

Then wire a host actor that forwards every call to the engine, supplying
`Time.now()` and your `Spec`:

```motoko
import TP "mo:duel-game-core";
import Rules "YourGameRules";       // your module, implementing TP.Spec<S, M>
import Time "mo:core/Time";

persistent actor {
  let table : TP.Table<Rules.State, Rules.Action> =
    TP.create(60_000_000_000); // 60 s idle timeout

  public func join(sid : Text, seat : TP.Seat) : async TP.Res<TP.JoinOk> {
    TP.join(Rules.spec(), table, Time.now(), sid, seat);
  };
  public func submit(sid : Text, a : Rules.Action) : async TP.Res<TP.SubmitOk> {
    TP.submit(Rules.spec(), table, Time.now(), sid, a);
  };
  public func rematch(sid : Text) : async TP.Res<TP.RematchOk> {
    TP.rematch(Rules.spec(), table, Time.now(), sid);
  };
  public func leave(sid : Text) : async TP.Res<()> {
    TP.leave(table, Time.now(), sid);
  };
  public func reset(sid : Text) : async TP.Res<()> {
    TP.reset(table, Time.now(), sid);
  };
  public func ackEnded(sid : Text) : async () {
    TP.ackEnded(table, sid);
  };
  public query func status(sid : Text) : async TP.View<Rules.State> {
    TP.status(table, Time.now(), sid);
  };
};
```

`Table<S, M>` is a stable type whenever `S` and `M` are stable types —
the `Spec` (functions) is passed on every call and never stored, so the
engine survives canister upgrades with no migration code.

From there, generate (or hand-write) the Candid interface for this
service and pair it with a **GamePlugin** on the frontend — see
[`../frontend/README.md`](../frontend/README.md).

### Optional: real-time push

Every game on this engine is driven by `duel-game-core/ws.js` on the
frontend, with **zero backend changes** — see that package's README for
how it works (short version: it polls the SAME plain 7 methods below, on
a fast interval, and hands the caller a WebSocket-like object; there is
no plain-polling mode to fall back to any more, `ws` is required).
Nothing below this point is required reading unless you want *actual*
server push over a real external relay instead of fast client-side
polling wearing a push-shaped interface.

`src/Ws.mo` — imported separately as `mo:duel-game-core/Ws`, never merged
into the engine itself — is that real-push alternative, built on
[`ic-websocket-cdk`](https://github.com/omnia-network/ic-websocket-cdk-mo)
(mops) and its matching browser client,
[`ic-websocket-js`](https://github.com/omnia-network/ic-websocket-sdk-js)
(npm). The IC has no native WebSocket support — `ic-websocket-cdk` works
by having the browser open a real WebSocket to a relay, the **WS
Gateway**, which polls the canister's `ws_get_messages` and relays both
directions; you'd need to run one yourself (or point at the CDK authors'
public instance, `wss://gateway.icws.io`) and wire `ic-websocket-js` into
your frontend by hand — none of that is bundled in this repo any more
(an earlier version of this package shipped a self-hosted Gateway Docker
setup and a `ws.js` that spoke to it directly; both were dissolved in
favor of the frontend polling its own canister once it became clear a
real Gateway process bought nothing a 2-player casual game actually
needed). That CDK depends on the legacy `mo:base` (this package's own
code never does — see the root `CLAUDE.md`'s toolchain rule), and its
last release (`0.4.1`, Oct 2024) predates this repo. Keeping it confined
to `Ws.mo` means a host actor that never imports `mo:duel-game-core/Ws`
never compiles any of that in; `src/lib.mo` stays exactly as pure as the
architecture rules require.

**The wire protocol.** `ic-websocket-js` requires ONE application-message
type shared by both directions (it reads the type straight off the
canister's `ws_message` method's second Candid parameter at runtime) — so
`Ws.Msg<S, M>` is a variant covering client→canister requests
(`#req { sid; req }`, where `req` mirrors the engine's six mutating
operations plus an explicit `#status` resync) AND canister→client pushes
(`#view` / `#err`), not two separate types. Every mutating request re-uses
the plain engine operations you've already wired above — `Ws.mo`
reimplements no game logic — and, after each one, pushes a fresh `#view`
to **every connected participant of the affected match** (both seats),
read directly off `table.phase`'s `p1`/`p2` fields. `Hub` is what makes
that possible: the engine's identity is a client-chosen `SessionId`
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

  // ...the 7 plain methods from the example above, unchanged...

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
    IcWebSocketCdkTypes.WsInitParams(null, null),
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
frontend, `duel-game-core/idl.js`'s `makeIdlFactory` already declares the
four `ws_*` Candid methods for every game (fixed CDK shapes plus your
game's `Action`/`State` embedded in `Ws.Msg`) — nothing game-specific to
add there, but note `duel-game-core/ws.js`'s shipped `connectWs()`
doesn't call any of them (see above); wiring a real `ic-websocket-js`
client against this is on you.

`examples/007/src/Host.mo` and `examples/racing/src/Host.mo` both wire
`Ws.mo` (harmlessly unused, since neither example's frontend talks to it
— left in place as a complete, type-checked reference for anyone who
wants to build a real Gateway-backed client against it). **This has been
type-checked and reviewed against the CDK's actual source and its own
reference test canister, but the full round trip (a canister, a Gateway,
and a browser actually joining and seeing a push) has not been proven
end-to-end.** Treat it as a solid starting point, not a battle-tested
one, and sanity-check it against a real deploy before relying on it.

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
submitted round, and repeated `status` queries (the path a polling
frontend hammers continuously).

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
  (no subpath needed).
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
