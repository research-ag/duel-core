// Unit checks for DotsAndBoxesRules: init/move called directly, no
// engine. One block per illegal turn, per turn rule and per ending.
//
// Run: mops test
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import List "mo:core/List";
import Runtime "mo:core/Runtime";

import TP "mo:duel-game-core";
import Rng "mo:duel-game-core/rng";

import R "../src/DotsAndBoxesRules";

// A fixed seed makes every run identical (the rules draw nothing).
let rng = Rng.new(42);
let options : R.Options = { size = 3 };

// The seat on turn plays `lines` as one turn, trapping on a rejection or
// an unexpected end.
func play(s : R.State, lines : [Nat]) : R.State {
  switch (R.move(s, s.toMove, #draw { lines }, rng)) {
    case (#err why) Runtime.trap("rejected: " # why);
    case (#ok { state = _; verdict = ?_ }) Runtime.trap("unexpected end");
    case (#ok { state; verdict = null }) state;
  };
};

// One-line turns, one after another.
func playEach(s : R.State, lines : [Nat]) : R.State {
  var cur = s;
  for (l in lines.values()) cur := play(cur, [l]);
  cur;
};

// The seat on turn plays `lines` and returns the verdict.
func ending(s : R.State, lines : [Nat]) : ?TP.Verdict {
  switch (R.move(s, s.toMove, #draw { lines }, rng)) {
    case (#err why) Runtime.trap("rejected: " # why);
    case (#ok { state = _; verdict }) verdict;
  };
};

func expectErr(s : R.State, lines : [Nat], what : Text) {
  switch (R.move(s, s.toMove, #draw { lines }, rng)) {
    case (#err _) {};
    case (#ok _) Runtime.trap("expected a rejection: " # what);
  };
};

// ── 1. options, init, spec wiring ─────────────────────────────────────────
assert R.checkOptions(options) == null;
assert R.checkOptions({ size = 2 }) == null;
assert R.checkOptions({ size = 8 }) == null;
assert R.checkOptions({ size = 1 }) != null;
assert R.checkOptions({ size = 9 }) != null;
assert R.checkOptions({ size = 0 }) != null;

let s0 = R.init(options, rng);
assert s0.size == 3;
assert s0.lines.size() == 24; // 2*3*4
assert s0.boxes.size() == 9;
assert s0.lines.all(func(l) = l == null);
assert s0.boxes.all(func(b) = b == null);
assert s0.toMove == #p1;
assert s0.lastTurn == [];
assert R.toMove(s0) == #p1;

for (n in [2, 4, 5, 6, 8].values()) {
  let s = R.init({ size = n }, rng);
  assert s.lines.size() == 2 * n * (n + 1);
  assert s.boxes.size() == n * n;
};

let sp = switch (R.spec) {
  case (#turnBased s) s;
  case (#simultaneous _) Runtime.trap("expected a #turnBased spec");
};
assert sp.checkOptions(options) == null;
assert sp.init(options, rng).lines.size() == 24;
assert sp.toMove(s0) == #p1;
assert sp.view(s0, #p2, false) == s0;
Debug.print("1. options + init + spec wiring OK");

// ── 2. geometry: box sides and the boxes of a line agree ──────────────────
do {
  let n = 3;
  // Box (0,0): top h(0,0)=0, bottom h(1,0)=3, left v(0,0)=12, right v(0,1)=13.
  assert R.boxSides(n, 0) == [0, 3, 12, 13];
  // Box (2,2): top h(2,2)=8, bottom h(3,2)=11, left v(2,2)=22, right v(2,3)=23.
  assert R.boxSides(n, 8) == [8, 11, 22, 23];
  // Top edge line borders one box; an inner horizontal line borders two.
  assert R.boxesOfLine(n, 0) == [0];
  assert R.boxesOfLine(n, 3) == [0, 3];
  assert R.boxesOfLine(n, 11) == [8];
  // Left edge vertical borders one box; an inner vertical two.
  assert R.boxesOfLine(n, 12) == [0];
  assert R.boxesOfLine(n, 13) == [0, 1];
  assert R.boxesOfLine(n, 23) == [8];
  // Every box's sides list that box among their boxes.
  for (b in [0, 1, 2, 3, 4, 5, 6, 7, 8].values()) {
    for (side in R.boxSides(n, b).values()) {
      assert R.boxesOfLine(n, side).any(func(x) = x == b);
    };
  };
};
Debug.print("2. geometry OK");

// ── 3. each illegal turn is rejected ──────────────────────────────────────
expectErr(s0, [], "no line");
expectErr(s0, [24], "off the board");
expectErr(s0, [1_000], "far off the board");
expectErr(s0, [0, 1], "a line that closes nothing ends the turn");
do {
  let s1 = play(s0, [0]);
  expectErr(s1, [0], "already drawn");
  // Every undrawn line is a whole turn on an open board.
  for ((i, l) in s1.lines.enumerate()) {
    switch (l) {
      case null ignore play(s1, [i]);
      case (?_) expectErr(s1, [i], "already drawn");
    };
  };
  // Box 0 (sides 0, 3, 12, 13) needs 13 once 0, 3, 12 are drawn.
  let s3 = playEach(s0, [0, 3, 12]);
  assert s3.toMove == #p2;
  expectErr(s3, [13], "a closed box draws again");
  expectErr(s3, [13, 13], "the same line twice");
  expectErr(s3, [13, 24], "a follow-up off the board");
};
Debug.print("3. rejections OK");

// ── 4. a one-line turn passes the turn and is recorded ────────────────────
do {
  let s1 = play(s0, [0]);
  assert s1.lines[0] == ?#p1;
  assert s1.toMove == #p2;
  assert s1.lastTurn == [0];
  assert R.boxesOf(s1, #p1) == 0;
  let s2 = play(s1, [5]);
  assert s2.lines[5] == ?#p2;
  assert s2.toMove == #p1;
  assert s2.lastTurn == [5];
};
Debug.print("4. turn passing OK");

// ── 5. closing a box claims it and draws again within the turn ────────────
do {
  // p1: 0 (top of box 0), p2: 3 (bottom), p1: 12 (left); p2: 13 (right)
  // closes it for p2, who then draws 1.
  let s3 = playEach(s0, [0, 3, 12]);
  let s4 = play(s3, [13, 1]);
  assert s4.boxes[0] == ?#p2;
  assert s4.lines[13] == ?#p2 and s4.lines[1] == ?#p2;
  assert s4.toMove == #p1;
  assert s4.lastTurn == [13, 1];
  assert R.boxesOf(s4, #p2) == 1;
  assert R.boxesOf(s4, #p1) == 0;
  // Box 1 is not claimed by its shared side alone.
  assert s4.boxes[1] == null;
};
Debug.print("5. box claim + draw again OK");

// ── 6. one line can close two boxes at once ───────────────────────────────
do {
  // Boxes 0 and 1 share v(0,1) = 13. Draw everything else around both first
  // with one-line turns, then line 13 closes both.
  // Box 0 sides: 0, 3, 12, 13. Box 1 sides: 1, 4, 13, 14.
  let s = playEach(s0, [0, 1, 3, 4, 12, 14]);
  // Six one-line turns: p1 p2 p1 p2 p1 p2, so p1 is on turn.
  assert s.toMove == #p1;
  let s1 = play(s, [13, 23]);
  assert s1.boxes[0] == ?#p1;
  assert s1.boxes[1] == ?#p1;
  assert s1.toMove == #p2;
  assert R.boxesOf(s1, #p1) == 2;
};
Debug.print("6. double box OK");

// ── 7. endings on a 2x2 board: p1 wins, p2 wins, draw ─────────────────────
// 2x2 lines: h(r,c) = r*2 + c (0..5), v(r,c) = 6 + r*3 + c (6..11).
// Box 0: 0, 2, 6, 7.  Box 1: 1, 3, 7, 8.  Box 2: 2, 4, 9, 10.  Box 3: 3, 5, 10, 11.
let border = [0, 1, 4, 5, 6, 8, 9, 11];

do {
  // After the border (8 one-line turns) p1 is on turn. 7 closes nothing
  // (box 0 misses 2, box 1 misses 3). p2: 2 closes box 0, 10 closes box
  // 2, 3 closes boxes 1 and 3 and fills the board: p2 wins 4:0.
  var s = playEach(R.init({ size = 2 }, rng), border);
  assert s.toMove == #p1;
  s := play(s, [7]);
  assert s.toMove == #p2;
  expectErr(s, [2, 10], "a closed box draws again");
  switch (ending(s, [2, 10, 3])) {
    case (?#p2Wins) {};
    case (_) Runtime.trap("p2 taking all four boxes must win");
  };
};

do {
  // p1 plays 2 and p2 plays 3, closing nothing; p1's 7 closes boxes 0
  // and 1, then 10 closes 2 and 3: p1 wins 4:0.
  var s = playEach(R.init({ size = 2 }, rng), border);
  s := playEach(s, [2, 3]);
  assert s.toMove == #p1;
  switch (ending(s, [7, 10])) {
    case (?#p1Wins) {};
    case (_) Runtime.trap("p1 taking all four boxes must win");
  };
};

do {
  // A 2:2 split. All six horizontals first (no box can close without a
  // vertical), then 6 and 8: eight one-line turns, p1 on turn.
  // p1: 7 closes boxes 0 and 1, then 9 closes nothing (box 2 misses 10).
  // p2: 10 closes box 2, then 11 closes box 3 and fills the board at 2:2.
  var s = playEach(R.init({ size = 2 }, rng), [0, 1, 2, 3, 4, 5, 6, 8]);
  assert s.toMove == #p1;
  s := play(s, [7, 9]);
  assert s.boxes[0] == ?#p1 and s.boxes[1] == ?#p1 and s.toMove == #p2;
  assert s.lastTurn == [7, 9];
  switch (ending(s, [10, 11])) {
    case (?#draw) {};
    case (_) Runtime.trap("a 2:2 split must be a draw");
  };
};
Debug.print("7. endings OK");

// ── 8. the game does not end before the board is full ─────────────────────
do {
  // A 3x3 board: even with a clear majority (5 of 9 boxes) the game goes
  // on while a line is undrawn. Build a state by hand: all lines drawn but
  // the last, boxes split 5:3 with one box unclaimed.
  let n = 3;
  let total = R.lineCount(n);
  let lines = Array.tabulate<R.Line>(total, func(i) = if (i == 23) null else ?#p1);
  let boxes = Array.tabulate<?TP.Seat>(9, func(b) = if (b == 8) null else if (b < 5) ?#p1 else ?#p2);
  let s : R.State = { size = n; lines; boxes; toMove = #p2; lastTurn = [22] };
  assert not R.isFull(s);
  switch (R.move(s, #p2, #draw { lines = [23] }, rng)) {
    case (#ok { state; verdict = ?#p1Wins }) {
      assert state.boxes[8] == ?#p2; // the last box goes to p2, 5:4
      assert R.boxesOf(state, #p2) == 4;
    };
    case (_) Runtime.trap("filling the board must end it with p1's majority");
  };
};
Debug.print("8. no early ending OK");

// ── 9. a full playthrough on 3x3 ends with the right counts ─────────────
do {
  var s = s0;
  var over : ?TP.Verdict = null;
  var lines = 0;
  label game loop {
    // Each turn draws the first undrawn line until one closes nothing.
    let turn = List.empty<Nat>();
    var cur = s;
    label t loop {
      let ?line = cur.lines.findIndex(func(l) = l == null) else Runtime.trap("no undrawn line");
      turn.add(line);
      let r = R.drawLine(cur, s.toMove, line);
      cur := r.state;
      if (not r.closed or R.isFull(cur)) break t;
    };
    switch (R.move(s, s.toMove, #draw { lines = turn.toArray() }, rng)) {
      case (#err why) Runtime.trap("rejected mid-game: " # why);
      case (#ok { state; verdict }) {
        s := state;
        lines += turn.size();
        switch (verdict) {
          case (?v) { over := ?v; break game };
          case null {};
        };
      };
    };
  };
  assert lines == 24;
  assert R.isFull(s);
  assert R.boxesOf(s, #p1) + R.boxesOf(s, #p2) == 9;
  switch (over) {
    case (?#p1Wins) assert R.boxesOf(s, #p1) > R.boxesOf(s, #p2);
    case (?#p2Wins) assert R.boxesOf(s, #p2) > R.boxesOf(s, #p1);
    case (?#draw) Runtime.trap("9 boxes cannot split evenly");
    case null Runtime.trap("a full board must end the game");
  };
};
Debug.print("9. full playthrough OK");

Debug.print("ALL DotsAndBoxesRules RULESUNIT CHECKS PASSED");
