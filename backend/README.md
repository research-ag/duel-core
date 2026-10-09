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
  submitted; a `#turnBased` game applies each action the instant the
  seat on turn submits it — and the rules decide whose turn it is.
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

Four type parameters, all chosen by the game's rules module: `S` (the
full game state), `M` (one action), `V` (what one seat may see of the
state — the game's `view`; `V = S` when nothing is hidden) and `O` (a
table's options, picked by its creator). Types live in `src/types.mo`,
re-exported by `src/lib.mo` (`mo:duel-game-core`).

- `Spec<S, M, V, O>` — the game's pure functions, tagged by `Mode`:

```motoko
public type Spec<S, M, V, O> = {
  #turnBased : {
    checkOptions : (O) -> ?Text; // null = sensible; ?why = the table is not opened
    init : (O, Rng) -> S;
    toMove : (S) -> Seat; // whose action the game is waiting for
    move : (S, Seat, M, Rng) -> {
      // checks and applies one action
      #ok : { state : S; verdict : ?Verdict };
      #err : Text; // the reason, shown to the player
    };
    view : (S, Seat, Bool) -> V; // what the seat sees; the Bool: the game is over
  };
  #simultaneous : {
    checkOptions : (O) -> ?Text;
    init : (O, Rng) -> S;
    validate : (S, Seat, M) -> ?Text; // only checks: null = legal, ?text = rejection
    resolve : (S, M, M, Rng) -> { state : S; verdict : ?Verdict };
    view : (S, Seat, Bool) -> V;
  };
};

```

A rules module exports these and a constant `spec` bundling them —
see `../DESIGN.md`, "What a game supplies", for the reasoning behind
each. `Rng` (`mo:duel-game-core/rng`) is the framework's random-number
generator, one per canister in the stable data: `rng.next()`,
`rng.below(n)` (uniform in `0..n-1`), `rng.shuffle(xs)`.

- `src/table.mo` (`mo:duel-game-core/table`) — `Table<S, M, O>`, one
  board: `Table.new(idleTimeoutNs, claimTimeoutNs, visibility,
createdBy, options)` plus `join`/`submit`/`rematch`/`leave`/`reset`/
  `claimWin`/`ackEnded`/`status`/`sweep`. For a game that wants exactly one fixed
  board and no lobby.
- `src/registry.mo` (`mo:duel-game-core/registry`) — `Registry<S, M, O>`,
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
- Every mutating operation takes `spec`, the `rng` and `now : Int`
  (nanoseconds).
  At the `Registry` layer they are called only from
  `mo:duel-game-core/transport` (and `canister_players`) — never exposed
  as plain Candid methods.
- `TableView<V>` — one table's per-caller screen: `#lobby`, `#busy`,
  `#stagingYou`, `#awaitingRematch`, `#inGame` (the game's `V` for that
  seat, `step`, `mode`, `toMove`, the countdowns), `#debrief` (the final
  `V`, with `over = true`), `#endedByOther`. Every `Table` also carries
  `rev`, bumped by the
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
import Rules "YourGameRules"; // exports State, Action, View, Options and `spec`

actor {
  // All the data — tables, lobby, random-number generator. Stable.
  let duel = Transport.new<Rules.State, Rules.Action, Rules.Options>();
  duel.registry.setTimeouts(90_000_000_000, 60_000_000_000); // 90s idle, 60s claim window

  // The function values the framework calls — the rules. Rebuilt on upgrade.
  transient let env : Transport.Env<Rules.State, Rules.Action, Rules.View, Rules.Options> = {
    spec = Rules.spec;
    bots = null;
    scoring = null;
  };

  // Every method that names none of the game's types, and the sweep timer.
  include TransportActorMixin<system>(duel.lobby(env));

  // The four methods whose Candid types name the game's own types.
  public shared ({ caller }) func duel_create_table(seat : TP.Seat, visibility : TP.TableVisibility, options : Rules.Options) : async Transport.Ack {
    await* duel.createTable<system, Rules.State, Rules.Action, Rules.View, Rules.Options>(env, caller, seat, visibility, options);
  };

  public shared query ({ caller }) func duel_lobby(rev : Nat) : async Transport.LobbyResult<Rules.Options> {
    duel.lobbyView(caller, rev);
  };

  public shared ({ caller }) func duel_submit(tableId : TP.TableId, gen : Nat, step : Nat, action : Rules.Action) : async Transport.Reply<Rules.View> {
    duel.reply(env, caller, tableId, await* duel.submit<system, Rules.State, Rules.Action, Rules.View, Rules.Options>(env, caller, tableId, gen, step, action));
  };

  public shared query ({ caller }) func duel_table(tableId : TP.TableId, rev : Nat) : async Transport.TableResult<Rules.View> {
    duel.table(env, caller, tableId, rev);
  };

  include HttpActorMixin([("/semantics", func() : Text = Rules.SEMANTICS)]);
};

```

`Registry` is imported for its dot-notation functions
(`duel.registry.setTimeouts`). `env.bots` and `env.scoring` add canister
players and a leaderboard (below). The explicit type arguments on
`createTable`/`submit` are what moc requires once `<system>` is given.

### Timeouts and upgrades

`Registry.new()` takes no arguments and starts at 90s idle / 60s claim.
`duel` is a stable actor field (moc 2 actors are persistent), so its
initializer runs on the first install only: an upgrade keeps the stored
record, numbers included. The host's own timeouts therefore live in
`duel.registry.setTimeouts(idle, claim)` on the line after the
declaration, which runs on every install and upgrade and applies them to
the registry and to every table already in it. The `env` (a `transient
let`) is rebuilt on every upgrade from the rules module.

### Table options

A table's creator picks its options — the game's own type `O`, passed to
`createTable`/`createTableReserving`, stored on the `Table`, surfaced on
`TableSummary<O>`, and handed to `init`. The engine never interprets
them; it only asks the game whether they are sensible, through
`checkOptions`, and refuses to open a table otherwise (`#badOptions`).
A game without options uses the empty record:

```motoko
public type Options = {};
public func checkOptions(_ : Options) : ?Text = null;
public func init(_ : Options, _ : TP.Rng) : State = { ... };

```

A variant for a choice between rule sets (`examples/chopsticks`,
Rack-O); a record for parameters, with `checkOptions` bounding them
(`examples/rock-paper-scissors`):

```motoko
public type Options = { variant : Variant; winsNeeded : Nat };

public func checkOptions(o : Options) : ?Text {
  if (o.winsNeeded < 1 or o.winsNeeded > 9) ?"Wins needed must be 1 to 9." else null;
};

public func init(o : Options, _ : TP.Rng) : State = {
  p1Score = 0;
  p2Score = 0;
  lastRound = null;
  variant = o.variant;
  winsNeeded = o.winsNeeded;
};

```

Keep what the rules need on `S` (the variant, the target), so `move`/
`validate`/`resolve` branch on the state alone. The Candid interface
names `O` in `duel_create_table` and in the lobby listing, which is why
those two methods are the host's own (see "Transport").

Frontend: `GamePlugin.optionChoices()`/`formatOptions()` in
[`../frontend/README.md`](../frontend/README.md).

### Transport

`src/transport.mo` (`mo:duel-game-core/transport`) is the only client
interface. [`../DESIGN.md`](../DESIGN.md) has the flows as diagrams.

**Data and behaviour.** `Transport.Duel<S, M, O>` (from
`Transport.new()`) is a plain record — the registry, the lobby's `rev`,
presence, the `rng` — and is stable. Behaviour is module functions
written `duel.f(env, …)`, where `Transport.Env<S, M, V, O>` carries the
function values that cannot be stable: the `Spec`, optionally
`?{ store; call }` for canister players and `?{ board; rating }` for a
leaderboard. The host builds the `env` once in a `transient let`, so it
is rebuilt on every upgrade; nothing in `Duel` ever holds a function.

**Methods.** A player is the caller (`Transport.playerOf(caller)`;
the anonymous principal is `#unauthorized`).

| Method                                                  | Kind                  | Answers                                            |
| ------------------------------------------------------- | --------------------- | -------------------------------------------------- |
| `duel_lobby(rev)`                                       | query, host-declared  | `#unchanged`, or `#changed { rev; tables; yours }` |
| `duel_table(tableId, rev)`                              | query, host-declared  | `#unchanged`, `#changed { rev; view }`, or `#gone` |
| `duel_submit(tableId, gen, step, action)`               | update, host-declared | `#view { rev; view }` or `#err`                    |
| `duel_create_table(seat, visibility, options)`          | update, host-declared | `Ack`, or `#badOptions`                            |
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

**Why two kinds of reply.** `duel_submit` returns the fresh view — in
`#turnBased` the board after the action, with `toMove` saying whose
turn it is next (the mover's own again, after a draw or a repeat turn),
and a canister player's answer when one was due; in `#simultaneous` the
resolved round for the second seat to submit. The lobby methods return
an `Ack` and the client polls the table: they start or end a game,
which can afford one poll, and keeping the game's types out of them is
what lets the non-generic `TransportActorMixin` supply them.
`Transport.submit` returns only `?Err` and `Transport.reply` builds the
view, because an `async*` result must be a shared type and `Reply<V>`
is not.

**Steps.** `step` counts applied actions (`#turnBased`) or resolved
rounds (`#simultaneous`); a client stamps it on every submit. It is not
the game's notion of a turn — a turn may take several steps — which a
game that wants to show counts in its own state.

**Presence and the sweep.** `duel_keep_alive()` records the caller as
present and does nothing else; a client sends it every
`KEEP_ALIVE_SECS` (20) while waiting at a table for an opponent. The
mixin's timer runs `Duel.sweep` every `SWEEP_SECS` (30): it clears
expired tables (a waiting one survives while its creator is present —
heard from within `PRESENCE_TTL_NS`, 60 s), bumps the revs of what it
changed, prunes presence, and settles canister players everywhere.
Silence never ends a game in progress; `claimWin` and idle takeover do.

**Replay safety.** `duel_submit`/`duel_leave`/`duel_reset`/
`duel_claim_win` carry the `gen` (and `submit` the `step`) the client
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
The host passes it in the `env` together with `callBot`, the one
inter-canister call only game code can write (a call returning a generic
`M` does not type-check inside the library) — it lives in the game's
`BotIface.mo` next to the bot's actor type:

```motoko
// src/BotIface.mo
import Principal "mo:core/Principal";
import CanisterPlayers "mo:duel-game-core/canister_players";
import TP "mo:duel-game-core";
import Rules "YourGameRules";

module {
  public type CanisterPlayer = actor {
    make_move : (TP.MoveRequest<Rules.View, Rules.Action>) -> async Rules.Action;
  };

  /// Asks a seated bot canister for its move; the transport's `CallBot`.
  public func callBot<system>(bot : TP.PlayerId, req : TP.MoveRequest<Rules.View, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    let b : CanisterPlayer = actor (CanisterPlayers.principalOfCanisterSession(bot).toText());
    try { await* k<system>(?(await b.make_move(req))) } catch (_) {
      await* k<system>(null);
    };
  };
};

// src/Host.mo
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
import BotIface "BotIface";

actor {
  let duel = Transport.new<Rules.State, Rules.Action, Rules.Options>();
  let bots = CanisterPlayers.newStore();

  transient let env : Transport.Env<Rules.State, Rules.Action, Rules.View, Rules.Options> = {
    spec = Rules.spec;
    bots = ?{ store = bots; call = BotIface.callBot };
    scoring = null;
  };

  include TransportActorMixin<system>(duel.lobby(env));
  include CanisterPlayersActorMixin(duel.canisterPlayers(env), bots.directory, null); // ?leaderboard if wired
  // ...the four host methods as in "Usage"
};

```

`CallBot` is continuation-passing — the host calls `k(?move)` on a
reply, `k(null)` on a trap — and carries `<system>` because applying
the move may arm a timer.

**Settling.** After every mutation the transport runs `settle(table)`:
for an `#active` table, a bot seat due to move (`toMove` names it in
`#turnBased`, no move pending in `#simultaneous`) when the settle begins
is asked; a WAITING bot seat with `claimWinAvailable`
claims the win; a waiting seat not yet overdue arms one timer for the
moment it will be. For a `#debrief`, a bot seat is acked (a second
`leave`) once the other seat is no longer a live participant or is
itself a bot, so two bots never deadlock and a deciding human's rematch
window is never cut short. A one-bit in-flight flag per (table, seat)
prevents double asks. A bot seat that becomes due inside another bot's
reply — the other bot's, or its own after a multi-step or repeat turn —
is asked from a fresh message (a zero-second timer), so a bot-vs-bot
match advances one action per message and no call carries a whole
match. The sweep settles every table as the slow fallback.

**Asking.** `notifyAndApply` builds a `MoveRequest<V, M>` from the
bot's own view of the table — `game` is `view(s, seat, false)`, so a
bot is handed exactly what a human at that seat sees and never the
hidden parts — plus `opponent`/`opponentLastMove`/`lastStepDurationNs`
off the `Active` record, calls `CallBot`, re-reads `gen`/`step` after
the reply (the human may have claimed, left, or been swept meanwhile),
submits, and runs the transport's fan-out. An `#illegalMove` reply is
retried once with `retryReason` set to the rules' rejection text; a
trap, error, or any other rejection is treated as silence and left to
`claimTimeoutNs`/`idleTimeoutNs`.

**The mixin** supplies `join_table_as_canister`/`leave_as_canister`/
`ack_ended_as_canister`/`claim_win_as_canister`/`reset_as_canister` plus
`register_bot`/`unregister_bot`/`list_bots`. A bot never opens a table:
a human opens one and invites the bot (the lobby's "🤖 Bots" dialog,
which calls the bot's own `play`). There is no `submit_as_canister` (a
move only ever arrives as the reply to `make_move`) and no
`rematch_as_canister` (a bot-vs-bot debrief auto-acks; a human-vs-bot
rematch is the human's frontend re-issuing `play`). A lobby shows "vs 🤖" from `TableSummary.p1Session`/
`p2Session` (the occupant's player id) and `isCanisterSession`.

**Eager dual-seat assignment.** `Registry.createTableReserving` seats
both the creator and a named `reservedFor` player atomically, so the
table lands directly in `#active`. No transport method reaches it; an
orchestrator seating two bots would call it from Motoko. It rejects a
self-reservation and a reservee already at the table cap.

**Writing the bot.** `MoveRequest<V, M>` carries `game` (the view for
the bot's seat)/`seat`/`mode`/`step`/`gen`/`complexity` (what a human's
screen sees) and `opponent`/`opponentLastMove`/`lastStepDurationNs`
(for a bot that remembers). In a multi-step turn the bot is asked once
per step, each time with the view as it then is (Rack-O's bot sees the
drawn card only on its second ask). A bot that only reads the first group can be a pure
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

Opt-in, and each game picks the kind that fits: `#elo` is a rating
between players who play against each other; `#best` is an individual
personal best, for a game where each player achieves something on their
own (a lap time, a count of correct answers). The transport scores every
freshly finished game itself; the host only declares the board and picks
the rating in the `env`:

```motoko
import Leaderboard "mo:duel-game-core/leaderboard";
import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin";

let leaderboard = Leaderboard.new(50, 1200); // keep 50, start at 1200 — stable
transient let env : Transport.Env<Rules.State, Rules.Action, Rules.View, Rules.Options> = {
  spec = Rules.spec;
  bots = null;
  scoring = ?{ board = leaderboard; rating = #elo { k = 32 } };
};
include LeaderboardActorMixin(leaderboard, 25); // get_leaderboard(), top 25

```

- `#elo { k }` re-rates both seats on every ending (`Elo.update`);
  `#claimed`/`#aborted` count as wins for the other seat.
- `#best pick` — `pick : Debrief<S> -> [(Seat, Int)]` returns a score
  for each seat it credits (zero, one or two), each kept with
  `recordIfBetter` (a strict improvement only). A lower-is-better
  metric is converted first. `examples/racing` credits the winner's
  lap (the loser never finished one); Flag Duel credits both players'
  correct answers:

```motoko
let leaderboard = Leaderboard.new(50, 0); // defaultScore is inert here
func scoreFromLapMs(ms : Int) : Int = Int.max(0, 3_600_000 - ms);

func bestLap(d : TP.Debrief<Rules.State>) : [(TP.Seat, Int)] {
  switch (d.end) {
    case (#finished(#p1Wins)) [(#p1, scoreFromLapMs(lapMsFor(d.finalGame.p1, d.steps)))];
    case (#finished(#p2Wins)) [(#p2, scoreFromLapMs(lapMsFor(d.finalGame.p2, d.steps)))];
    case (_) []; // nobody finished a lap
  };
};
// scoring = ?{ board = leaderboard; rating = #best bestLap }

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
`mops.toml`, `duel.registry.attachMetrics(pt)` right after
`Transport.new`, and a `/metrics` route). The engine itself does not
require them: a registry without `attachMetrics` records nothing. Four
metrics, scoped to that registry:

- `games_started` (counter) — each `#staging -> #active` transition.
- `active_games` (gauge) — recomputed after any call that can change it.
- `rounds_per_game` (gauge) — the just-finished game's `Debrief.steps`;
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

  let duel = Transport.new<Rules.State, Rules.Action, Rules.Options>();
  duel.registry.setTimeouts(90_000_000_000, 60_000_000_000);
  duel.registry.attachMetrics(pt);
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
canister's Candid, and the only place the game's types are explained:
the Candid gives them (`View` and `Options` in the queries, `Action` in
`duel_submit`), not what they mean. Write it for a reader who cannot
see the source, in these sections:

- `GAME`, `MODE` (`simultaneous`, or `turnBased` with a word on what a
  turn is when it takes several actions), `SEATS` (which seat is which
  side, who moves first), `OPTIONS` (the `Options` Candid type and what
  each value changes, or `none`).
- `VIEW (Candid)` and `ACTION (Candid)` — the exact Candid types
  (`Nat` is `nat`, `?T` is `opt T`, `[T]` is `vec T`, a tuple is a
  positional record), followed by what every field means: indexing,
  units, what `null` stands for — and, for a game with hidden
  information, what a seat does not see and when it is revealed.
- `RULES` — what each action does, and every condition that rejects
  it.
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

**Turn-based games.** The rules decide whose action the game is
waiting for: `toMove(s)` reads it off the state, so a turn may take
several actions (draw, then place), an action may grant another turn,
and the order is the game's own. The engine rejects an action from any
other seat with `Err.#notYourTurn`, applies one with `move` (which
checks and applies in a single call), and asks `toMove` again. Only a
seat NOT on turn may `claimWin`; the seat on turn gets `#wrongPhase`.

**Rule contract for `Spec<S, M, V, O>`:**

- Pure: no actor, no storage, no `Time`; new records, never mutation.
  Randomness only from the `rng` handed in.
- The rules are the only legality gate — `move` in `#turnBased`,
  `validate` for each seat's submission in `#simultaneous`.
- `move`/`resolve` return the next state and, if the game ended,
  `?Verdict` (`#p1Wins`/`#p2Wins`/`#draw`); `null` means continue.
- `view(s, seat, over)` is the only way a state leaves the canister;
  `checkOptions` is the only gate on a table's options.

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
3. **Server-side legality.** The rules check every action, always.
4. **No silent endings.** `#aborted`, `#claimed`, and `#endedByOther`
   (until acked, or pruned by `Table.pruneEnded` after a generous
   multiple of the idle timeout).
5. **Leave means left.** A player who acked their debrief is no longer a
   participant, even while the phase lingers for the partner.
6. **Replay-safe.** `gen`/`step` mismatches come back `#stale`.
7. **Cheap reads, nothing per reader.** A query with an unchanged `rev`
   costs one comparison; no record exists per client.
8. **Hidden information stays hidden.** Every view, for a client or a
   bot, goes through the game's `view`; the full state never leaves.

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
