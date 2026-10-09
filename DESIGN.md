# duel-game-core — design

How the framework is put together, from the top. The package READMEs
([backend](backend/README.md), [frontend](frontend/README.md)) document
the APIs; this page explains the shape behind them and why it is that
shape.

## What it is

A game on duel-game-core is two players at a table on the Internet
Computer. The framework does everything except the game itself:
tables and seating, rounds, timeouts, endings, rematches, canister
bots, a leaderboard, and the browser client with its screens. A game
supplies three pure functions — its rules — and a board to draw.

```mermaid
flowchart LR
  subgraph browser["Browser (one per player)"]
    plugin["GamePlugin<br/>(the game's board)"]
    client["client.ts / app.ts<br/>(screens, state)"]
    transport["DuelTransport<br/>(queries + updates)"]
    plugin --- client --- transport
  end

  subgraph canister["Game canister (one per game)"]
    direction TB
    methods["Candid methods<br/>duel_lobby · duel_table · duel_submit<br/>duel_create_table · duel_join_table · …"]
    duel["Duel class<br/>(transient: spec, callBot, rating)"]
    state[("Stable data<br/>State · Registry · Tables<br/>Bots store · Leaderboard")]
    rules["Rules module<br/>Spec: init · validate · resolve"]
    methods --> duel --> state
    duel --> rules
  end

  bot["Bot canister<br/>make_move(MoveRequest)"]

  transport -- "query: duel_lobby, duel_table" --> methods
  transport -- "update: duel_submit, duel_create_table, …" --> methods
  duel -- "await make_move" --> bot
  bot -- "join_table_as_canister, …" --> methods
```

| Piece            | Where                                                   | Role                                                                    |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Rules            | the game's `XRules.mo`                                  | `Spec<S, M>`: `init`, `validate`, `resolve`. Pure.                      |
| Table            | `backend/src/table.mo`                                  | One board: phases, rounds, timeouts, rematch, claim.                    |
| Registry         | `backend/src/registry.mo`                               | Many tables; who is at which.                                           |
| Transport        | `backend/src/transport.mo` + `transport_actor_mixin.mo` | The only client interface: revs, queries, mutations, keep-alive, sweep. |
| Canister players | `backend/src/canister_players.mo` + mixin               | Bots as players; the bot directory.                                     |
| Leaderboard      | `leaderboard.mo`, `elo.mo` + mixin                      | Optional scores (Elo or a game's best).                                 |
| HTTP             | `http_actor_mixin.mo`                                   | `/semantics`, `/wasm`, `/metrics`.                                      |
| Client           | `frontend/src/*`                                        | Transport, headless client, default screens, identity.                  |

## Core concepts

**Player.** A player is the principal that signs the call. Nothing else
identifies anyone: no method takes a session id, and the anonymous
principal is refused (`#unauthorized`). A browser player is a key the
tab generates (or an Internet Identity login); a bot is
`cp:<principal>:<complexity>`, so one bot canister may play in several
styles, even against itself. Inside the engine a player is a `PlayerId`
(`Text`), compared only for equality.

**Table.** A table has an id (never reused) and a phase:

```mermaid
stateDiagram-v2
  [*] --> staging: createTable
  staging --> active: second seat joins
  staging --> empty: creator leaves / swept
  active --> debrief: a verdict, a claim, or a leave (abort)
  active --> empty: idle takeover (reset) / swept
  debrief --> staging: rematch (seat reserved for the partner)
  debrief --> empty: both acked / expired
  empty --> staging: someone joins the freed board
  empty --> [*]: garbage-collected (no notice owed)
```

Each phase carries a timestamp, so nothing waits forever: an idle game
can be taken over, a debrief expires, and a waiting table whose creator
went silent is swept. A player evicted that way gets an `#endedByOther`
notice until they acknowledge it.

**View.** What one player sees of one table: `#stagingYou`,
`#awaitingRematch`, `#inGame`, `#debrief`, `#endedByOther` for a player
with business there, `#lobby`/`#busy` for an outsider. Views never
contain the opponent's pending move, only whether one exists.

**Rev.** Every table has a counter, `rev`, bumped on every change, and
so does the lobby. A client that sends the `rev` it holds gets
`#unchanged` until something changed — the whole cost of polling an
idle table is one counter comparison.

**Several tables.** A player may sit at up to
`MAX_TABLES_PER_PLAYER` (3) tables at once; every table request names
its table. Which tables are a player's is read off the tables
themselves (`Registry.tablesOf`), never kept separately.

## Data and behaviour

Everything the game canister knows is stable data in plain records,
declared as ordinary actor fields. Behaviour lives in modules and in one
transient class that binds the data to the function values Motoko
cannot store — the same split as promtracker's `Tracker` (data) and
`Renderer` (closures).

```mermaid
flowchart TB
  subgraph stable["Stable actor fields — survive upgrades"]
    st["state = Transport.new()<br/>registry (tables, timeouts, id nonce)<br/>lobbyRev · presence"]
    bots["bots = CanisterPlayers.newStore()<br/>directory · in-flight asks"]
    lb["leaderboard = Leaderboard.new(keep, default)"]
  end
  subgraph transient["transient let — rebuilt on every upgrade"]
    duelc["duel = Transport.Duel(state, spec,<br/>?{ store = bots; call = callBot },<br/>?{ board = leaderboard; rating })"]
  end
  st --> duelc
  bots --> duelc
  lb --> duelc
  duelc --> lobby["duel.lobby → TransportActorMixin"]
  duelc --> cp["duel.canisterPlayers → CanisterPlayersActorMixin"]
  duelc --> own["duel.submit / duel.table → the host's own two methods"]
```

The only function values are those that have to be code:

- **`spec`** — the game's rules. The engine is generic over `S`/`M` and
  Motoko has no interfaces, so rules arrive as functions.
- **`callBot`** — the inter-canister call to a bot's `make_move`. A call
  returning a generic `M` does not type-check inside the library, so the
  host, where `M` is concrete, makes it.
- **`rating`** — `#elo { k }`, or a game's own `#best` function that
  scores a finished game (racing turns a lap time into a score).

**Why the host still declares two methods.** A mixin cannot take type
parameters, and the Candid types of `duel_submit` (it takes an `Action`)
and `duel_table` (it returns a `State`) depend on the game. Everything
else is non-generic and comes from mixins. The host's part is two
one-line pass-throughs:

```motoko
public shared ({ caller }) func duel_submit(tableId : TP.TableId, gen : Nat, turn : Nat, move : Rules.Action) : async Transport.Reply<Rules.State> {
  duel.reply(caller, tableId, await* duel.submit<system>(caller, tableId, gen, turn, move));
};

public shared query ({ caller }) func duel_table(tableId : TP.TableId, rev : Nat) : async Transport.TableResult<Rules.State> {
  duel.table(caller, tableId, rev);
};

```

`submit` and `reply` are two steps because an `async*` result must be a
shared type, which the generic `Reply<S>` is not: `submit` does the
work and returns only `?Err`; `reply` builds the view synchronously.

**Upgrades.** Tables, ratings and bot registrations survive an upgrade
untouched. The `Duel` is rebuilt from the same data, polling clients
notice nothing, and timeouts are re-applied from the source on the line
after the declaration (`state.registry.setTimeouts(...)`).

## Reading: queries and revs

All reading is by query; a query changes nothing and records nothing
about who asked. The client follows one source at a time: the lobby, or
one of its tables.

```mermaid
sequenceDiagram
  autonumber
  participant P as Player's tab<br/>(DuelTransport)
  participant C as Game canister

  Note over P: start, reload or relink:<br/>a resync by query
  P->>C: duel_lobby(rev = 0)
  C-->>P: changed { rev = 41, tables, yours = [7] }
  Note over P: yours is not empty:<br/>follow table 7
  P->>C: duel_table(7, rev = 0)
  C-->>P: changed { rev = 12, view = #inGame }
  Note over P: render the game

  loop every intervalMs (500 ms, Flag Duel 200 ms)
    P->>C: duel_table(7, rev = 12)
    C-->>P: unchanged
  end
  Note over C: the opponent moves:<br/>table 7 → rev 13
  P->>C: duel_table(7, rev = 12)
  C-->>P: changed { rev = 13, view }
```

The transport falls back to the lobby when its table answers `#gone`
or shows the player an outsider's view (`#lobby`/`#busy`), and moves to
a table when the lobby lists one in `yours` — so another player's
action that ends your game, or a sweep, is followed without any special
message.

Why there is no per-reader state on the canister: a query cannot write
anything, so any "link" or "session" record would need an extra update
call just to exist and to stay alive. Versioning the shared data (each
table, the lobby) instead makes every read a pure query from the first
request on. Queries go to one replica and may briefly lag the latest
update; revs make that harmless, because a client never applies a view
older than one it has.

## Writing: one request at a time

Two update calls in flight have no guaranteed order on the IC, so the
client sends one request, waits for its reply, then sends the next.
That is what makes "move, then claim" or "leave, then create" mean what
the player meant; the canister itself never queues anything.

There are two kinds of reply:

- **`duel_submit`** replies with the table's fresh view — the move, and
  in `#alternating` against a bot, the bot's answer too.
- **Every other mutation** (`duel_create_table`, `duel_join_table`,
  `duel_rematch`, `duel_leave`, `duel_reset`, `duel_claim_win`,
  `duel_ack_ended`) replies with an `Ack`: the table and its `rev` after
  the call. The client then polls that table until its view has reached
  that `rev`. These calls are not on the hot path (starting a game can
  afford one poll), and keeping them free of `State` is what lets a
  non-generic mixin supply them.

An alternating game between two browsers:

```mermaid
sequenceDiagram
  autonumber
  participant A as Alice (tab)
  participant C as Game canister
  participant B as Bob (tab)

  A->>C: duel_create_table(#p1, #open, "")
  C-->>A: Ack { tableId = 7, rev = 1 }
  A->>C: duel_table(7, 0)
  C-->>A: changed { rev = 1, #stagingYou }
  B->>C: duel_lobby(0)
  C-->>B: changed { tables = [7: p2 open], yours = [] }
  B->>C: duel_join_table(7, #p2, null)
  C-->>B: Ack { tableId = 7, rev = 2 }
  B->>C: duel_table(7, 0)
  C-->>B: changed { rev = 2, #inGame }
  A->>C: duel_table(7, 1)
  C-->>A: changed { rev = 2, #inGame, your turn }
  A->>C: duel_submit(7, gen, turn 0, move)
  C-->>A: view { rev = 3, #inGame, waiting }
  B->>C: duel_table(7, 2)
  C-->>B: changed { rev = 3, #inGame, your turn }
```

A `#simultaneous` round: each seat submits; the second submission
resolves the round and comes back with the resolved state; the first
submitter sees it on its next poll.

```mermaid
sequenceDiagram
  participant A as Alice
  participant C as Game canister
  participant B as Bob
  A->>C: duel_submit(7, gen, turn 4, a)
  C-->>A: view { #inGame, youSubmitted, oppSubmitted = false }
  B->>C: duel_submit(7, gen, turn 4, b)
  Note over C: both moves in:<br/>resolve(state, a, b)
  C-->>B: view { #inGame, turn 5, new state }
  A->>C: duel_table(7, rev)
  C-->>A: changed { #inGame, turn 5, new state }
```

**Replay safety.** A call that throws may or may not have landed, so
the client resends it (twice, to the same table). `submit`, `leave`,
`reset` and `claimWin` carry the `gen` (match generation) and `submit`
the `turn` the client last saw; a replay against a later round or a new
match is `#stale`, and on a resend the client settles with a resync
instead of showing an error.

## Waiting tables: keep-alive and sweep

A table whose creator is waiting for an opponent would otherwise sit in
the lobby forever after the tab closes. While the shown view is
`#stagingYou`, the client sends `duel_keep_alive()` every 20 s
(`KEEP_ALIVE_SECS`). It records the caller's presence and nothing else.
Every 30 s (`SWEEP_SECS`) the sweep clears a waiting table that is past
the idle timeout and whose creator has not been heard from for 60 s
(`PRESENCE_TTL_NS`), along with expired games and debriefs.

```mermaid
sequenceDiagram
  participant P as Creator's tab
  participant C as Game canister
  participant T as Sweep timer (30 s)

  P->>C: duel_create_table
  loop while the view is #stagingYou
    P->>C: duel_keep_alive()
    Note over C: presence[P] := now
  end
  T->>C: sweep: P present → table stays
  Note over P: tab closed
  T->>C: sweep: past idle timeout and<br/>P silent > 60 s → table cleared
  Note over C: table and lobby revs bumped,<br/>browsing tabs see it vanish
```

Silence never ends a game in progress: departure there is the engine's
own business — `claimWin` once the opponent has been silent past
`claimTimeoutNs`, or idle takeover after `idleTimeoutNs`. A player who
closes the tab and comes back with the same key continues where they
were.

## Canister players

A bot is a canister that implements `make_move(MoveRequest<S, M>) :
async M`. The game canister calls it and treats the reply as the move —
an `await` is an ordered request/response channel, so the bot never
makes a second, unordered call into the game. After every mutation the
transport settles the table: it asks a due bot, claims an overdue win
for a waiting one, and acknowledges a finished debrief for a bot whose
partner is gone or is itself a bot.

```mermaid
sequenceDiagram
  autonumber
  participant H as Human (tab)
  participant C as Game canister
  participant K as Bot canister

  H->>C: duel_create_table(#p1, …)
  C-->>H: Ack { tableId = 7 }
  H->>K: play(host, 7, #p2, null, "Hard")
  K->>C: join_table_as_canister(7, #p2, null, "Hard")
  Note over C: game starts — settle(7):<br/>is a bot seat due? not yet (p1 moves first)
  C-->>K: #ok(#started)
  H->>C: duel_submit(7, gen, 0, move)
  Note over C: settle(7): the bot's seat is due
  C->>K: make_move(MoveRequest { game, seat, turn, complexity, … })
  K-->>C: move
  Note over C: validate + resolve, then settle again
  C-->>H: view { the human's move and the bot's answer }
```

An illegal reply is retried once, with `retryReason` set to
`validate`'s text; a trap or rejection is treated as silence and left
to the timeouts. Two bots at one table never play a whole match inside
one call: a bot seat that becomes due inside the other bot's reply is
asked from a fresh message, through a zero-second timer.

```mermaid
sequenceDiagram
  participant C as Game canister
  participant K1 as Bot 1
  participant K2 as Bot 2
  C->>K1: make_move (turn 0)
  K1-->>C: move → bot 2 is due,<br/>but we are inside bot 1's reply
  Note over C: arm a 0 s timer
  C->>K2: (timer) make_move (turn 1)
  K2-->>C: move → arm a 0 s timer
  C->>K1: (timer) make_move (turn 2)
```

Bots register themselves in the game's directory (`register_bot`), and
frontends list them (`list_bots`) with their ratings, so a human can
challenge one without knowing its id.

## Leaderboard

Optional. A finished game is scored by the `Duel` itself when the
transport sees a fresh debrief: `#elo { k }` re-rates both seats
(claimed and aborted games count as wins), `#best pick` keeps a game's
own score for one seat when it improves that player's entry. Keys are
player ids, so a bot is rated per complexity. `get_leaderboard()` comes
from `LeaderboardActorMixin`.

## HTTP

`HttpActorMixin` serves plain-text routes: `/semantics` (the rules,
written for someone without the source — the contract a third-party
frontend or bot is built from), `/metrics` (promtracker), anything a
game adds, and `/wasm`, the exact module the canister runs, uploaded
by the deploy. Together with the Candid metadata, that is everything
needed to build and test a new frontend or bot from the canister id
alone.

## Guarantees

1. **Race-free rematch.** The rematch stages the same table with the
   other seat reserved for the partner; their `rematch`/`join` fills
   it, their `leave` declines it.
2. **No ghost tables.** Every phase is timestamped; idle tables are
   taken over or swept, and empty ones are garbage-collected.
3. **Server-side legality.** `validate` runs on every submission.
4. **No silent endings.** `#aborted`, `#claimed`, `#endedByOther`.
5. **Leave means left.** Once a player acknowledged a debrief, the
   table is no longer theirs.
6. **Replay-safe.** `gen`/`turn` mismatches are `#stale`.
7. **Ordered requests.** One update at a time per client.
8. **Cheap idle reads.** An unchanged table or lobby costs one counter
   comparison; nothing is stored per reader.
9. **Nothing lost on upgrade.** All data is stable; only closures are
   rebuilt.

## Where to go next

- Build a game from a rules description: [the skill](skills/duel-game-core/SKILL.md).
- Backend API: [backend/README.md](backend/README.md).
- Frontend API: [frontend/README.md](frontend/README.md).
- A frontend or bot for a deployed game:
  [frontend-for-existing-game.md](skills/duel-game-core/references/frontend-for-existing-game.md),
  [bot-for-existing-game.md](skills/duel-game-core/references/bot-for-existing-game.md).
- Repo conventions and rules for contributors: [CLAUDE.md](CLAUDE.md).
