// Proves the ultimate tic-tac-toe bot: `chooseMove` stays within
// `legalActions` (including a board routed to its last empty cell), and two
// canister-seated bots play real plies through `canister_players`.
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

// ── 1. chooseMove never strays outside legalActions ────────────────────────
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
      complexity = "";
      retryReason = null;
      opponent = "p2";
      opponentLastMove = null;
      lastRoundDurationNs = null;
    };
    let move = BotLogic.chooseMove(req);
    let legal = Rules.legalActions(s0, #p1);
    assert legal.find<Rules.Action>(func(a) = a == move) != null;
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
      complexity = "";
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

// ── 2. wired live through canister_players.mo, two canister seats play each
//      other through several real #alternating plies ────────────────────────
let TIMEOUT : Int = 60_000_000_000;
let CLAIM_TIMEOUT : Int = 15_000_000_000;
let T0 : Int = 1_000_000_000_000;

// The player's first table and their view of it, or `#browsing`.
func statusOf(reg : TP.Registry<Rules.State, Rules.Action>, at : Int, p : TP.PlayerId) : {
  #atTable : { id : TP.TableId; view : TP.View<Rules.State> };
  #browsing;
} {
  let ids = reg.tablesOf(p);
  if (ids.size() == 0) return #browsing;
  switch (reg.view(spec, at, p, ids[0])) {
    case (?v) #atTable { id = ids[0]; view = v };
    case null #browsing;
  };
};

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

let bot1 = Principal.fromText("aaaaa-aa");
let bot2 = Principal.fromText("2vxsx-fae");

let reg = Registry.new<Rules.State, Rules.Action>();

reg.setTimeouts(TIMEOUT, CLAIM_TIMEOUT);
// The bots without the transport: every mutation settles the table
// right away, and no timers (the interpreter has none).
func settleAfter<system>(now : Int, id : TP.TableId, _ : Bool) : async* () {
  await* CanisterPlayers.settle<system, Rules.State, Rules.Action>(ctx, now, id);
};
let ctx : CanisterPlayers.Ctx<Rules.State, Rules.Action> = {
  registry = reg;
  spec;
  store = CanisterPlayers.newStore();
  call = func<system>(_session : TP.PlayerId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    await* k<system>(?BotLogic.chooseMove(req));
  };
  afterMutation = func<system>(now : Int, id : TP.TableId, b : Bool) : async* () {
    await* settleAfter<system>(now, id, b);
  };
  arm = func<system>(_ : TP.TableId, _ : Nat) {};
};
let cp = CanisterPlayers.endpointOf(ctx);

let id = ok(await* cp.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
let sidBot1 = CanisterPlayers.idForCanister(bot1, "");
let sidBot2 = CanisterPlayers.idForCanister(bot2, "");
// bot2's own joinTable eagerly triggers the opening plies with no sweep
// at all — proving #p1 moves first when canister-seated at game start.
ignore ok(await* cp.joinTable<system>(bot2, id, #p2, null, ""), "bot2 joins; game starts");
switch (statusOf(reg, T0, sidBot1)) {
  case (#atTable { view = #inGame v }) assert v.turn > 0; // #p1's own opening move already resolved
  case (other) Runtime.trap("bot1 should be in-game, at least one ply in, got " # debug_show (other));
};

// A large-enough sweep budget for a board that can run up to 81 plies in the
// worst case
var round = 0;
var lastTurn = switch (statusOf(reg, T0, sidBot1)) {
  case (#atTable { view = #inGame v }) v.turn;
  case (_) 0;
};
var stalled = false;
while (round < 45) {
  await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx, T0);
  switch (statusOf(reg, T0, sidBot1)) {
    case (#atTable { view = #inGame v }) {
      if (v.turn == lastTurn) stalled := true;
      lastTurn := v.turn;
    };
    case (_) {}; // the game already ended — see the check right below
  };
  round += 1;
};
assert not stalled;
switch (statusOf(reg, T0, sidBot1), statusOf(reg, T0, sidBot2)) {
  case (#atTable { view = #inGame v1 }, #atTable { view = #inGame v2 }) {
    assert v1.turn == v2.turn;
    assert v1.turn > 0;
  };
  case (_, _) {
    // Either a real #debrief, or (an all-canister debrief acks both sides
    // immediately
    switch (statusOf(reg, T0, sidBot1)) {
      case (#atTable { view = #debrief _ }) {};
      case (#browsing _) {};
      case (other) Runtime.trap("expected in-game, a real debrief, or an already-settled browsing state, got " # debug_show (other));
    };
  };
};
Debug.print("2. two canister-seated bots resolve several real #alternating plies against each other, no stall OK");

Debug.print("ALL ULTIMATE TIC-TAC-TOE BOT CHECKS PASSED");
