# Writing a canister-player bot: simple vs. stateful

Read this when building the bot canister itself (`Bot.mo`/`BotLogic.mo`).
It covers the simple shape every shipped reference bot uses (including
stateless randomness from `Time.now()`), and a bot that remembers a
match's history or models an opponent across games. Don't reach for the
stateful shape unless the strategy actually needs memory. Making a bot
challengeable (self-registration) is covered in
`SKILL.md`'s "Canister players" step. A bot for a game whose source you
don't have is set up by `bot-for-existing-game.md`; read `Rules.State`/
`Rules.Action` below as its `Game.State`/`Game.Action`.

## What `make_move` receives

`TP.MoveRequest<S, M>`, grouped by purpose:

- `game`, `seat`, `mode`, `turn` — what a human's screen shows.
- `complexity` — which of your declared ways of playing this seat uses,
  fixed for the session (`"Default"` if you declared none). Switch on it,
  treating unknown values as your default; never trap.
- `gen` — this match's identity; bumps on every fresh stage, rematch on
  the same table included. You never submit it; it is only a memory key.
- `retryReason` — `null` on a fresh ask; on a retry, the exact text your
  `validate` rejected the previous reply with.
- `opponent` — the opposing seat's raw `SessionId`. Stable across every
  table for a human (`ii:`/`an:`); per-table for a canister (`cp:`), so
  use `CanisterPlayers.principalOfCanisterSession(req.opponent)` to model
  a bot opponent across boards.
- `opponentLastMove` — the opponent's most recently RESOLVED move, never
  the pending one. `null` when `turn == 0`.
- `lastRoundDurationNs` — how long the last round took: both seats'
  combined time in `#simultaneous`, the one mover's time in
  `#alternating`. `null` when `turn == 0`.

## The protocol in one sentence

The game canister calls your `make_move` once per round you are due, and
your reply IS the move; an illegal reply is asked once more with
`retryReason` set, then the engine falls silent and its timeouts apply.

## Two shapes

**Simple: a pure function, `query`.** A strategy over `game`/`seat`/
`turn` alone (a script, a legal-move lookup, a minimax over the current
board):

```motoko
public query func make_move(req : TP.MoveRequest<Rules.State, Rules.Action>) : async Rules.Action {
  BotLogic.chooseMove(req);
};

```

Every example bot is this. A query is near-instant and skips consensus.
Keep the logic in `BotLogic.mo`, a plain module with no actor/`Time`/
storage, so `test/Bot.test.mo` can call `chooseMove` directly.

**Randomness without state.** A bot whose strategy is a random pick (a
game of hidden simultaneous choices, a tie-break between equal moves)
must not derive it from `turn`/`seat` alone: a deterministic bot plays
the same sequence every match and is trivially exploited. `Time.now()`'s
nanoseconds are unpredictable enough in practice and keep `make_move` a
`query`. `Bot.mo` passes it in as a parameter (`BotLogic` stays
`Time`-free and testable), and `BotLogic` hashes it together with
`req.seat` so two copies of the bot asked in the same round don't mirror
each other (`examples/rock-paper-scissors/bot/BotLogic.mo`):

```motoko
public query func make_move(req : TP.MoveRequest<Rules.State, Rules.Action>) : async Rules.Action {
  BotLogic.chooseMove(req, Time.now());
};

```

A seeded PRNG is the alternative only if its state is stored in the
actor (stateful shape below) so the sequence continues instead of
restarting each call.

**Stateful: remembers across calls, `update`.** A query's state changes
are never committed — a hard IC constraint — so a bot that remembers
anything must declare an ordinary `public func`:

```motoko
public func make_move(req : TP.MoveRequest<Rules.State, Rules.Action>) : async Rules.Action {
  BotLogic.chooseMove(req, opponentModels);
};

```

`BotIface.CanisterPlayer` never declared `query`, so nothing on the host
changes. The cost is consensus latency (typically a couple of seconds);
a host wiring a stateful bot should size `claimTimeoutNs`/`idleTimeoutNs`
more generously. In an actor (persistent by default in moc 2), a plain `var opponentModels :
Map.Map<...> = Map.empty()` is automatically stable.

## Keying your own memory

- **Per match** — `(req.tableId, req.gen)`; `req.turn == 0` is a cruder
  equivalent signal for "fresh match".
- **Per opponent** — `req.opponent` for a human, its principal for a
  canister.

## The retry pitfall: upsert, never append

A retried round calls `make_move` a second time with the same
`tableId`/`gen`/`turn`. Blindly appending your own move logs it twice,
and there is no "accepted" callback (even a legal reply may not land if
the table moved on). Treat `(tableId, gen, turn)` as one decision point
and overwrite by that key.

## A worked sketch

```motoko
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";

import TP "mo:duel-game-core";
import CanisterPlayers "mo:duel-game-core/canister_players";

import Rules "../src/RockPaperScissorsRules";

actor {

  type OpponentModel = {
    var movesSeen : Nat;
    var rockCount : Nat;
    var paperCount : Nat;
    var scissorsCount : Nat;
  };

  var opponentModels : Map.Map<Text, OpponentModel> = Map.empty();
  var matchHistory : Map.Map<Text, [Rules.Action]> = Map.empty();

  func matchKey(req : TP.MoveRequest<Rules.State, Rules.Action>) : Text {
    Nat.toText(req.tableId) # "/" # Nat.toText(req.gen);
  };

  func opponentKey(req : TP.MoveRequest<Rules.State, Rules.Action>) : Text {
    if (CanisterPlayers.isCanisterSession(req.opponent)) {
      Principal.toText(CanisterPlayers.principalOfCanisterSession(req.opponent));
    } else {
      req.opponent;
    };
  };

  func modelFor(key : Text) : OpponentModel {
    switch (opponentModels.get(key)) {
      case (?m) m;
      case null {
        let fresh = {
          var movesSeen = 0;
          var rockCount = 0;
          var paperCount = 0;
          var scissorsCount = 0;
        };
        opponentModels.add(key, fresh);
        fresh;
      };
    };
  };

  func learnFrom(req : TP.MoveRequest<Rules.State, Rules.Action>) {
    switch (req.opponentLastMove) {
      case null {};
      case (?move) {
        let m = modelFor(opponentKey(req));
        m.movesSeen += 1;
        switch (move) {
          case (#rock) m.rockCount += 1;
          case (#paper) m.paperCount += 1;
          case (#scissors) m.scissorsCount += 1;
        };
      };
    };
  };

  public func make_move(req : TP.MoveRequest<Rules.State, Rules.Action>) : async Rules.Action {
    learnFrom(req);
    let m = modelFor(opponentKey(req));
    let chosen : Rules.Action = #rock; // your strategy over `m` goes here
    matchHistory.add(matchKey(req), [chosen]); // upsert, not append
    chosen;
  };

};

```

## What NOT to do

- Don't look for the opponent's current pending move — there is no
  field for it, by design.
- Don't force-unwrap `opponentLastMove`/`lastRoundDurationNs`; both are
  `null` on turn 0, and a trap counts as silence.
- Don't key per-match state by `turn` alone; pair it with `gen`.
- Don't default to the stateful shape.
