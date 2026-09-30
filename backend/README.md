# duel-game-core for Motoko

## Overview

A generic 2-player multi-table session engine for the Internet Computer.
It handles everything a 2-player game needs except the game itself:

- **Tables** — anyone opens a table, `#open` or protected by an access
  code shared out of band. Both kinds are browsable (a protected one is
  flagged, and shows who already holds a seat); any number run at once,
  routed by one `Registry`.
- **Seating** — two players take seats `#p1`/`#p2`; a third is turned
  away while a match is in progress.
- **Rounds** — a `#simultaneous` game resolves once both seats have
  submitted; an `#alternating` game resolves the instant the on-turn seat
  submits.
- **Debrief** — a finished game puts both players in a debrief with the
  final state attached.
- **Early leave** — leaving mid-game gives both players a shared
  `#aborted` debrief.
- **Rematch** — either player requests one from the debrief, reusing the
  same table; simultaneous clicks converge race-free. Leaving a debrief
  dismisses it for you only; the partner's rematch option survives, and a
  rematch requested after the partner left opens the seat immediately.
  The reserved partner may also decline.
- **Claim a win** — once your move has sat pending against the
  opponent's silence for `claimTimeoutNs`, you may claim the win. Never
  automatic.
- **Idle takeover** — after `idleTimeoutNs`, third parties may reclaim a
  squatted seat, reset a dead game, or start over an expired debrief.
  Abandoned tables are garbage-collected, including pruning
  `#endedByOther` notices nobody will ever ack.
- **Status views** — one truthful per-caller `SessionStatus`: the
  browsable table list, or a specific table's `View`, including the
  `#endedByOther` notice after a takeover.

Pair it with [`duel-game-core` for npm](../frontend/README.md).

### Interface

Two type parameters: `S` (game state) and `M` (one move). Types live in
`src/types.mo`, re-exported by `src/lib.mo` (`mo:duel-game-core`).

- `Spec<S, M>` — the game's three pure functions, tagged by `Mode`:

```motoko
public type Spec<S, M> = {
  #simultaneous : {
    init : (Text) -> S; // this table's rules variant in, fresh state out
    validate : (S, Seat, M) -> ?Text; // null = legal; ?text = rejection
    resolve : (S, M, M) -> { state : S; verdict : ?Verdict };
  };
  #alternating : {
    init : (Text) -> S;
    validate : (S, Seat, M) -> ?Text;
    resolve : (S, Seat, M) -> { state : S; verdict : ?Verdict }; // the on-turn seat
  };
};

```

- `src/table.mo` (`mo:duel-game-core/table`) — `Table<S, M>`, one board:
  `Table.new(idleTimeoutNs, claimTimeoutNs, visibility, createdBy,
variant)` plus `join`/`submit`/`rematch`/`leave`/`reset`/`claimWin`/
  `ackEnded`/`status`/`sweep`. For a game that wants exactly one fixed
  board and no lobby.
- `src/registry.mo` (`mo:duel-game-core/registry`) — `Registry<S, M>`,
  created once with `Registry.new(idleTimeoutNs, claimTimeoutNs)`.
  `createTable`/`createTableReserving`/`listTables`/`joinTable` create,
  discover, and join tables; `submit`/`rematch`/`leave`/`reset`/
  `claimWin`/`ackEnded`/`status` resolve the caller's current table via a
  `SessionId -> TableId` map and delegate to `Table`. `sweep` evicts and
  garbage-collects across every table. `attachMetrics(pt)` is optional
  (see Metrics). `peekNextTableId` is a pure read of the id nonce.
- Every mutating operation takes `spec` and `now : Int` (nanoseconds).
  At the `Registry` layer they are called only from `mo:duel-game-core/ws`
  — never exposed as plain Candid methods. `status` is the exception
  (side-effect-free `query`).
- `View<S>` — one table's per-caller screen: `#lobby`, `#busy`,
  `#stagingYou`, `#awaitingRematch`, `#inGame`, `#debrief`,
  `#endedByOther`. `SessionStatus<S>` wraps it: `#browsing { tables }` or
  `#atTable { id; view }`.

`Registry<S, M>` and `Table<S, M>` are stable types whenever `S`/`M`
are; the `Spec` is passed on every call and never stored, so upgrades
need no migration.

## Usage

```
mops add duel-game-core
```

(Unpublished: use a local path dependency until it ships to mops.one.)

The non-WS half of a minimal host actor:

```motoko
import TP "mo:duel-game-core";
import Registry "mo:duel-game-core/registry";
import Rules "YourGameRules"; // implements TP.Spec<S, M>
import Time "mo:core/Time";

persistent actor {
  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new(90_000_000_000, 60_000_000_000); // 90s idle, 60s claim window

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Rules.spec(), Time.now(), sid);
  };

  // ...Ws.attach + ActorMixin — see "Real-time push"; that include also
  // supplies the idle-sweep timer.
};

```

### Table variants

A table's creator may pick a rules variant (`variant : Text`, passed to
`createTable`/`createTableReserving`, stored on the `Table`, surfaced on
`TableSummary`). The engine never interprets it; the game's `init` does,
falling back safely on anything unrecognized:

```motoko
public type Variant = { #classic; #well };

func parseVariant(raw : Text) : Variant = switch (raw) {
  case ("well") #well;
  case (_) #classic; // never trap on "" or garbage
};

public func init(raw : Text) : State = {
  score = 0;
  variant = parseVariant(raw);
};

```

A game without variants ignores the argument (`init = func(_ : Text) : S
= { ... }`).

**Same fields, different legality** — keep `M`/`S` flat, store the
variant on `S`, and gate in `validate`; build `resolve` against the
variant with the most legal moves (`examples/rock-paper-scissors`). When
a variant also changes what a move does, `resolve` branches on
`s.variant` too (`examples/chopsticks`).

**Different fields entirely** — make `M` a tagged union over each
variant's payload and dispatch once through a variant-keyed lookup built
at module level (never stored on the actor). Either way it is one Candid
type for the whole game, which is why `variant` is opaque `Text` rather
than a third `Spec` type parameter: `TableSummary` is not generic over
`S`/`M`.

Frontend: `GamePlugin.variantChoices()`/`formatVariant()` in
[`../frontend/README.md`](../frontend/README.md).

### Real-time push

`src/ws.mo` (`mo:duel-game-core/ws`), built on the vendored
[`ic-websocket-cdk`](https://github.com/omnia-network/ic-websocket-cdk-mo)
at `backend/src/ic-websocket-cdk/src` (migrated to `mo:core`; its
`ic-certification` dependency still uses `mo:base`), is the only way a
client mutates game state. Two independent update calls have no
guaranteed relative processing order once both are in flight, so a
plain `submit` racing the WS channel could resolve out of order — hence
no plain Candid method for any mutating operation.

The CDK normally expects an off-chain Gateway relay, but does not require
a pre-registered Gateway principal: a client's own `ws_open` names its
`gateway_principal`. The frontend's `GatewayWs` therefore has each
browser tab register itself as its own Gateway and poll its own
`ws_get_messages`. No relay process, no second identity. The mixin's
`ws_open(args, msg : ?Blob)` takes an optional encoded `Msg` that the
vendored CDK hands to `onMessage` inside the handshake itself, so the
`#status` every connection starts with rides along instead of costing a
second update call.

**Disappearance handling.** `attach()`'s `onClose` drives an implicit
`Registry.leave` for the closed session, whether the close was
cooperative or the CDK's keep-alive timeout (fixed at 60s, giving an
involuntary-disappearance detection floor of roughly 60–180s). A live
game the player vanished from ends in a shared debrief; if the partner
is also disconnected, their side is acked too and the table frees
immediately. `Registry.sweep` stays as the timeout-based backstop.

**Push helpers are `async*`/`await*`.** Only `pushTo`'s call into
`IcWebSocketCdk.send` is a genuine send; `pushStatus`/`afterMutation`/
`finishClose`/`sweepAndPush` are wrappers. Plain `async` would make each
wrapper its own message with its own commit point; `async*` inlines them
into one. Don't widen them back. `disconnectSession` is not async at all.

**Wire protocol.** `Ws.Msg<S, M>` is one variant for both directions:
`#req { sid; req; reqId }` (client→canister; `req` mirrors `Registry`'s
operations plus `#status`) and `#view { reqId; view }`/`#err { reqId;
err }` (canister→client; `view` is a `SessionStatus<S>`). After each
successful mutation the module pushes a fresh status to the acting
session, the table's other occupants (including a rematch reservation's
named partner), and — when the open-table list may have changed — every
other connected session not at a table. `reqId` is an opaque
client-chosen token echoed back only on that session's own reply; every
other push carries `null`. It exists because a FIFO "next message is my
reply" scheme let an opponent's broadcast steal a reply's slot. `Hub`
bridges `sid <-> principal`, learned from each inbound message and
forgotten on `ws_close`.

**Player identity.** `Table`/`Registry` only compare `SessionId`s for
equality, so anonymous and logged-in players share tables with no
special-casing. Both are non-spoofable: `Ws.sidFor(prefix, p) = prefix #
Principal.toText(p)` with `PRINCIPAL_SID_PREFIX` (`"ii:"`, Internet
Identity) or `ANON_SID_PREFIX` (`"an:"`, a locally persisted keypair).
`onMessage` rejects any `sid` whose principal doesn't match the
connection's `client_principal` under its namespace, or that names no
namespace, with `#unauthorized`. There is no client-asserted tier.
`Ws.playerKey(sid)` strips the prefix to a stable per-player key.

**Replay safety.** `#submit`/`#leave`/`#reset`/`#claimWin` carry the
`gen` (and `#submit` the `turn`) the client last saw. The client's resend
queue retries a call it cannot tell landed or not, so without this a
resent `submit` could replay against a later round, and a resent
`leave`/`reset` could abort a new match. A mismatch is `Err.#stale`; the
client refetches `status`. `#createTable`/`#joinTable`/`#rematch`/
`#ackEnded` recompute from live state and need no binding.

**Wiring:**

```motoko
import Ws "mo:duel-game-core/ws";
import ActorMixin "mo:duel-game-core/actor_mixin";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";

persistent actor {
  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new(90_000_000_000, 60_000_000_000);
  // ...status...

  // Not stable (live connections/closures) — rebuilt on every upgrade;
  // `registry` is untouched and browsers reconnect on their own.
  transient let wsHub : Ws.Hub = Ws.createHub();
  transient let attached = Ws.attach<system, Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    wsHub,
    // Built where S/M are concrete.
    {
      encode = func(m : Ws.Msg<Rules.State, Rules.Action>) : Blob = to_candid (m);
      decode = func(b : Blob) : ?Ws.Msg<Rules.State, Rules.Action> = from_candid (b);
    },
    // send_ack_interval_ms must exceed the CDK's fixed 60s keep-alive.
    IcWebSocketCdkTypes.WsInitParams(null, ?120_000),
    null, // onSettled — see "Canister players"
    null, // onGameEnded — see "Leaderboard"
    null, // onGameStarted — see "Leaderboard"
  );
  attached.ws.init<system>(); // reruns on every upgrade; no postupgrade needed

  // ws_open/ws_close/ws_message/ws_get_messages + the idle-sweep timer.
  // `attached.sweep` (not a bare `registry.sweep`) pushes to sessions the
  // sweep just evicted.
  include ActorMixin<system>(attached.ws, attached.sweep);
};

```

`ws_message`'s second Candid parameter is a plain `?Blob`: the CDK
ignores its value (it only shapes the `.did`), and the mixin has no
`S`/`M` in scope. The real message arrives in `args.content`.

The frontend's `makeIdlFactory` already declares the four `ws_*` methods;
`connectWs()` calls them. See `examples/*/src/Host.mo` for this wired
end to end.

### Canister players

`mo:duel-game-core/canister_players` lets a canister take a seat. Two
canisters calling each other with `await` already form an ordered
request/response channel, so the game canister calls the player
canister's `make_move` and treats the reply as the move — never a "your
turn" notice followed by an independent callback, which would reopen the
unordered-second-channel race rule 11 closes. Nothing new is exposed and
nothing can be spoofed: the reply comes from the principal this module
decided to call.

**Identity.** `CP_SID_PREFIX` (`"cp:"`) is a third namespace, but there
is no client-asserted `sid` to cross-check: `msg.caller` already is the
authenticated identity. `sidForCanister(p, tableId, complexity)` mints
`"cp:" # p # ":" # tableId # ":" # complexity` — one session per board,
so one bot canister may hold seats at many tables. `createTable` uses
`Registry.peekNextTableId` to know the id one call early (safe with no
`await` in between). `leave`/`ackEnded`/`claimWin`/`reset` take an
explicit `tableId` and look the session up on that board's own phase
record. `principalOfCanisterSession`/`complexityOfCanisterSession` invert
the two segments a host needs.

**Complexity.** A bot may offer several ways to play ("Easy"/"Hard",
"Rabbit"/"Fox"/"Lion", ...). Each is a `complexity : Text`, as opaque
here as `variant` is to the engine. The bot declares its list once at
registration; whoever seats it picks one, which becomes the session id's
last segment and reaches the bot as `MoveRequest.complexity` on every
ask. A bot with one way to play registers `[]` and is listed under
`DEFAULT_COMPLEXITY` (`"Default"`); every complexity is rated separately
via `leaderboardKey(p, complexity)`.

**Call/response.** `notifyAndApply` builds a `MoveRequest<S, M>` from the
table's own `Registry.status` (plus `opponent`/`opponentLastMove`/
`lastRoundDurationNs`, read off the `Active` record in the same
synchronous step), hands it to the host's `callBot`, re-reads `gen`/`turn`
fresh after the reply (the human may have claimed, left, or been swept
meanwhile), applies via `registry.submit`, and runs
`Ws.Attached.afterMutation`. `callBot` is continuation-passing —
`(SessionId, MoveRequest<S, M>, (?M) -> async* ()) -> async* ()` — because
Motoko rejects `async M` for an unconstrained generic `M`; the host's
concrete closure does the `try`/`catch`. An `#illegalMove` reply is
retried once with `retryReason` set to `validate`'s text; a trap, error,
or any other rejection is treated as silence and left to
`claimTimeoutNs`/`idleTimeoutNs`.

**`settle(now, id)`.** For an `#active` table: a seat due to move
(`View.#inGame.youSubmitted == false`, which means "due" in either mode)
is asked; the WAITING seat with `claimWinAvailable` claims the win; a
waiting seat not yet overdue arms `armClaimCheck(id, secondsUntilClaimable)`
for one precise wakeup. For a `#debrief`: a canister seat is acked (via
`registry.leave`) once the other seat is no longer a live participant or
is itself a canister, so two canister seats never deadlock on each
other's ack and a deciding human's rematch window is never cut short. A
one-bit in-flight flag per (table, seat) prevents double asks.
Canister-driven mutations call `settle` inline; human-driven ones reach
it through `Ws.attach`'s `onSettled`. `sweep` is the slow full-registry
fallback, folded into the existing idle-sweep timer.

**Wiring** (the two `attach` calls need each other's result, so one
mutable indirection breaks the cycle):

```motoko
import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
import Principal "mo:core/Principal";
import Timer "mo:core/Timer";
import BotIface "BotIface"; // this game's CanisterPlayer actor type

persistent actor {
  // ...registry/status...

  transient var settleTable : ?((Int, TP.TableId) -> async* ()) = null;
  transient let settle = func(now : Int, id : TP.TableId) : async* () {
    switch (settleTable) { case (?f) await* f(now, id); case null {} };
  };

  transient let wsHub : Ws.Hub = Ws.createHub();
  transient let attached = Ws.attach<system, Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    wsHub,
    codec,
    wsParams,
    ?settle,
    null,
    null,
  );
  attached.ws.init<system>();

  transient let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    attached.afterMutation,
    func(session, req, k) : async* () {
      let p = CanisterPlayers.principalOfCanisterSession(session);
      let bot : BotIface.CanisterPlayer = actor (p.toText());
      try { await* k(?(await bot.make_move(req))) } catch (_) { await* k(null) };
    },
    func(id : TP.TableId, secs : Nat) : async* () {
      ignore Timer.setTimer<system>(#seconds secs, func() : async () { await* settle(Time.now(), id) });
    },
  );
  settleTable := ?cpAttached.settle;

  let botDirectory = CanisterPlayers.newBotDirectory(); // plain stable field
  include CanisterPlayersActorMixin(cpAttached, botDirectory, null); // ?leaderboard if wired

  transient let combinedSweep = func(now : Int) : async* () {
    await* attached.sweep(now);
    await* cpAttached.sweep(now);
  };
  include ActorMixin<system>(attached.ws, combinedSweep);
};

```

The mixin supplies `create_table_as_canister`/`join_table_as_canister`/
`leave_as_canister`/`ack_ended_as_canister`/`claim_win_as_canister`/
`reset_as_canister` plus `register_bot`/`unregister_bot`/`list_bots`.
There is no `submit_as_canister` (a move only ever arrives as the reply
to `make_move`) and no `rematch_as_canister` (a canister-vs-canister
debrief auto-acks; a human-vs-canister rematch is the human's frontend
re-issuing `play`). `claim_win_as_canister`/`reset_as_canister` let a
participant act the instant it is entitled to instead of waiting on the
armed wakeup; each acts only on a board the caller's own principal is
seated at.

A lobby needs no new field to show "vs 🤖": `TableSummary.p1Session`/
`p2Session` already carry the raw `SessionId`, and `isCanisterSession`
checks the prefix.

**Flow 2: eager dual-seat assignment.** `Registry.createTableReserving`
seats both the creator and a named `reservedFor` session atomically, so
the table lands directly in `#active`:

```motoko
let nextId = registry.peekNextTableId();
switch (registry.createTableReserving(spec, now, mySession, #p1, #open, CanisterPlayers.sidForCanister(botPrincipal, nextId, "Hard"), "")) {
  case (#ok id) { /* both seats live, id == nextId */ };
  case (#err e) { /* ... */ };
};

```

It rejects a self-reservation and a `reservedFor` already busy
elsewhere. It only ever creates a brand-new table, so it cannot fill an
already-staged table's open seat — the examples' "Add Bot" controls use
Flow 1 (the bot's own `play` → `join_table_as_canister`) for that. No
`ws.mo` request reaches this call; an orchestrator seating two bots
would call it directly from Motoko.

**Writing the bot.** `MoveRequest<S, M>` carries `game`/`seat`/`mode`/
`turn`/`gen`/`complexity` (what a human's screen sees) and
`opponent`/`opponentLastMove`/`lastRoundDurationNs` (for a bot that
remembers). A bot that only reads the first group can be a pure function
and declare `make_move` as a `query` — every example bot does. A bot
that remembers anything across calls must declare `make_move` as an
update method: a query's state changes are never committed. That costs
consensus latency, so size `claimTimeoutNs`/`idleTimeoutNs` more
generously. Per-match memory keys off `(tableId, gen)` (`gen` bumps on
every fresh stage, rematch included); per-opponent memory keys off
`opponent` for a human (stable across tables) or
`principalOfCanisterSession(opponent)` for a canister (whose session is
per-table). `opponentLastMove` is always the last RESOLVED move, never
the pending one. See `skills/duel-game-core/references/canister-player-bots.md`.

**Bot discovery.** A bot self-registers with the host so a human can
challenge it from a frontend's "🤖 Bots" dialog with no hardcoded bot id:

```motoko
public type BotInfo = {
  principal : Principal;
  name : Text;
  complexities : [Text];
  registeredAt : Int;
};
public type BotComplexityEntry = { complexity : Text; elo : ?Int };
public type BotEntry = {
  principal : Principal;
  name : Text;
  complexities : [BotComplexityEntry];
};
public type BotDirectory = { var bots : Map.Map<Principal, BotInfo> };

public func newBotDirectory() : BotDirectory;
public func registerBot(d, caller, name, complexities, now); // upsert by principal
public func unregisterBot(d, caller);
public func listBots(d) : [BotInfo];
public func rankedBots(bots, scoreOf : (Principal, Text) -> ?Int) : [BotEntry]; // best complexity first, unrated last
public func leaderboardKey(p, complexity) : Text; // "cp:" # p # ":" # complexity
public func leaderboardKeyOfSession(session) : Text;

```

`registerBot` keeps the declared order, normalizes `""` to `"Default"`,
drops duplicates, and replaces `[]` with `["Default"]`. `rankedBots`
takes a scoring function so this module stays free of `leaderboard.mo`;
the mixin's `list_bots` joins each complexity with
`Leaderboard.scoreOf(lb, leaderboardKey(p, c))` (or `null` when no
leaderboard is wired). On the bot's side:

```motoko
public shared func register(host : Principal.Principal, name : Text) : async () {
  let h : actor { register_bot : (Text, [Text]) -> async () } = actor (host.toText());
  await h.register_bot(name, BotLogic.COMPLEXITIES); // [] for one way to play
};

```

Called once by hand after both canisters are deployed:
`icp canister call bot register '(principal "<host-canister-id>", "RacerBot")'`.
The frontend then calls the chosen bot's `play` directly (Flow 1); a
human's rematch against a bot is that same `play` re-issued onto the
rematch staging, since principal + table id + complexity derive the
reserved session again.

### Leaderboard

Opt-in, across three game-agnostic modules and two `Ws.attach` hooks:

- `mo:duel-game-core/leaderboard` — `Board`, always sorted
  highest-first. `Leaderboard.new(keep, defaultScore)` (`keep` is a
  buffer, typically 2× what you show; `defaultScore` is the host's own
  starting score), `setScore` (overwrite — ratings), `recordIfBetter`
  (strict improvement only — personal bests), `get`, `scoreOf` (score or
  `defaultScore`), `top(n)`.
- `mo:duel-game-core/elo` — `Elo.update(ratingA, ratingB, outcome, k)`
  returns both new ratings, zero-sum. No starting-rating opinion.
- `mo:duel-game-core/leaderboard_actor_mixin` — `include
LeaderboardActorMixin(leaderboard, 25)` supplies `get_leaderboard()`.
- `onGameEnded : (TableId, SessionId, SessionId, Debrief<S>) -> ()` fires
  once per game ending (`submit`/`claimWin`/`leave` producing a fresh
  `#debrief`, detected via `Debrief.since == now`). `onGameStarted :
(TableId, SessionId, SessionId) -> ()` fires once a table freshly
  enters `#active` (`turn == 0`, no pending move, `lastActivity == now`).
  Both are synchronous and fire for canister players' moves too.
- **Player identity, not session identity.** Use `Ws.playerKey(sid)` for
  `ii:`/`an:`; a `cp:` session is per-table, so a host wiring canister
  players special-cases `CanisterPlayers.leaderboardKeyOfSession(sid)`
  first. That key is per bot AND per complexity, matching what
  `list_bots` joins with.

ELO shape (`007`, `checkers`, ...; every ending re-rates both seats):

```motoko
let STARTING_ELO : Int = 1200;
let leaderboard = Leaderboard.new(50, STARTING_ELO); // keep 50, show 25

func onGameEnded(_id : TP.TableId, p1 : TP.SessionId, p2 : TP.SessionId, d : TP.Debrief<Rules.State>) {
  let outcome : Elo.Outcome = switch (d.end) {
    case (#finished(#p1Wins)) #aWins;
    case (#finished(#p2Wins)) #bWins;
    case (#finished(#draw)) #draw;
    case (#claimed(#p1)) #aWins;
    case (#claimed(#p2)) #bWins;
    case (#aborted(#p1)) #bWins;
    case (#aborted(#p2)) #aWins;
  };
  let (k1, k2) = (Ws.playerKey(p1), Ws.playerKey(p2));
  let (r1, r2) = Elo.update(Leaderboard.scoreOf(leaderboard, k1), Leaderboard.scoreOf(leaderboard, k2), outcome, 32);
  let now = Time.now();
  Leaderboard.setScore(leaderboard, k1, r1, now);
  Leaderboard.setScore(leaderboard, k2, r2, now);
};
// Ws.attach(..., null, ?onGameEnded, null);
include LeaderboardActorMixin(leaderboard, 25);

```

Best-lap shape (`racing`; lower is better, converted before storing;
`defaultScore` is an inert placeholder; no `onGameStarted`, since each
round is a fixed 1000ms of in-game time and `distanceFromStart / speed`
of the winning car is the final round's overshoot):

```motoko
let leaderboard = Leaderboard.new(50, 0);
let ONE_HOUR_MS : Int = 3_600_000;
func scoreFromLapMs(ms : Int) : Int = Int.max(0, ONE_HOUR_MS - ms);

func lapMsFor(car : Rules.CarState, turns : Nat) : Int {
  let overshoot = if (car.speed > 0.0) Float.max(0.0, Float.min(0.999, car.distanceFromStart / car.speed)) else 0.0;
  Float.nearest((turns.toFloat() - overshoot) * 1000.0).toInt();
};

func onGameEnded(_id : TP.TableId, p1 : TP.SessionId, p2 : TP.SessionId, d : TP.Debrief<Rules.State>) {
  switch (d.end) {
    case (#finished(#p1Wins)) ignore Leaderboard.recordIfBetter(leaderboard, Ws.playerKey(p1), scoreFromLapMs(lapMsFor(d.finalGame.p1, d.turns)), Time.now());
    case (#finished(#p2Wins)) ignore Leaderboard.recordIfBetter(leaderboard, Ws.playerKey(p2), scoreFromLapMs(lapMsFor(d.finalGame.p2, d.turns)), Time.now());
    case (_) {}; // nobody finished a lap
  };
};

```

A metric that genuinely needs real elapsed time wires `onGameStarted`
and keeps a `Map<TableId, Int>` of start times — see the skill's
"Leaderboard" step. The frontend's `renderLeaderboard` calls the optional
`GamePlugin.formatScore` to invert a conversion like `scoreFromLapMs`.

### Metrics

Opt-in: `mops add promtracker`, then `registry.attachMetrics(pt)` right
after `Registry.new`. Four metrics, scoped to that registry:

- `games_started` (counter) — each `#staging -> #active` transition.
- `active_games` (gauge) — recomputed after any call that can change it.
- `rounds_per_game` (gauge) — the just-finished game's `Debrief.turns`;
  a snapshot, so use `avg_over_time` for a distribution.
- `matchmaking_wait_seconds` (gauge) — how long the table sat in
  `#staging` before a game started.

```motoko
import PT "mo:promtracker";
import Http "mo:promtracker/mixins/http";

persistent actor {
  let pt = PT.Tracker.new(); // plain data — stable
  transient let renderer = PT.Renderer(); // closures — rebuilt on upgrade
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let registry = Registry.new<Rules.State, Rules.Action>(90_000_000_000, 60_000_000_000);
  registry.attachMetrics(pt);
  // ...
  include Http(renderer.renderExposition, "/metrics");
};

```

### Build, test, benchmark

```
mops install
mops test
mops bench   # bench/engine.bench.mo — engine overhead only, against test/FakeGame.mo
```

## Design

**Alternating-turn games.** An `#alternating` `resolve : (S, Seat, M) ->
...` runs the instant the on-turn seat submits. The engine derives whose
turn it is from the round counter (`p1` first, then alternating), so `S`
needs no turn flag, and rejects an off-turn submission with
`Err.#notYourTurn` before `validate` runs. Only the seat WAITING on the
other's turn may `claimWin`; the on-turn seat gets `#wrongPhase`.

**Rule contract for `Spec<S, M>`:**

- Pure: no actor, no storage, no `Time`; new records, never mutation.
- `validate` is the only legality gate — for each seat's submission in
  `#simultaneous`, for the on-turn seat in `#alternating`.
- `resolve` returns the next state and, if the game ended, `?Verdict`
  (`#p1Wins`/`#p2Wins`/`#draw`); `null` means continue.

**Claiming an overdue win.** After `claimTimeoutNs` (independent of and
normally well below `idleTimeoutNs`), the waiting player may end the
match with `End.#claimed seat`; `resolve` is not run and the state stays
as it was. Too early is `Err.#notOverdue { secondsLeft }`.

**Design guarantees** (each maps to a bug class in ad-hoc backends; all
hold at both the `Table` and `Registry` layer):

1. **Race-free rematch.** Create-then-join, seat reserved for the partner
   unless they already acked; the partner's `rematch`/`join` matches it,
   `leave` declines it. Actor serialization makes simultaneous clicks
   safe.
2. **No ghost lobbies.** Every phase carries a timestamp; an idle table
   is evictable and resurfaces in `listTables` in every phase.
3. **Server-side legality.** `validate` for both players, always.
4. **No silent endings.** `#aborted`, `#claimed`, and `#endedByOther`
   (until acked, or pruned by `Table.pruneEnded` after a generous
   multiple of the idle timeout).
5. **Leave means left.** A session that acked its debrief is no longer a
   participant, even while the phase lingers for the partner.
6. **Replay-safe.** `gen`/`turn` mismatches come back `#stale`.

## Implementation notes

- **The engine owns time.** `now` is a parameter everywhere; engine
  modules never import `Time`. That is what makes the suites
  deterministic.
- **`status` is pure.** Idle resets happen only in mutating calls.
- **Pending moves are hidden by construction.** `status` exposes only
  Booleans about the opponent's pending move.
- **Module layout.** `lib.mo` is the type surface; `table.mo`/
  `registry.mo` the operations; `ws.mo` + `actor_mixin.mo` the mandatory
  transport, kept separate only to confine the CDK dependency;
  `canister_players.mo` + `canister_players_actor_mixin.mo`,
  `leaderboard.mo` + `elo.mo` + `leaderboard_actor_mixin.mo` are
  optional.
- `test/FakeGame.mo`/`FakeTurnGame.mo` are throwaway specs for the
  suites and benchmarks, not games.

## Copyright

MR Research AG, 2026

## Authors

Main author: TimoHanke

Contributors: AndyGura

## License

Apache-2.0
