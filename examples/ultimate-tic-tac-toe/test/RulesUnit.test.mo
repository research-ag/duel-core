// Unit checks for UltimateTicTacToeRules' pure functions: init/validate/
// resolve/legalActions exercised directly against synthetic states, no
// engine, no actor.
// Run: moc -r --package core <core/src> --package duel-game-core
//      <duel-game-core-backend/src> test/RulesUnit.test.mo
import R "../src/UltimateTicTacToeRules";
import TP "mo:duel-game-core";
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

func withCells(marks : [(Nat, Nat, TP.Seat)]) : [?TP.Seat] {
  var cells = Array.repeat<?TP.Seat>(null, 81);
  for ((board, cell, seat) in marks.values()) {
    let idx = board * 9 + cell;
    cells := cells.mapEntries<?TP.Seat, ?TP.Seat>(func(cur, j) = if (j == idx) ?seat else cur);
  };
  cells;
};

func withResults(overrides : [(Nat, R.BoardResult)]) : [?R.BoardResult] {
  var results = Array.repeat<?R.BoardResult>(null, 9);
  for ((board, r) in overrides.values()) {
    results := results.mapEntries<?R.BoardResult, ?R.BoardResult>(func(cur, j) = if (j == board) ?r else cur);
  };
  results;
};

func stateOf(marks : [(Nat, Nat, TP.Seat)], overrides : [(Nat, R.BoardResult)], activeBoard : ?Nat) : R.State {
  { cells = withCells(marks); results = withResults(overrides); activeBoard };
};

// ── 1. init() is a clean, empty state ───────────────────────────────────────
let s0 = R.init("");
assert s0.cells.size() == 81;
assert s0.results.size() == 9;
assert s0.cells.all<?TP.Seat>(func(cell) = cell == null);
assert s0.results.all<?R.BoardResult>(func(r) = r == null);
assert s0.activeBoard == null;
Debug.print("1. init() OK");

// ── 2. spec() hands out the same rules, in #alternating mode ───────────────
let sp = switch (R.spec()) {
  case (#alternating s) s;
  case (#simultaneous _) Runtime.trap("ultimate tic-tac-toe is a #alternating game");
};
assert sp.init("").cells == s0.cells;
Debug.print("2. spec wiring OK");

// ── 3. validate: free choice (activeBoard == null) accepts any empty
//        cell in any undecided board; rejects occupied cells and
//        out-of-bounds board/cell ─────────────────────────────────────────
do {
  let s = stateOf([(0, 4, #p1)], [], null);
  switch (R.validate(s, #p2, #place { board = 3; cell = 0 })) {
    case null {};
    case (?_) Runtime.trap("an empty cell in an open board must be legal when activeBoard is free");
  };
  switch (R.validate(s, #p2, #place { board = 0; cell = 4 })) {
    case (?_) {};
    case null Runtime.trap("an already-occupied cell must be illegal");
  };
  switch (R.validate(s, #p2, #place { board = 9; cell = 0 })) {
    case (?_) {};
    case null Runtime.trap("an out-of-bounds board must be illegal");
  };
  switch (R.validate(s, #p2, #place { board = 0; cell = 9 })) {
    case (?_) {};
    case null Runtime.trap("an out-of-bounds cell must be illegal");
  };
};
Debug.print("3. validate: free choice OK");

// ── 4. validate: activeBoard constrains the next placement to that one
//        board ──────────────────────────────────────────────────────────────
do {
  let s = stateOf([], [], ?4);
  switch (R.validate(s, #p1, #place { board = 4; cell = 0 })) {
    case null {};
    case (?_) Runtime.trap("the constrained board's own empty cell must be legal");
  };
  switch (R.validate(s, #p1, #place { board = 5; cell = 0 })) {
    case (?_) {};
    case null Runtime.trap("a different board must be illegal while constrained");
  };
};
Debug.print("4. validate: constrained to activeBoard OK");

// ── 5. validate: a decided board never accepts a placement, constrained
//        or not ─────────────────────────────────────────────────────────────
do {
  let s = stateOf([], [(2, #p1)], null);
  switch (R.validate(s, #p1, #place { board = 2; cell = 0 })) {
    case (?_) {};
    case null Runtime.trap("a decided board must never accept a placement");
  };
};
Debug.print("5. validate: decided board always illegal OK");

// ── 6. resolve: a local-board win decides that board but doesn't end the
//        match by itself, and routes the opponent to the board matching
//        the cell just played ──────────────────────────────────────────────
do {
  let s = stateOf([(0, 0, #p1), (0, 1, #p1), (0, 3, #p2), (0, 4, #p2)], [], ?0);
  let r = R.resolve(s, #p1, #place { board = 0; cell = 2 });
  assert r.state.cells[0 * 9 + 2] == ?#p1;
  assert r.state.results[0] == ?#p1;
  assert r.verdict == null;
  assert r.state.activeBoard == ?2; // routed by cell position, board 2 is open
};
Debug.print("6. local board win doesn't end the match; routes by cell position OK");

// ── 7. resolve: routing to an already-decided board frees the next
//        choice ─────────────────────────────────────────────────────────────
do {
  let s = stateOf([(3, 4, #p1), (3, 1, #p1), (3, 7, #p2), (3, 2, #p2)], [(5, #tie)], ?3);
  let r = R.resolve(s, #p1, #place { board = 3; cell = 5 });
  assert r.state.results[3] == null; // {1,4,5} is not a line
  assert r.state.activeBoard == null; // board 5 is already decided
};
Debug.print("7. routing to a decided board frees the next choice OK");

// ── 8. resolve: a full local board with no line completed ties that
//        board ───────────────────────────────────────────────────────────────
do {
  let s = stateOf(
    [
      (1, 0, #p1),
      (1, 1, #p2),
      (1, 2, #p1),
      (1, 3, #p1),
      (1, 4, #p2),
      (1, 5, #p2),
      (1, 6, #p2),
      (1, 7, #p1),
    ],
    [],
    ?1,
  );
  let r = R.resolve(s, #p1, #place { board = 1; cell = 8 });
  assert r.state.results[1] == ?#tie;
  assert r.verdict == null;
};
Debug.print("8. a full local board with no line completed ties that board OK");

// ── 9. resolve: completing a meta-line wins the whole match ────────────────
do {
  let s = stateOf([(2, 0, #p1), (2, 1, #p1), (2, 3, #p2), (2, 4, #p2)], [(0, #p1), (1, #p1)], ?2);
  let r = R.resolve(s, #p1, #place { board = 2; cell = 2 });
  assert r.state.results[2] == ?#p1;
  switch (r.verdict) {
    case (?#p1Wins) {};
    case (_) Runtime.trap("completing the top meta-row must win the whole match for p1");
  };
};
Debug.print("9. completing a meta-line wins the whole match OK");

// ── 10. resolve: every local board decided with no meta-line completed
//         is a draw ─────────────────────────────────────────────────────────
do {
  let presetResults : [(Nat, R.BoardResult)] = [(0, #p1), (1, #p2), (2, #p1), (3, #p1), (4, #p2), (5, #p2), (6, #p2), (7, #p1)];
  let boardCells : [(Nat, Nat, TP.Seat)] = [
    (8, 0, #p1),
    (8, 1, #p2),
    (8, 2, #p1),
    (8, 3, #p1),
    (8, 4, #p2),
    (8, 5, #p2),
    (8, 6, #p2),
    (8, 7, #p1),
  ];
  let s = stateOf(boardCells, presetResults, ?8);
  let r = R.resolve(s, #p1, #place { board = 8; cell = 8 });
  assert r.state.results[8] == ?#tie;
  assert r.state.results.all<?R.BoardResult>(func(res) = res != null);
  switch (r.verdict) {
    case (?#draw) {};
    case (_) Runtime.trap("a fully-decided meta board with no meta-line must be a draw");
  };
};
Debug.print("10. fully-decided meta board with no line completed is a draw OK");

// ── 11. legalActions mirrors validate's own legality, in every
//         activeBoard mode ─────────────────────────────────────────────────
do {
  let s0b = R.init("");
  assert R.legalActions(s0b, #p1).size() == 81;

  let s2 = stateOf([(4, 0, #p1)], [], ?4);
  let moves = R.legalActions(s2, #p2);
  assert moves.size() == 8;
  for (a in moves.values()) {
    switch (a) { case (#place { board; cell = _ }) assert board == 4 };
  };
  for (a in moves.values()) {
    switch (a) {
      case (#place { board; cell }) {
        switch (R.validate(s2, #p2, #place { board; cell })) {
          case null {};
          case (?why) Runtime.trap("legalActions produced an illegal placement: " # why);
        };
      };
    };
  };

  let s3 = stateOf([], [(4, #p1)], ?4);
  let moves3 = R.legalActions(s3, #p2);
  assert moves3.size() == 72; // 8 open boards * 9 cells each
  for (a in moves3.values()) {
    switch (a) { case (#place { board; cell = _ }) assert board != 4 };
  };
};
Debug.print("11. legalActions mirrors validate's own legality OK");

Debug.print("ALL ULTIMATE TIC-TAC-TOE RULESUNIT CHECKS PASSED");
