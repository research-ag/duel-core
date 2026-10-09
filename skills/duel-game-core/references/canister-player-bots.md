# Writing a canister-player bot: simple vs. stateful

Read this when building the bot canister itself (`Bot.mo`/`BotLogic.mo`).
It covers the simple shape every shipped reference bot uses (including
stateless randomness from `Time.now()`), and a bot that remembers a
match's history or models an opponent across games. Don't reach for the
stateful shape unless the strategy actually needs memory. Making a bot
challengeable (self-registration) is covered in
`SKILL.md`'s "Canister players" step. A bot for a game whose source you
don't have is set up by `bot-for-existing-game.md`; read `Rules.View`/
`Rules.Action` below as its `Game.View`/`Game.Action`.

## What `make_move` receives

`TP.MoveRequest<V, M>`, grouped by purpose:

- `game`, `seat`, `mode`, `step` — what a human's screen shows. `game`
  is the game's `View` for your seat: exactly what a human there sees,
  never the hidden parts of the state. `step` counts applied actions
  (`#turnBased`) or resolved rounds (`#simultaneous`); in a turn of
  several actions you are asked once per action, each time with the
  view as it then is.
- `complexity` — which of your declared ways of playing this seat uses,
  fixed for the game (`"Default"` if you declared none). Switch on it,
  treating unknown values as your default; never trap.
- `gen` — this match's identity; bumps on every fresh stage, rematch on
  the same table included. You never submit it; it is only a memory key.
- `retryReason` — `null` on a fresh ask; on a retry, the exact text your
  `validate` rejected the previous reply with.
- `opponent` — the opposing seat's player id: a human's principal (as
  text), or another bot's `cp:<principal>:<complexity>`. Stable across
  every table; use `CanisterPlayers.principalOfCanisterSession(req.opponent)`
  to model a bot opponent across all its complexities.
- `opponentLastMove` — the opponent's most recently RESOLVED move, never
  the pending one. `null` when `step == 0`.
- `lastStepDurationNs` — how long the last step took: both seats'
  combined time in `#simultaneous`, the one mover's time in
  `#turnBased`. `null` when `step == 0`.

## The protocol in one sentence

The game canister calls your `make_move` once per action you are due, and
your reply IS the move; an illegal reply is asked once more with
`retryReason` set, then the engine falls silent and its timeouts apply.

## Two shapes

**Simple: a pure function, `query`.** A strategy over `game`/`seat`/
`step` alone (a script, a legal-move lookup, a minimax over the current
board):

```motoko
public query func make_move(req : TP.MoveRequest<Rules.View, Rules.Action>) : async Rules.Action {
  BotLogic.chooseMove(req);
};

```

Every example bot is this. A query is near-instant and skips consensus.
Keep the logic in `BotLogic.mo`, a plain module with no actor/`Time`/
storage, so `test/Bot.test.mo` can call `chooseMove` directly.

**Randomness without state.** A bot whose strategy is a random pick (a
game of hidden simultaneous choices, a tie-break between equal moves)
must not derive it from `step`/`seat` alone: a deterministic bot plays
the same sequence every match and is trivially exploited. `Time.now()`'s
nanoseconds are unpredictable enough in practice and keep `make_move` a
`query`. `Bot.mo` passes it in as a parameter (`BotLogic` stays
`Time`-free and testable), and `BotLogic` hashes it together with
`req.seat` so two copies of the bot asked in the same round don't mirror
each other (`examples/rock-paper-scissors/bot/BotLogic.mo`):

```motoko
public query func make_move(req : TP.MoveRequest<Rules.View, Rules.Action>) : async Rules.Action {
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
public func make_move(req : TP.MoveRequest<Rules.View, Rules.Action>) : async Rules.Action {
  BotLogic.chooseMove(req, opponentModels);
};

```

`BotIface.CanisterPlayer` never declared `query`, so nothing on the host
changes. The cost is consensus latency (typically a couple of seconds);
a host wiring a stateful bot should size `claimTimeoutNs`/`idleTimeoutNs`
more generously. In an actor (persistent by default in moc 2), a plain `var opponentModels :
Map.Map<...> = Map.empty()` is automatically stable.

## Keying your own memory

- **Per match** — `(req.tableId, req.gen)`; `req.step == 0` is a cruder
  equivalent signal for "fresh match".
- **Per opponent** — `req.opponent` (for a bot, one id per complexity;
  its principal to pool them).

## The retry pitfall: upsert, never append

A retried action calls `make_move` a second time with the same
`tableId`/`gen`/`step`. Blindly appending your own move logs it twice,
and there is no "accepted" callback (even a legal reply may not land if
the table moved on). Treat `(tableId, gen, step)` as one decision point
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

  func matchKey(req : TP.MoveRequest<Rules.View, Rules.Action>) : Text {
    Nat.toText(req.tableId) # "/" # Nat.toText(req.gen);
  };

  func opponentKey(req : TP.MoveRequest<Rules.View, Rules.Action>) : Text {
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

  func learnFrom(req : TP.MoveRequest<Rules.View, Rules.Action>) {
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

  public func make_move(req : TP.MoveRequest<Rules.View, Rules.Action>) : async Rules.Action {
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
- Don't force-unwrap `opponentLastMove`/`lastStepDurationNs`; both are
  `null` on step 0, and a trap counts as silence.
- Don't key per-match state by `step` alone; pair it with `gen`.
- Don't expect the full state: `game` is the `View`. A hidden-information
  game's bot plays from what it may see, like everyone else.
- Don't default to the stateful shape.
