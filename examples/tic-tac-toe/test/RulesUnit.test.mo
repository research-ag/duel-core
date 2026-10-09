// Unit checks for TicTacToeRules' pure functions: init/validate/resolve
// exercised directly against synthetic boards, no engine, no actor.
import R "../src/TicTacToeRules";
import TP "mo:duel-game-core";
import Rng "mo:duel-game-core/rng";
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let rng = Rng.new(42);

func withMarks(marks : [(Nat, TP.Seat)]) : R.Board {
  var b = Array.repeat<?TP.Seat>(null, 9);
  for ((i, seat) in marks.values()) {
    b := b.mapEntries<?TP.Seat, ?TP.Seat>(func(cur, j) = if (j == i) ?seat else cur);
  };
  b;
};

// ── 1. init() is a clean, empty board ──────────────────────────────────────
let s0 = R.init({}, rng);
assert s0.board.size() == 9;
assert s0.board.all<?TP.Seat>(func(cell) = cell == null);
Debug.print("1. init() OK");

// ── 2. spec() hands out the same rules, in #turnBased mode ───────────────
let sp = switch (R.spec) {
  case (#turnBased s) s;
  case (#simultaneous _) Runtime.trap("tic-tac-toe is a #turnBased game");
};
assert sp.init({}, rng).board == s0.board;
Debug.print("2. spec wiring OK");

// ── 3. validate: any empty cell is legal, an occupied one is not ───────────
let oneMark = withMarks([(4, #p1)]);
switch (R.validate({ board = oneMark }, #p2, #place { at = 0 })) {
  case null {};
  case (?_) Runtime.trap("an empty cell must be legal to place on");
};
switch (R.validate({ board = oneMark }, #p2, #place { at = 4 })) {
  case (?_) {};
  case null Runtime.trap("an already-occupied cell must be illegal");
};
switch (R.validate({ board = oneMark }, #p2, #place { at = 9 })) {
  case (?_) {};
  case null Runtime.trap("an out-of-bounds cell must be illegal");
};
Debug.print("3. validate OK");

// ── 4. resolve: a completed row wins ───────────────────────────────────────
do {
  let board = withMarks([(0, #p1), (1, #p1), (3, #p2), (4, #p2)]);
  let r = R.resolve({ board }, #p1, #place { at = 2 });
  assert r.state.board[2] == ?#p1;
  switch (r.verdict) {
    case (?#p1Wins) {};
    case (_) Runtime.trap("completing the top row must win for p1");
  };
};
Debug.print("4. row win OK");

// ── 5. resolve: a completed column wins ────────────────────────────────────
do {
  let board = withMarks([(0, #p2), (3, #p2), (1, #p1), (4, #p1)]);
  let r = R.resolve({ board }, #p2, #place { at = 6 });
  switch (r.verdict) {
    case (?#p2Wins) {};
    case (_) Runtime.trap("completing the left column must win for p2");
  };
};
Debug.print("5. column win OK");

// ── 6. resolve: a completed diagonal wins ──────────────────────────────────
do {
  let board = withMarks([(0, #p1), (4, #p1), (1, #p2), (2, #p2)]);
  let r = R.resolve({ board }, #p1, #place { at = 8 });
  switch (r.verdict) {
    case (?#p1Wins) {};
    case (_) Runtime.trap("completing the main diagonal must win for p1");
  };
};
Debug.print("6. diagonal win OK");

// ── 7. resolve: a full board with no line completed is a draw ──────────────
do {
  // X | O | X
  // X | O | O
  // O | X | X
  let board = withMarks([
    (0, #p1),
    (1, #p2),
    (2, #p1),
    (3, #p1),
    (4, #p2),
    (5, #p2),
    (6, #p2),
    (7, #p1),
  ]);
  let r = R.resolve({ board }, #p1, #place { at = 8 });
  assert r.state.board.all<?TP.Seat>(func(cell) = cell != null);
  switch (r.verdict) {
    case (?#draw) {};
    case (_) Runtime.trap("a full board with no line completed must be a draw");
  };
};
Debug.print("7. draw on a full board OK");

// ── 8. resolve: an ordinary placement that neither wins nor fills the board
//      just continues ───────────────────────────────────────────────────────
do {
  let r = R.resolve(s0, #p1, #place { at = 4 });
  assert r.verdict == null;
  assert r.state.board[4] == ?#p1;
};
Debug.print("8. ordinary placement continues OK");

// ── 9. legalActions: every empty cell, nothing else ────────────────────────
do {
  assert R.legalActions(s0, #p1).size() == 9;
  for (a in R.legalActions(s0, #p1).values()) {
    switch (a) {
      case (#place { at }) {
        switch (R.validate(s0, #p1, #place { at })) {
          case null {};
          case (?why) Runtime.trap("legalActions produced an illegal placement: " # why);
        };
      };
    };
  };

  let oneMarkMoves = R.legalActions({ board = oneMark }, #p2);
  assert oneMarkMoves.size() == 8;
  for (a in oneMarkMoves.values()) {
    switch (a) { case (#place { at }) assert at != 4 };
  };

  // A full board has no legal action at all.
  let fullBoard = withMarks([
    (0, #p1),
    (1, #p2),
    (2, #p1),
    (3, #p1),
    (4, #p2),
    (5, #p2),
    (6, #p2),
    (7, #p1),
    (8, #p1),
  ]);
  assert R.legalActions({ board = fullBoard }, #p1).size() == 0;
};
Debug.print("9. legalActions mirrors validate's own legality OK");

Debug.print("ALL TICTACTOE RULESUNIT CHECKS PASSED");
