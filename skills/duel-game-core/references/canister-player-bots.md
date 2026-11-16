# Writing a canister-player bot: simple vs. stateful

Read this when building the bot canister itself (`Bot.mo`/`BotLogic.mo`).
It covers the simple shape every shipped reference bot uses (including
stateless randomness from `Time.now()`), and a bot that remembers a
match's history or models an opponent across games. Use the stateful
shape only when the strategy needs memory. Making a bot challengeable
(self-registration) is in `SKILL.md`, Step 4, after "Canister players".
A bot for a game whose source you don't have is set up by
`bot-for-existing-game.md`; read `Rules.View`/`Rules.Action` below as
its `Game.View`/`Game.Action`.

## What `make_move` receives

`TP.MoveRequest<V, M>`, grouped by purpose:

- `game`, `seat`, `mode`, `step`: what a human's screen shows. `game`
  is the game's `View` for your seat, exactly what a human there sees,
  never the hidden parts of the state. `step` counts applied actions
  (`#turnBased`) or resolved rounds (`#simultaneous`); in a turn of
  several actions you are asked once per action, each time with the
  view as it then is.
- `complexity`: which of your declared ways of playing this seat uses,
  fixed for the game (`"Default"` if you declared none). Switch on it,
  treating unknown values as your default; never trap.
- `tableId` and `gen`: the table, and this match on it. `gen` bumps on
  every fresh stage, a rematch on the same table included. You never
  submit either; they are memory keys.
- `retryReason`: `null` on a fresh ask; on a retry, the exact text your
  `validate` rejected the previous reply with.
- `opponent`: the opposing seat's player id, a human's principal (as
  text) or another bot's `cp:<principal>:<complexity>`. It is stable
  across every table; use
  `CanisterPlayers.principalOfCanisterSession(req.opponent)` to model a
  bot opponent across all its complexities.
- `opponentLastMove`: the opponent's most recently RESOLVED move, never
  the pending one. `null` when `step == 0`.
- `lastStepDurationNs`: how long the last step took, both seats'
  combined time in `#simultaneous`, the one mover's time in
  `#turnBased`. `null` when `step == 0`.

## The protocol in one sentence

The game canister calls your `make_move` once per action you are due,
and your reply IS the move; an illegal reply is asked once more with
`retryReason` set, then the engine falls silent and its timeouts apply.

## Where the bot canister lives

On the game backend's subnet. The backend asks the bot once per action
it is due, and every ask is an inter-canister call: quick within a
subnet, seconds across subnets. Look the subnet up before creating the
bot's canister, then create it there (`bot-for-existing-game.md`, step
6, has the commands).

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
the same sequence every match and is easy to exploit. `Time.now()`'s
nanoseconds are unpredictable enough and keep `make_move` a `query`.
`Bot.mo` passes it in as a parameter (`BotLogic` stays `Time`-free and
testable), and `BotLogic` hashes it together with `req.seat` so two
copies of the bot asked in the same round don't mirror each other
(`examples/rock-paper-scissors/bot/BotLogic.mo`):

```motoko
public query func make_move(req : TP.MoveRequest<Rules.View, Rules.Action>) : async Rules.Action {
  BotLogic.chooseMove(req, Time.now());
};

```

A seeded PRNG is the alternative only if its state is stored in the
actor (stateful shape below), so the sequence continues instead of
restarting each call.

**Stateful: remembers across calls, `update`.** The IC never commits a
query's state changes, so a bot that remembers anything must declare
an ordinary `public func`:

```motoko
public func make_move(req : TP.MoveRequest<Rules.View, Rules.Action>) : async Rules.Action {
  BotLogic.chooseMove(req, opponentModels);
};

```

`BotIface.CanisterPlayer` never declared `query`, so nothing on the host
changes. The cost is consensus latency (typically a couple of seconds),
so a host wiring a stateful bot should size `claimTimeoutNs`/
`idleTimeoutNs` more generously. An actor is persistent by default in
moc 2, so a plain `let opponentModels : Map.Map<...> = Map.empty()` is
stable.

## Keying your own memory

- **Per match**: `(req.tableId, req.gen)`; `req.step == 0` is a cruder
  signal for "fresh match".
- **Per decision**: `(req.tableId, req.gen, req.seat, req.step)`, the
  key a retry repeats (next section). The seat belongs in it: one bot
  canister can hold both seats of a table under two complexities.
- **Per opponent**: `req.opponent` (for a bot, one id per complexity;
  its principal to pool them).

## The retry pitfall: upsert, never append

A retried action calls `make_move` a second time with the same
`tableId`/`gen`/`seat`/`step` and `retryReason` set. Appending your own
move logs it twice. There is no "accepted" callback either (even a
legal reply may not land if the table moved on). Treat that key as one
decision point and overwrite by it.

`opponentLastMove` repeats without a retry too: a re-ask at the same
step, and every further action of the bot's own turn in `#turnBased`
(a turn of several actions, a repeat turn), carry the opponent move
the bot has already seen. Learn from it only when the opponent has
acted since the last ask: keep the step of that ask per
`(tableId, gen, seat)`. In `#simultaneous` every new step holds an
opponent move; in `#turnBased` the step after the last ask was the
bot's own action, so only a later one does.

## A worked sketch

```motoko
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

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

  let opponentModels : Map.Map<Text, OpponentModel> = Map.empty();
  let myMoves : Map.Map<Text, Rules.Action> = Map.empty();

  let lastAsked : Map.Map<Text, Nat> = Map.empty(); // step of the last ask, per seatKey

  func seatKey(req : TP.MoveRequest<Rules.View, Rules.Action>) : Text {
    req.tableId.toText() # "/" # req.gen.toText() # "/" # debug_show (req.seat);
  };

  func decisionKey(req : TP.MoveRequest<Rules.View, Rules.Action>) : Text {
    seatKey(req) # "/" # req.step.toText();
  };

  // True when the opponent acted since this seat's last ask; records this ask.
  func opponentMovedSince(req : TP.MoveRequest<Rules.View, Rules.Action>) : Bool {
    let moved = switch (lastAsked.get(seatKey(req))) {
      case null true;
      case (?prev) {
        switch (req.mode) {
          case (#simultaneous) req.step > prev;
          case (#turnBased) req.step > prev + 1;
        };
      };
    };
    lastAsked.add(seatKey(req), req.step);
    moved;
  };

  func opponentKey(req : TP.MoveRequest<Rules.View, Rules.Action>) : Text {
    if (CanisterPlayers.isCanisterSession(req.opponent)) {
      CanisterPlayers.principalOfCanisterSession(req.opponent).toText();
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
          case (_) {};
        };
      };
    };
  };

  public func make_move(req : TP.MoveRequest<Rules.View, Rules.Action>) : async Rules.Action {
    if (opponentMovedSince(req)) learnFrom(req); // a retry or a re-ask saw this move already
    let m = modelFor(opponentKey(req));
    let chosen : Rules.Action = if (m.rockCount > m.paperCount) #paper else #rock; // your strategy over `m`
    myMoves.add(decisionKey(req), chosen); // a retry overwrites, never appends
    chosen;
  };

};

```

## Testing a bot that searches

`test/Bot.test.mo` runs in the interpreter (`moc -r`, what `mops test`
uses by default), which is far slower than a canister: a minimax that
answers well within a call on-chain can take minutes per move there.
Give `chooseMove` its search depth as a parameter (each complexity
maps to a depth in `BotLogic`) and test legality and tactics at a
shallow depth: a win in one taken, a loss in one blocked, every reply
legal. If the full depth needs a test of its own, run that file as
wasm: `// @testmode wasi` as its first line, and `wasmtime` pinned
under `[toolchain]` in `mops.toml` (`wasmtime = "36.0.0"` installs on
Linux) so `mops test` can run it.

## What NOT to do

- Don't look for the opponent's current pending move: there is no
  field for it, by design.
- Don't force-unwrap `opponentLastMove`/`lastStepDurationNs`; both are
  `null` on step 0, and a trap counts as silence.
- Don't key per-match state by `step` alone; pair it with `gen`.
- Don't expect the full state: `game` is the `View`. A hidden-information
  game's bot plays from what it may see, like everyone else.
- Don't default to the stateful shape.
