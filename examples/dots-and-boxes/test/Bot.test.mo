// Checks for the Dots & Boxes bot: `chooseMove` only ever returns a legal
// turn, Easy and Hard behave as documented on hand-built positions, and
// Hard beats Easy over a few seeded 3x3 games.
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Runtime "mo:core/Runtime";

import TP "mo:duel-game-core";
import Rng "mo:duel-game-core/rng";

import BotLogic "../bot/BotLogic";
import Rules "../src/DotsAndBoxesRules";

let rng = Rng.new(42);

func request(s : Rules.State, seat : TP.Seat, step : Nat, complexity : Text) : TP.MoveRequest<Rules.View, Rules.Action> = {
  tableId = 0;
  seat;
  game = s;
  mode = #turnBased;
  step;
  gen = 0;
  complexity;
  retryReason = null;
  opponent = "p2";
  opponentLastMove = null;
  lastStepDurationNs = null;
};

func linesOf(a : Rules.Action) : [Nat] = switch (a) { case (#draw d) d.lines };

// The turn's first line.
func lineOf(a : Rules.Action) : Nat = linesOf(a)[0];

func isLegal(s : Rules.State, a : Rules.Action) : Bool = switch (Rules.move(s, Rules.toMove(s), a, rng)) {
  case (#ok _) true;
  case (#err _) false;
};

// Plays each of `lines` as a one-line turn of whoever is on turn; traps
// on a rejection or an unexpected end.
func play(start : Rules.State, lines : [Nat]) : Rules.State {
  var s = start;
  for (l in lines.values()) {
    switch (Rules.move(s, Rules.toMove(s), #draw { lines = [l] }, rng)) {
      case (#err why) Runtime.trap("rejected " # l.toText() # ": " # why);
      case (#ok { verdict = ?_ }) Runtime.trap("unexpected end");
      case (#ok { state; verdict = null }) s := state;
    };
  };
  s;
};

// ── 1. complexities, and both ways of playing stay legal ───────────────
assert BotLogic.COMPLEXITIES == ["Easy", "Hard"];
do {
  let s0 = Rules.init({ size = 3 }, rng);
  for (seed in [0, 1, 7, 42, 1_000_003].values()) {
    for (c in ["Easy", "Hard", "", "Whatever"].values()) {
      let a = BotLogic.chooseMove(request(s0, #p1, 0, c), seed);
      assert isLegal(s0, a);
    };
  };
};
Debug.print("1. complexities + legality OK");

// ── 2. both take a box that is offered ─────────────────────────────────
do {
  // 3x3: box 0 has sides 0, 3, 12, 13. Draw 0, 3, 12 (three non-closing
  // moves: p1 p2 p1), so p2 is on turn and 13 closes box 0.
  let s = play(Rules.init({ size = 3 }, rng), [0, 3, 12]);
  assert Rules.toMove(s) == #p2;
  for (seed in [0, 5, 99].values()) {
    for (c in ["Easy", "Hard"].values()) {
      let a = BotLogic.chooseMove(request(s, #p2, 3, c), seed);
      assert lineOf(a) == 13;
      assert linesOf(a).size() == 2; // the box draws again
      assert isLegal(s, a);
    };
  };
  assert BotLogic.closes(s, 13) == 1;
  assert BotLogic.closes(s, 1) == 0;
};
Debug.print("2. takes an offered box OK");

// ── 3. Hard never gives a third side while a safe line exists ──────────
do {
  // 3x3 after 0 and 3 (box 0 has two sides): drawing 12 or 13 would hand
  // box 0 to the opponent. Hard must avoid both for many seeds.
  let s = play(Rules.init({ size = 3 }, rng), [0, 3]);
  assert BotLogic.givesThirdSide(s, 12);
  assert BotLogic.givesThirdSide(s, 13);
  assert not BotLogic.givesThirdSide(s, 7);
  for (seed in Nat.range(0, 40)) {
    let l = lineOf(BotLogic.chooseMove(request(s, #p1, 2, "Hard"), seed));
    assert l != 12 and l != 13;
    assert not BotLogic.givesThirdSide(s, l);
  };
  // Easy, over the same seeds, does give one away at some point.
  var gaveAway = false;
  for (seed in Nat.range(0, 40)) {
    let l = lineOf(BotLogic.chooseMove(request(s, #p1, 2, "Easy"), seed));
    if (BotLogic.givesThirdSide(s, l)) gaveAway := true;
  };
  assert gaveAway;
};
Debug.print("3. Hard plays safe OK");

// ── 4. forced to give, Hard gives the shorter chain ────────────────────
do {
  // 2x2 board. Lines: h(r,c) = r*2 + c (0..5), v(r,c) = 6 + r*3 + c (6..11).
  // Box 0: 0,2,6,7   Box 1: 1,3,7,8   Box 2: 2,4,9,10   Box 3: 3,5,10,11.
  // After 0, 6, 1, 8, 4, 9, 5, 11 every box has two sides and every
  // remaining line (2, 3, 7, 10) opens the whole 4-box ring.
  let ring = play(Rules.init({ size = 2 }, rng), [0, 6, 1, 8, 4, 9, 5, 11]);
  assert Rules.toMove(ring) == #p1;
  for (l in [2, 3, 7, 10].values()) {
    assert BotLogic.givesThirdSide(ring, l);
    assert BotLogic.giveaway(ring, #p1, l) == 4;
  };

  // 3x3 board, built by hand. Lines: h(r,c) = r*3 + c (0..11),
  // v(r,c) = 12 + r*4 + c (12..23); box (r,c) = h(r,c), h(r+1,c), v(r,c), v(r,c+1).
  // Boxes 0, 1, 3, 4, 5, 8 are claimed (every side drawn). Unclaimed:
  //   box 2 (sides 2, 5, 14, 15): 5 and 14 drawn, 2 and 15 open — a 1-box
  //     pocket: opening it costs 1.
  //   boxes 6 (6, 9, 20, 21) and 7 (7, 10, 21, 22): 6, 20, 7, 22 drawn;
  //     9, 21, 10 open — a 2-box chain: opening it costs 2.
  let n = 3;
  let open = [2, 15, 9, 21, 10];
  let lines = Array.tabulate<Rules.Line>(Rules.lineCount(n), func(i) = if (open.any(func(o) = o == i)) null else ?#p2);
  let boxes = Array.tabulate<?TP.Seat>(9, func(b) = if (b == 2 or b == 6 or b == 7) null else ?#p2);
  let pos : Rules.State = {
    size = n;
    lines;
    boxes;
    lastTurn = [];
  };
  for (l in open.values()) assert BotLogic.givesThirdSide(pos, l);
  assert BotLogic.giveaway(pos, #p1, 2) == 1;
  assert BotLogic.giveaway(pos, #p1, 15) == 1;
  assert BotLogic.giveaway(pos, #p1, 9) == 2;
  assert BotLogic.giveaway(pos, #p1, 10) == 2;
  assert BotLogic.giveaway(pos, #p1, 21) == 2;
  for (seed in Nat.range(0, 20)) {
    let l = lineOf(BotLogic.chooseMove(request(pos, #p1, 20, "Hard"), seed));
    assert l == 2 or l == 15;
  };
};
Debug.print("4. cheapest sacrifice OK");

// ── 5. Hard beats Easy on 3x3 over a few seeds ─────────────────────────
do {
  var hardWins = 0;
  var games = 0;
  for (seed in [3, 11, 19, 27, 35, 43].values()) {
    // Alternate who starts: Hard is p1 on even games.
    let hardSeat : TP.Seat = if (games % 2 == 0) #p1 else #p2;
    var s = Rules.init({ size = 3 }, rng);
    var step = 0;
    var result : ?TP.Verdict = null;
    label g loop {
      let seat = Rules.toMove(s);
      let c = if (seat == hardSeat) "Hard" else "Easy";
      let a = BotLogic.chooseMove(request(s, seat, step, c), seed + step);
      switch (Rules.move(s, seat, a, rng)) {
        case (#err why) Runtime.trap("bot played an illegal turn: " # why);
        case (#ok { state; verdict }) {
          s := state;
          step += 1;
          switch (verdict) {
            case (?v) { result := ?v; break g };
            case null {};
          };
        };
      };
      if (step > 30) Runtime.trap("game did not end");
    };
    games += 1;
    switch (result, hardSeat) {
      case (?#p1Wins, #p1) hardWins += 1;
      case (?#p2Wins, #p2) hardWins += 1;
      case (_) {};
    };
  };
  Debug.print("   Hard won " # hardWins.toText() # " of " # games.toText());
  assert hardWins * 2 > games; // a clear majority
};
Debug.print("5. Hard beats Easy OK");

Debug.print("ALL DotsAndBoxes BOT CHECKS PASSED");
