// Proves the chopsticks bot: every tier stays within `legalActions` in both
// variants, the Bunny/Fox/Bear ladder holds in play-outs, and two canister-
// seated bots play real plies through `canister_players`, each ask carrying
// its seat's complexity.
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import TP "mo:duel-game-core";
import CanisterPlayers "mo:duel-game-core/canister_players";
import Registry "mo:duel-game-core/registry";

import BotLogic "../bot/BotLogic";
import Rules "../src/ChopsticksRules";

let spec = Rules.spec();

func pos(variant : Rules.Variant, p1 : (Nat, Nat), p2 : (Nat, Nat)) : Rules.State = {
  variant;
  p1 = { l = p1.0; r = p1.1 };
  p2 = { l = p2.0; r = p2.1 };
};

func reqFor(s : Rules.State, seat : TP.Seat, turn : Nat, complexity : Text) : TP.MoveRequest<Rules.State, Rules.Action> = {
  tableId = 0;
  seat;
  game = s;
  mode = #alternating;
  turn;
  gen = 0;
  complexity;
  retryReason = null;
  opponent = "opp";
  opponentLastMove = null;
  lastRoundDurationNs = null;
};

func isLegal(s : Rules.State, seat : TP.Seat, a : Rules.Action) : Bool = Rules.legalActions(s, seat).find<Rules.Action>(func(x) = x == a) != null;

// ── 1. every tier only ever picks a legal move, in both variants ───────────
do {
  assert BotLogic.COMPLEXITIES == ["Bunny", "Fox", "Bear"];
  let positions : [Rules.State] = [
    Rules.init(""),
    Rules.init("instructables"),
    pos(#classic, (0, 4), (0, 2)),
    pos(#instructables, (0, 4), (0, 2)),
    pos(#classic, (4, 4), (1, 3)),
    pos(#instructables, (0, 3), (2, 2)),
    pos(#classic, (2, 0), (3, 1)),
  ];
  for (s in positions.values()) {
    for (complexity in ["Bunny", "Fox", "Bear", "", "Nightmare"].values()) {
      for (turn in Nat.range(0, 6)) {
        assert isLegal(s, #p1, BotLogic.chooseMove(reqFor(s, #p1, turn, complexity)));
      };
    };
  };
  // An undeclared complexity plays exactly like Bunny.
  let s = pos(#classic, (2, 0), (3, 1));
  for (turn in Nat.range(0, 6)) {
    assert BotLogic.chooseMove(reqFor(s, #p1, turn, "Nightmare")) == BotLogic.chooseMove(reqFor(s, #p1, turn, "Bunny"));
    assert BotLogic.chooseMove(reqFor(s, #p1, turn, "")) == BotLogic.chooseMove(reqFor(s, #p1, turn, "Bunny"));
  };
};
Debug.print("1. every tier always picks a Rules.legalActions-listed move; an undeclared complexity plays Bunny OK");

// ── 2. Fox and Bear take an immediate win ──────────────────────────────────
do {
  // p1 (2,0) vs p2 (3,0): tapping 2 onto the 3 puts p2's last hand out.
  let winNow = pos(#classic, (2, 0), (3, 0));
  let finisher : Rules.Action = #attack { from = #l; to = #l };
  for (turn in Nat.range(0, 6)) {
    assert BotLogic.chooseMove(reqFor(winNow, #p1, turn, "Fox")) == finisher;
    assert BotLogic.chooseMove(reqFor(winNow, #p1, turn, "Bear")) == finisher;
  };
  // p1 (2,0) vs p2 (3,1), classic. Legal for p1: attack l->l (3+2=5, out),
  // attack l->r (1+2=3, leaving p2 (3,3) to tap 3 onto p1's lone 2 and
  // win), split 1+1. Bunny's turn-1 pick is the losing attack l->r.
  let trap = pos(#classic, (2, 0), (3, 1));
  let losing : Rules.Action = #attack { from = #l; to = #r };
  assert BotLogic.chooseMove(reqFor(trap, #p1, 1, "Bunny")) == losing;
  for (turn in Nat.range(0, 6)) {
    assert BotLogic.chooseMove(reqFor(trap, #p1, turn, "Fox")) != losing;
    assert BotLogic.chooseMove(reqFor(trap, #p1, turn, "Bear")) != losing;
  };
};
Debug.print("2. Fox/Bear win at once when they can and never hand over an immediate win OK");

// ── 3. the ladder holds in full play-outs from the opening: Bear beats Bunny
//      and Fox from either seat in either variant ───────────────────────────
func playOut(variant : Text, p1Complexity : Text, p2Complexity : Text, maxPlies : Nat) : ?TP.Verdict {
  var s = Rules.init(variant);
  var seat : TP.Seat = #p1;
  var turn = 0;
  while (turn < maxPlies) {
    let complexity = switch (seat) {
      case (#p1) p1Complexity;
      case (#p2) p2Complexity;
    };
    let r = Rules.resolve(s, seat, BotLogic.chooseMove(reqFor(s, seat, turn, complexity)));
    switch (r.verdict) {
      case (?v) return ?v;
      case null {};
    };
    s := r.state;
    seat := Rules.other(seat);
    turn += 1;
  };
  null;
};
for (variant in ["", "instructables"].values()) {
  assert playOut(variant, "Bear", "Bunny", 60) == ?#p1Wins;
  assert playOut(variant, "Bunny", "Bear", 60) == ?#p2Wins;
  assert playOut(variant, "Bear", "Fox", 60) == ?#p1Wins;
  assert playOut(variant, "Fox", "Bear", 60) == ?#p2Wins;
};
assert playOut("", "Fox", "Bunny", 60) == ?#p1Wins;
assert playOut("", "Bunny", "Fox", 60) == ?#p2Wins;
Debug.print("3. Bear beats Fox and Bunny from either seat in both variants; Fox beats Bunny in classic OK");

// ── 4. wired live through canister_players.mo, two canister seats play each
//      other through several real #alternating plies ────────────────────────
let TIMEOUT : Int = 60_000_000_000;
let CLAIM_TIMEOUT : Int = 15_000_000_000;
let T0 : Int = 1_000_000_000_000;

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func atTableView(reg : TP.Registry<Rules.State, Rules.Action>, at : Int, session : Text) : TP.View<Rules.State> = switch (reg.status(spec, at, session)) {
  case (#atTable v) v.view;
  case (#browsing _) Runtime.trap("expected " # session # " to be at a table");
};

func noopAfterMutation(_now : Int, _sid : TP.SessionId, _id : ?TP.TableId, _broadcast : Bool) : async* () {};

let bot1 = Principal.fromText("aaaaa-aa");
let bot2 = Principal.fromText("2vxsx-fae");

let reg = Registry.new<Rules.State, Rules.Action>();

reg.setTimeouts(TIMEOUT, CLAIM_TIMEOUT);
let cp = CanisterPlayers.attach<Rules.State, Rules.Action>(
  spec,
  reg,
  noopAfterMutation,
  false,
  func(_session : TP.SessionId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
    switch (req.seat) {
      case (#p1) assert req.complexity == "Bear";
      case (#p2) assert req.complexity == CanisterPlayers.DEFAULT_COMPLEXITY;
    };
    assert req.game.variant == #instructables;
    await* k(?BotLogic.chooseMove(req));
  },
  func(_id : TP.TableId, _secs : Nat) : async* () {}, // armClaimCheck — not exercised here, see backend/test/CanisterPlayers.test.mo's own test 15
);

let id = ok(await* cp.createTable(bot1, #p1, #open, "instructables", "Bear"), "bot1 creates an instructables table, playing Bear");
let sidBot1 = CanisterPlayers.sidForCanister(bot1, id, "Bear");
let sidBot2 = CanisterPlayers.sidForCanister(bot2, id, "");
ignore ok(await* cp.joinTable(bot2, id, #p2, null, ""), "bot2 joins; game starts");
switch (atTableView(reg, T0, sidBot1)) {
  case (#inGame v) assert v.turn > 0; // #p1's own opening move already resolved
  case (_) Runtime.trap("bot1 should be in-game, at least one ply in");
};

var round = 0;
var lastTurn = switch (atTableView(reg, T0, sidBot1)) {
  case (#inGame v) v.turn;
  case (_) 0;
};
var stalled = false;
while (round < 12) {
  await* cp.sweep(T0);
  switch (reg.status(spec, T0, sidBot1)) {
    case (#atTable { view = #inGame v }) {
      if (v.turn == lastTurn) stalled := true;
      lastTurn := v.turn;
    };
    case (_) {};
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
    // Bear has very plausibly already won by now — a real #debrief, or
    // (an all-canister debrief acking both sides immediately) already
    // settled back to #browsing within the same sweep call that ended it.
    switch (reg.status(spec, T0, sidBot1)) {
      case (#atTable { view = #debrief _ }) {};
      case (#browsing _) {};
      case (other) Runtime.trap("expected in-game, a real debrief, or an already-settled browsing state, got " # debug_show (other));
    };
  };
};
Debug.print("4. two canister-seated bots (Bear vs Default) resolve several real #alternating plies against each other, no stall OK");

Debug.print("ALL CHOPSTICKS BOT CHECKS PASSED");
