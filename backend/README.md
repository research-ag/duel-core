# duel-game-core for Motoko

## Overview

A generic 2-player multi-table session engine for the Internet Computer.
It handles everything a 2-player game needs except the game itself. Read
[`../DESIGN.md`](../DESIGN.md) first for the overall shape, with
diagrams; this page is the API.

- **Players** — a player is the caller's principal (a bot:
  `cp:<principal>:<complexity>`); the anonymous principal is refused.
  One player may sit at up to `MAX_TABLES_PER_PLAYER` (3) tables at once.
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
  automatic for a human (a bot's is claimed for it).
- **Idle takeover** — after `idleTimeoutNs`, third parties may reset a
  dead game or start over an expired debrief. A table waiting for an
  opponent is never taken over: the sweep clears it once it is past
  `idleTimeoutNs` and its creator stopped sending `duel_keep_alive`.
  Abandoned tables are garbage-collected, including pruning
  `#endedByOther` notices nobody will ever ack.
- **Views** — one truthful per-caller `View` of a table, including the
  `#endedByOther` notice after a takeover, and the browsable table list.
- **Reading by query** — every table and the lobby carry a `rev`; a
  client polling with the `rev` it holds gets `#unchanged` until
  something changed. Nothing is stored per reader.

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
  created once with `Registry.new()` (inside `Transport.new()`) and
  tuned with `setTimeouts(idleTimeoutNs, claimTimeoutNs)`.
  `createTable`/`createTableReserving`/`listTables`/`joinTable` create,
  discover, and join tables; `submit`/`rematch`/`leave`/`reset`/
  `claimWin`/`ackEnded`/`view` name their table by id and delegate to
  `Table`. `tablesOf(player)` lists the tables a player has business at
  (seated, reserved for, or holding an unacked notice) — read off the
  tables, never stored; `MAX_TABLES_PER_PLAYER` caps it
  (`#tooManyTables`). `sweep` evicts and garbage-collects across every
  table, sparing a waiting table whose creator passes the `isPresent`
  predicate. `attachMetrics(pt)` is optional (see Metrics).
  `peekNextTableId` is a pure read of the id nonce.
- `src/http.mo` + `src/wasm.mo` + `src/http_actor_mixin.mo`
  (`mo:duel-game-core/http_actor_mixin`) — `http_request` over a list of
  plain-text routes; every host serves its rules at `/semantics` (see
  "Semantics over HTTP") and its own module at `/wasm`, uploaded by its
  deploy (see "Downloadable wasm").
- Every mutating operation takes `spec` and `now : Int` (nanoseconds).
  At the `Registry` layer they are called only from
  `mo:duel-game-core/transport` (and `canister_players`) — never exposed
  as plain Candid methods.
- `View<S>` — one table's per-caller screen: `#lobby`, `#busy`,
  `#stagingYou`, `#awaitingRematch`, `#inGame`, `#debrief`,
  `#endedByOther`. Every `Table` also carries `rev`, bumped by the
  transport on every change.

`Registry<S, M>` and `Table<S, M>` are stable types whenever `S`/`M`
are; the `Spec` is passed on every call and never stored. The timeouts
are stored, so a host re-applies them right after the declaration (see
"Timeouts and upgrades").

## Usage

```
mops add duel-game-core
```

(Unpublished: use a local path dependency until it ships to mops.one.)

A complete minimal host — the skill's `templates/Host.mo.template`:

```motoko
import TP "mo:duel-game-core";
import Registry "mo:duel-game-core/registry";
import Transport "mo:duel-game-core/transport";
import TransportActorMixin "mo:duel-game-core/transport_actor_mixin";
import HttpActorMixin "mo:duel-game-core/http_actor_mixin";
import Rules "YourGameRules"; // implements TP.Spec<S, M>

actor {
  // The tables — plain data, stable.
  let state = Transport.new<Rules.State, Rules.Action>();
  state.registry.setTimeouts(90_000_000_000, 60_000_000_000); // 90s idle, 60s claim window

  // The state plus the rules (functions — rebuilt on upgrade).
  transient let duel = Transport.Duel<Rules.State, Rules.Action>(state, Rules.spec(), null, null);

  // Every non-generic method, the duel_lobby query and the sweep timer.
  include TransportActorMixin<system>(duel.lobby);

  // The two methods whose Candid types depend on the game.
  public shared ({ caller }) func duel_submit(tableId : TP.TableId, gen : Nat, turn : Nat, move : Rules.Action) : async Transport.Reply<Rules.State> {
    duel.reply(caller, tableId, await* duel.submit<system>(caller, tableId, gen, turn, move));
  };

  public shared query ({ caller }) func duel_table(tableId : TP.TableId, rev : Nat) : async Transport.TableResult<Rules.State> {
    duel.table(caller, tableId, rev);
  };

  include HttpActorMixin([("/semantics", func() : Text = Rules.SEMANTICS)]);
};

```

`Registry` is imported for its dot-notation functions
(`state.registry.setTimeouts`). The third and fourth arguments of
`Transport.Duel` add canister players and a leaderboard (below).

### Timeouts and upgrades

`Registry.new()` takes no arguments and starts at 90s idle / 60s claim.
`state` is a stable actor field (moc 2 actors are persistent), so its
initializer runs on the first install only: an upgrade keeps the stored
record, numbers included. The host's own timeouts therefore live in
`state.registry.setTimeouts(idle, claim)` on the line after the
declaration, which runs on every install and upgrade and applies them to
the registry and to every table already in it. The `Duel` (a
`transient let`) is rebuilt on every upgrade from the same data.

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

### Transport

`src/transport.mo` (`mo:duel-game-core/transport`) is the only client
interface. [`../DESIGN.md`](../DESIGN.md) has the flows as diagrams.

**Data and behaviour.** `Transport.State<S, M>` (from `Transport.new()`)
is a plain record — the registry, the lobby's `rev`, presence — and is
stable. `Transport.Duel<S, M>(state, spec, bots, scoring)` is a class
binding it to the function values that cannot be stable: the `Spec`,
optionally `?{ store; call }` for canister players and
`?{ board; rating }` for a leaderboard. The host keeps it in a
`transient let`, so it is rebuilt on every upgrade.

**Methods.** A player is the caller (`Transport.playerOf(caller)`;
the anonymous principal is `#unauthorized`).

| Method                                                  | Kind                  | Answers                                            |
| ------------------------------------------------------- | --------------------- | -------------------------------------------------- |
| `duel_lobby(rev)`                                       | query                 | `#unchanged`, or `#changed { rev; tables; yours }` |
| `duel_table(tableId, rev)`                              | query, host-declared  | `#unchanged`, `#changed { rev; view }`, or `#gone` |
| `duel_submit(tableId, gen, turn, move)`                 | update, host-declared | `#view { rev; view }` or `#err`                    |
| `duel_create_table(seat, visibility, variant)`          | update                | `Ack`                                              |
| `duel_join_table(tableId, seat, code)`                  | update                | `Ack`                                              |
| `duel_rematch(tableId)`                                 | update                | `Ack`                                              |
| `duel_leave(tableId, gen)` / `duel_reset(tableId, gen)` | update                | `Ack`                                              |
| `duel_claim_win(tableId, gen)`                          | update                | `Ack`                                              |
| `duel_ack_ended(tableId)`                               | update                | `Ack`                                              |
| `duel_keep_alive()`                                     | update                | `#ok`                                              |

`Ack = Res<{ tableId; rev }>`: the table the call was about and its
`rev` after it. A query with `rev = 0` always answers with the current
state. `yours` lists every table the caller has business at.

**Revs.** Every `Table` has a stable `rev`, bumped by every mutation of
that table (and by the sweep when it changes one); the lobby's `rev`
(`state.lobbyRev`) is bumped by every lobby method and by a sweep that
changed anything. A `duel_submit` does not move the lobby. A client
follows one source — the lobby, or one table — with the `rev` it holds,
and applies only views newer than the last it applied from that source.

**Ordering.** Two independent update calls have no guaranteed relative
order, so the client sends one at a time and waits for each reply. The
canister queues nothing.

**Why two kinds of reply.** `duel_submit` returns the fresh view: in
`#alternating` that includes a canister player's answer, in
`#simultaneous` the resolved round for the second seat to submit. The
lobby methods return an `Ack` and the client polls the table: they
start or end a game, which can afford one poll, and keeping `State` out
of them lets the non-generic `TransportActorMixin` supply them.
`Duel.submit` returns only `?Err` and `Duel.reply` builds the view,
because an `async*` result must be a shared type and `Reply<S>` is not.

**Presence and the sweep.** `duel_keep_alive()` records the caller as
present and does nothing else; a client sends it every
`KEEP_ALIVE_SECS` (20) while waiting at a table for an opponent. The
mixin's timer runs `Duel.sweep` every `SWEEP_SECS` (30): it clears
expired tables (a waiting one survives while its creator is present —
heard from within `PRESENCE_TTL_NS`, 60 s), bumps the revs of what it
changed, prunes presence, and settles canister players everywhere.
Silence never ends a game in progress; `claimWin` and idle takeover do.

**Replay safety.** `duel_submit`/`duel_leave`/`duel_reset`/
`duel_claim_win` carry the `gen` (and `submit` the `turn`) the client
last saw. The client resends a call it cannot tell landed or not, so
without this a resent `submit` could replay against a later round, and a
resent `leave`/`reset` could abort a new match. A mismatch is
`Err.#stale`. `create`/`join`/`rematch`/`ackEnded` recompute from live
state and need no binding.

**Wiring** — see "Usage" above; `examples/*/src/Host.mo` for hosts with
bots and a leaderboard. The frontend's `makeIdlFactory` declares every
method; `connectTransport()` drives them.

### Canister players

`mo:duel-game-core/canister_players` lets a canister take a seat. Two
canisters calling each other with `await` already form an ordered
request/response channel, so the game canister calls the player
canister's `make_move` and treats the reply as the move — never a "your
turn" notice followed by an independent callback, which would reopen the
unordered-second-channel race. Nothing can be spoofed: the reply comes
from the principal this module decided to call.

**Identity.** A bot's player id is `idForCanister(p, complexity)` =
`"cp:" # p # ":" # complexity`, derived from `msg.caller`. With several
tables per player, one bot sits at many tables under one id per
complexity. `leave`/`ackEnded`/`claimWin`/`reset` take a `tableId` and
find the caller's seat on that board (`idAt`).
`principalOfCanisterSession`/`complexityOfCanisterSession` read the two
segments back; `isCanisterSession` checks the prefix.

**Complexity.** A bot may offer several ways to play ("Easy"/"Hard",
"Rabbit"/"Fox"/"Lion", ...). Each is a `complexity : Text`, opaque here.
The bot declares its list at registration; whoever seats it picks one,
which becomes part of its player id and reaches the bot as
`MoveRequest.complexity` on every ask. A bot with one way to play
registers `[]` and is listed under `DEFAULT_COMPLEXITY` (`"Default"`);
every complexity is rated separately (`leaderboardKey(p, complexity)`
is the player id).

**Data and wiring.** `CanisterPlayers.newStore()` is a stable record
(the bot directory, in-flight asks, tables settling inside a reply).
The host passes it to the `Duel` together with its `CallBot`, the one
thing only the host can do (a call returning a generic `M` does not
type-check inside the library):

```motoko
import Principal "mo:core/Principal";
import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
import BotIface "BotIface"; // this game's CanisterPlayer actor type

actor {
  let state = Transport.new<Rules.State, Rules.Action>();
  let bots = CanisterPlayers.newStore();

  func callBot<system>(bot : TP.PlayerId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    let b : BotIface.CanisterPlayer = actor (CanisterPlayers.principalOfCanisterSession(bot).toText());
    try { await* k<system>(?(await b.make_move(req))) } catch (_) {
      await* k<system>(null);
    };
  };

  transient let duel = Transport.Duel<Rules.State, Rules.Action>(state, Rules.spec(), ?{ store = bots; call = callBot }, null);

  include TransportActorMixin<system>(duel.lobby);
  include CanisterPlayersActorMixin(duel.canisterPlayers, bots.directory, null); // ?leaderboard if wired
  // ...duel_submit / duel_table as in "Usage"
};

```

`CallBot` is continuation-passing — the host calls `k(?move)` on a
reply, `k(null)` on a trap — and carries `<system>` because applying
the move may arm a timer.

**Settling.** After every mutation the `Duel` runs `settle(table)`: for
an `#active` table, a bot seat due to move
(`View.#inGame.youSubmitted == false`, "due" in either mode) when the
settle begins is asked; a WAITING bot seat with `claimWinAvailable`
claims the win; a waiting seat not yet overdue arms one timer for the
moment it will be. For a `#debrief`, a bot seat is acked (a second
`leave`) once the other seat is no longer a live participant or is
itself a bot, so two bots never deadlock and a deciding human's rematch
window is never cut short. A one-bit in-flight flag per (table, seat)
prevents double asks. A bot seat that becomes due inside another bot's
reply is asked from a fresh message (a zero-second timer), so a
bot-vs-bot match advances one move per message and no call carries a
whole match. The sweep settles every table as the slow fallback.

**Asking.** `notifyAndApply` builds a `MoveRequest<S, M>` from the
table's own view (plus `opponent`/`opponentLastMove`/
`lastRoundDurationNs`, read off the `Active` record), calls `CallBot`,
re-reads `gen`/`turn` after the reply (the human may have claimed, left,
or been swept meanwhile), submits, and runs the transport's fan-out. An
`#illegalMove` reply is retried once with `retryReason` set to
`validate`'s text; a trap, error, or any other rejection is treated as
silence and left to `claimTimeoutNs`/`idleTimeoutNs`.

**The mixin** supplies `create_table_as_canister`/`join_table_as_canister`/
`leave_as_canister`/`ack_ended_as_canister`/`claim_win_as_canister`/
`reset_as_canister` plus `register_bot`/`unregister_bot`/`list_bots`.
There is no `submit_as_canister` (a move only ever arrives as the reply
to `make_move`) and no `rematch_as_canister` (a bot-vs-bot debrief
auto-acks; a human-vs-bot rematch is the human's frontend re-issuing
`play`). A lobby shows "vs 🤖" from `TableSummary.p1Session`/
`p2Session` (the occupant's player id) and `isCanisterSession`.

**Eager dual-seat assignment.** `Registry.createTableReserving` seats
both the creator and a named `reservedFor` player atomically, so the
table lands directly in `#active`. No transport method reaches it; an
orchestrator seating two bots would call it from Motoko. It rejects a
self-reservation and a reservee already at the table cap.

**Writing the bot.** `MoveRequest<S, M>` carries `game`/`seat`/`mode`/
`turn`/`gen`/`complexity` (what a human's screen sees) and
`opponent`/`opponentLastMove`/`lastRoundDurationNs` (for a bot that
remembers). A bot that only reads the first group can be a pure
function and declare `make_move` as a `query` — every example bot does.
A bot that remembers anything across calls must declare `make_move` as
an update method: a query's state changes are never committed. That
costs consensus latency, so size `claimTimeoutNs`/`idleTimeoutNs` more
generously. Per-match memory keys off `(tableId, gen)` (`gen` bumps on
every fresh stage, rematch included); per-opponent memory keys off
`opponent`. `opponentLastMove` is always the last RESOLVED move. See
`skills/duel-game-core/references/canister-player-bots.md`.

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

public func registerBot(d, caller, name, complexities, now); // upsert by principal
public func unregisterBot(d, caller);
public func listBots(d) : [BotInfo];
public func rankedBots(bots, scoreOf : (Principal, Text) -> ?Int) : [BotEntry]; // best complexity first, unrated last
public func leaderboardKey(p, complexity) : Text; // the bot's player id

```

`registerBot` keeps the declared order, normalizes `""` to `"Default"`,
drops duplicates, and replaces `[]` with `["Default"]`. The mixin's
`list_bots` joins each complexity with its leaderboard score (or `null`
when no leaderboard is wired). On the bot's side:

```motoko
public shared ({ caller }) func register(host : Principal.Principal, name : Text) : async () {
  assert caller.isController();
  let h : actor { register_bot : (Text, [Text]) -> async () } = actor (host.toText());
  await h.register_bot(name, BotLogic.COMPLEXITIES); // [] for one way to play
};

```

Called once by hand after both canisters are deployed (and again after
a reinstall of the game):
`icp canister call bot register '(principal "<host-canister-id>", "RacerBot")'`.
The frontend then calls the chosen bot's `play`, which joins through
`join_table_as_canister`; a human's rematch against a bot is that same
`play` re-issued onto the rematch staging.

### Leaderboard

Opt-in. The `Duel` scores every freshly finished game itself; the host
only declares the board and picks the rating:

```motoko
import Leaderboard "mo:duel-game-core/leaderboard";
import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin";

let leaderboard = Leaderboard.new(50, 1200); // keep 50, start at 1200 — stable
transient let duel = Transport.Duel<Rules.State, Rules.Action>(
  state,
  Rules.spec(),
  null,
  ?{ board = leaderboard; rating = #elo { k = 32 } },
);
include LeaderboardActorMixin(leaderboard, 25); // get_leaderboard(), top 25

```

- `#elo { k }` re-rates both seats on every ending (`Elo.update`);
  `#claimed`/`#aborted` count as wins for the other seat.
- `#best pick` — `pick : Debrief<S> -> ?(Seat, Int)` returns a seat and
  its score, kept with `recordIfBetter` (a strict improvement only). A
  lower-is-better metric is converted first. `examples/racing`:

```motoko
let leaderboard = Leaderboard.new(50, 0); // defaultScore is inert here
func scoreFromLapMs(ms : Int) : Int = Int.max(0, 3_600_000 - ms);

func bestLap(d : TP.Debrief<Rules.State>) : ?(TP.Seat, Int) {
  switch (d.end) {
    case (#finished(#p1Wins)) ?(#p1, scoreFromLapMs(lapMsFor(d.finalGame.p1, d.turns)));
    case (#finished(#p2Wins)) ?(#p2, scoreFromLapMs(lapMsFor(d.finalGame.p2, d.turns)));
    case (_) null; // nobody finished a lap
  };
};
// Transport.Duel(..., ?{ board = leaderboard; rating = #best bestLap })

```

- `mo:duel-game-core/leaderboard` — `Board`, always sorted
  highest-first: `new(keep, defaultScore)`, `setScore`, `recordIfBetter`,
  `get`, `scoreOf`, `top(n)`. `mo:duel-game-core/elo` —
  `Elo.update(ratingA, ratingB, outcome, k)`, zero-sum.
- Keys are player ids: a human's principal text, a bot's
  `cp:<principal>:<complexity>` — so a bot is rated per complexity,
  matching what `list_bots` shows. The frontend's `renderLeaderboard`
  calls the optional `GamePlugin.formatScore` to invert a conversion
  like `scoreFromLapMs`.

### Metrics

Every host built from the skill's template wires these (`promtracker` in
`mops.toml`, `state.registry.attachMetrics(pt)` right after
`Transport.new`, and a `/metrics` route). The engine itself does not
require them: a registry without `attachMetrics` records nothing. Four
metrics, scoped to that registry:

- `games_started` (counter) — each `#staging -> #active` transition.
- `active_games` (gauge) — recomputed after any call that can change it.
- `rounds_per_game` (gauge) — the just-finished game's `Debrief.turns`;
  a snapshot, so use `avg_over_time` for a distribution.
- `matchmaking_wait_seconds` (gauge) — how long the table sat in
  `#staging` before a game started.

```motoko
import PT "mo:promtracker";
import Tracker "mo:promtracker/Tracker"; // brings `pt.toValue()` into scope

actor {
  let pt = PT.Tracker.new(); // plain data — stable
  transient let renderer = PT.Renderer(); // closures — rebuilt on upgrade
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let state = Transport.new<Rules.State, Rules.Action>();
  state.registry.setTimeouts(90_000_000_000, 60_000_000_000);
  state.registry.attachMetrics(pt);
  // ...
  include HttpActorMixin([
    ("/semantics", func() : Text = Rules.SEMANTICS),
    ("/metrics", renderer.renderExposition),
  ]);
};

```

### Semantics over HTTP

Every host serves its game's rules as plain text, so a person or an AI
agent holding nothing but the backend's canister id can learn the game:

```
curl https://<backend-id>.raw.icp0.io/semantics
```

`raw` is required: the responses are uncertified. Locally the same path
answers at `http://<backend-id>.raw.localhost:8000/semantics`.

The rules module owns the text as `public let SEMANTICS : Text` (a text
literal may span lines), and the host routes it:

```motoko
import HttpActorMixin "mo:duel-game-core/http_actor_mixin";

actor {
  // ...
  include HttpActorMixin([("/semantics", func() : Text = Rules.SEMANTICS)]);
};

```

`HttpActorMixin(routes)` supplies `http_request`; each `Http.Route` is a
path and a `() -> Text` answered as `text/plain` on `GET`. An unknown
path is a 404 listing the routes and `/wasm`. A host adds its own routes
to the same list — `/metrics` above, or data a client cannot recover
from `State` (`examples/racing` serves its track polygons at `/track`).
`http.mo`'s `respond` is the pure function behind it; `/wasm` is the
mixin's own (next section).

`SEMANTICS` is the whole contract a frontend author gets besides the
canister's Candid, and the only place `Action` is explained: the Candid
gives its type (in `duel_submit`), not what it means.
Write it for a reader who cannot see the source, in these sections:

- `GAME`, `MODE` (`simultaneous`/`alternating`), `SEATS` (which seat is
  which side, who moves first), `VARIANTS` (each table-variant key and
  what it changes, or `none`).
- `STATE (Candid)` and `ACTION (Candid)` — the exact Candid types
  (`Nat` is `nat`, `?T` is `opt T`, `[T]` is `vec T`, a tuple is a
  positional record), followed by what every field means: indexing,
  units, what `null` stands for.
- `RULES` — what each action does, and every condition `validate`
  rejects.
- `ENDINGS` — every win, loss and draw.
- `CLIENT NOTES` — anything a UI must know that the state does not say
  outright (how to find the opponent's last move, formulas a client must
  mirror to offer only legal input).

Update `SEMANTICS` in the same change as any edit to `State`, `Action`,
`validate` or `resolve`.

### Downloadable wasm

Anyone can download the exact wasm a backend runs and install a copy on
a local network — what lets a third party build and test a new frontend
against a game without its source. The IC itself hands out only a
canister's `module_hash`, never its module, so every backend on this
engine serves the module itself: `HttpActorMixin` keeps a copy of
the canister's own module in a stable `Wasm.Store` and streams it at
`GET /wasm` (first chunk in the body, the rest through
`http_request_streaming_callback`); the deploy puts it there. In
`icp.yaml`:

```yaml
- name: backend
  recipe:
    type: "@dfinity/motoko@v4.1.0"
    configuration:
      main: src/Host.mo
  sync:
    steps:
      - type: script
        commands:
          - sh publish_wasm.sh backend
```

`publish_wasm.sh` sits next to `icp.yaml` (the skill's
`templates/publish_wasm.sh.template`, copied unchanged) and runs after
every install, reinstall and upgrade. It takes the artifact icp-cli just
installed (`.icp/cache/artifacts/backend`), refuses to go on unless its
SHA-256 equals the canister's `module_hash`, and uploads it in 1 MiB
chunks through the mixin's controllers-only methods:
`wasm_upload_begin()` discards any staged chunks, `wasm_upload_chunk(blob)`
appends one, `wasm_upload_commit(size)` swaps the staged chunks in as
the served module, or traps and keeps the previous one when they do not
add up to `size` bytes. The methods run `Principal.isController` on the
caller; the deploying identity is a controller. Only the module is ever
published: the canister's heap, access codes of `#code` tables and
pending moves stay where they are. Never set `snapshot_visibility:
public` on a backend: a snapshot is the whole heap.

Downloading needs only the id; `icp-cli` supplies the hash to check
it against:

```bash
ID=<backend-id>
curl -s https://$ID.raw.icp0.io/wasm -o backend.wasm
shasum -a 256 backend.wasm                 # equals `module_hash` (without 0x) from
icp canister status $ID -n ic -p --json
icp canister metadata $ID candid:service -n ic > backend.did
```

`backend.wasm` then becomes a local copy through the
`@dfinity/prebuilt` recipe (`path` + `sha256`, which icp-cli verifies
on every build), with `icp canister link backend $ID -e ic` tying the
name to the live canister for the `ic` environment only; the skill's
`references/frontend-for-existing-game.md` and
`references/bot-for-existing-game.md` have the whole procedure.

A 404 at `/wasm` ("No module uploaded yet") means the sync step has not
run against this install: run `icp sync backend -e <env>`. A hash that
differs from `module_hash` means the same, after a deploy whose sync
step failed; the script's own hash check makes that the only way the two
can disagree.

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
2. **No ghost lobbies.** Every phase carries a timestamp; an idle game
   or debrief is evictable and resurfaces in `listTables`, and an idle
   staging whose occupant is gone is swept.
3. **Server-side legality.** `validate` for both players, always.
4. **No silent endings.** `#aborted`, `#claimed`, and `#endedByOther`
   (until acked, or pruned by `Table.pruneEnded` after a generous
   multiple of the idle timeout).
5. **Leave means left.** A player who acked their debrief is no longer a
   participant, even while the phase lingers for the partner.
6. **Replay-safe.** `gen`/`turn` mismatches come back `#stale`.
7. **Cheap reads, nothing per reader.** A query with an unchanged `rev`
   costs one comparison; no record exists per client.

## Implementation notes

- **The engine owns time.** `now` is a parameter everywhere; engine
  modules never import `Time`. That is what makes the suites
  deterministic. `transport.mo` and `canister_players.mo` play the
  host's role and call `Time.now()` themselves.
- **Views are pure.** Idle resets happen only in mutating calls.
- **Pending moves are hidden by construction.** A view exposes only
  Booleans about the opponent's pending move.
- **Module layout.** `lib.mo` is the type surface; `table.mo`/
  `registry.mo` the operations; `transport.mo` +
  `transport_actor_mixin.mo` the mandatory transport (plus the host's
  own `duel_submit`/`duel_table`);
  `canister_players.mo` + `canister_players_actor_mixin.mo`,
  `leaderboard.mo` + `elo.mo` + `leaderboard_actor_mixin.mo` are
  optional, wired through the `Duel` class.
- `test/FakeGame.mo`/`FakeTurnGame.mo` are throwaway specs for the
  suites and benchmarks, not games.

## Copyright

MR Research AG, 2026

## Authors

Main author: TimoHanke

Contributors: AndyGura

## License

Apache-2.0
