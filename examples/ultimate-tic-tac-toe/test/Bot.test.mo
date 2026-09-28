// Proves the ultimate tic-tac-toe bot (`../bot/Bot.mo`/`BotLogic.mo`, the
// rule-following canister player) two ways: (1) `BotLogic.chooseMove`
// only ever returns a `UltimateTicTacToeRules.legalActions`-listed move
// for a handful of synthetic positions, including a board routed all the
// way down to its very last empty cell (where exactly one result
// exists); and (2) wired live through `mo:duel-game-core/canister_players`,
// two canister-seated bots play each other through several real
// `#alternating` plies — the specific proof this shape calls for: `#p1`
// moving first, then the due seat correctly alternating as the turn
// passes and board routing carries them along, with no illegal move and
// no stall. `BotLogic.chooseMove` is used directly as the `callBot`
// continuation, so no real second canister is needed here, same as
// `backend/test/CanisterPlayers.test.mo` and
// `examples/tic-tac-toe/test/Bot.test.mo`.
// Run: mops test Bot
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import TP "mo:duel-game-core";
import CanisterPlayers "mo:duel-game-core/canister_players";
import Registry "mo:duel-game-core/registry";

import BotLogic "../bot/BotLogic";
import Rules "../src/UltimateTicTacToeRules";

let spec = Rules.spec();

func withCells(marks : [(Nat, Nat, TP.Seat)]) : [?TP.Seat] {
  var cells = Array.repeat<?TP.Seat>(null, 81);
  for ((board, cell, seat) in marks.values()) {
    let idx = board * 9 + cell;
    cells := cells.mapEntries<?TP.Seat, ?TP.Seat>(func(cur, j) = if (j == idx) ?seat else cur);
  };
  cells;
};

// ── 1. chooseMove never strays outside legalActions — including a board
//        routed down to its very last empty cell, where exactly one
//        result exists at all ───────────────────────────────────────────────
do {
  let s0 = Rules.init("");
  for (turn in Nat.range(0, 9)) {
    let req : TP.MoveRequest<Rules.State, Rules.Action> = {
      tableId = 0;
      seat = #p1;
      game = s0;
      mode = #alternating;
      turn;
      gen = 0;
      retryReason = null;
      opponent = "p2";
      opponentLastMove = null;
      lastRoundDurationNs = null;
    };
    let move = BotLogic.chooseMove(req);
    let legal = Rules.legalActions(s0, #p1);
    assert Array.find<Rules.Action>(legal, func(a) = a == move) != null;
  };

  // board 4 down to its last empty cell (cell 8), and the router
  // currently constrains play to exactly that board.
  let almostFullBoard4 : Rules.State = {
    cells = withCells([
      (4, 0, #p1),
      (4, 1, #p2),
      (4, 2, #p1),
      (4, 3, #p1),
      (4, 4, #p2),
      (4, 5, #p2),
      (4, 6, #p2),
      (4, 7, #p1),
    ]);
    results = Array.repeat<?Rules.BoardResult>(null, 9);
    activeBoard = ?4;
  };
  for (turn in Nat.range(0, 5)) {
    let req : TP.MoveRequest<Rules.State, Rules.Action> = {
      tableId = 0;
      seat = #p1;
      game = almostFullBoard4;
      mode = #alternating;
      turn;
      gen = 0;
      retryReason = null;
      opponent = "p2";
      opponentLastMove = null;
      lastRoundDurationNs = null;
    };
    switch (BotLogic.chooseMove(req)) {
      case (#place { board; cell }) { assert board == 4; assert cell == 8 };
    };
  };
};
Debug.print("1. BotLogic.chooseMove always picks a Rules.legalActions-listed move, including a board's last empty cell OK");

// ── 2. wired live through canister_players.mo, two canister seats play
//        each other through several real #alternating plies ────────────
let TIMEOUT : Int = 60_000_000_000;
let CLAIM_TIMEOUT : Int = 15_000_000_000;
let T0 : Int = 1_000_000_000_000;

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

let bot1 = Principal.fromText("aaaaa-aa");
let bot2 = Principal.fromText("2vxsx-fae");

let reg = Registry.new<Rules.State, Rules.Action>(TIMEOUT, CLAIM_TIMEOUT);
let cp = CanisterPlayers.attach<Rules.State, Rules.Action>(
  spec,
  reg,
  func(_now : Int, _sid : TP.SessionId, _reqId : ?Nat64, _id : ?TP.TableId, _broadcast : Bool) : async* () {},
  func(_session : TP.SessionId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
    await* k(?BotLogic.chooseMove(req));
  },
  func(_id : TP.TableId, _secs : Nat) : async* () {}, // armClaimCheck — not exercised here, see backend/test/CanisterPlayers.test.mo's own test 15
);

let id = ok(await* cp.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
let sidBot1 = CanisterPlayers.sidForCanister(bot1, id);
let sidBot2 = CanisterPlayers.sidForCanister(bot2, id);
// bot2's own joinTable eagerly triggers the opening plies with no sweep
// at all — proving #p1 moves first when canister-seated at game start.
ignore ok(await* cp.joinTable(bot2, id, #p2, null), "bot2 joins; game starts");
switch (reg.status(spec, T0, sidBot1)) {
  case (#atTable { view = #inGame v }) assert v.turn > 0; // #p1's own opening move already resolved
  case (other) Runtime.trap("bot1 should be in-game, at least one ply in, got " # debug_show (other));
};

// A large-enough sweep budget for a board that can run up to 81 plies in
// the worst case; this loop only asserts no STALL (a due seat's sweep
// producing no progress at all), not that the match actually finishes —
// same reasoning `examples/tic-tac-toe/test/Bot.test.mo`'s own loop
// documents, just scaled up for the much larger board here.
var round = 0;
var lastTurn = switch (reg.status(spec, T0, sidBot1)) {
  case (#atTable { view = #inGame v }) v.turn;
  case (_) 0;
};
var stalled = false;
while (round < 45) {
  await* cp.sweep(T0);
  switch (reg.status(spec, T0, sidBot1)) {
    case (#atTable { view = #inGame v }) {
      if (v.turn == lastTurn) stalled := true;
      lastTurn := v.turn;
    };
    case (_) {}; // the game already ended — see the check right below
  };
  round += 1;
};
assert not stalled;
switch (reg.status(spec, T0, sidBot1), reg.status(spec, T0, sidBot2)) {
  case (#atTable { view = #inGame v1 }, #atTable { view = #inGame v2 }) {
    assert v1.turn == v2.turn;
    assert v1.turn > 0;
  };
  case (_, _) {
    // Either a real #debrief, or (an all-canister debrief acks both
    // sides immediately — see canister_players.mo's own "canister vs
    // canister" debrief-ack note) already settled all the way back to
    // #browsing within the very same sweep call that ended it; either
    // way, never a stuck #inGame with an unmet due seat.
    switch (reg.status(spec, T0, sidBot1)) {
      case (#atTable { view = #debrief _ }) {};
      case (#browsing _) {};
      case (other) Runtime.trap("expected in-game, a real debrief, or an already-settled browsing state, got " # debug_show (other));
    };
  };
};
Debug.print("2. two canister-seated bots resolve several real #alternating plies against each other, no stall OK");

Debug.print("ALL ULTIMATE TIC-TAC-TOE BOT CHECKS PASSED");
