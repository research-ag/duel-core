// Unit checks for CheckersRules' pure functions: init/validate/resolve
// exercised directly against synthetic boards, no engine, no actor.
import Rng "mo:duel-game-core/rng";
import R "../src/CheckersRules";
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let rng = Rng.new(42);

// ── board-building helpers (plain data ─────────────────────────────────────

func idx(r : Nat, c : Nat) : Nat = r * 8 + c;

func emptyBoard() : R.Board = Array.repeat<()>((), 64).mapEntries<(), ?R.Piece>(func(_, _) = null);

func withPieces(pieces : [(Nat, R.Piece)]) : R.Board {
  var b = emptyBoard();
  for ((i, p) in pieces.values()) {
    b := b.mapEntries<?R.Piece, ?R.Piece>(func(cur, j) = if (j == i) ?p else cur);
  };
  b;
};

func countPieces(board : R.Board, p : R.Piece) : Nat {
  var n = 0;
  for (cell in board.values()) {
    switch (cell) { case (?q) if (q == p) n += 1; case null {} };
  };
  n;
};

// ── 1. init() is a clean, standard starting position ───────────────────────
let s0 = R.init({}, rng);
assert s0.board.size() == 64;
assert countPieces(s0.board, #manP1) == 12;
assert countPieces(s0.board, #manP2) == 12;
assert countPieces(s0.board, #kingP1) == 0;
assert countPieces(s0.board, #kingP2) == 0;
assert s0.board[idx(4, 1)] == null and s0.board[idx(4, 3)] == null; // the empty middle
Debug.print("1. init() OK");

// ── 2. spec() hands out the same rules, in #turnBased mode ───────────────
let sp = switch (R.spec) {
  case (#turnBased s) s;
  case (#simultaneous _) Runtime.trap("checkers is a #turnBased game");
};
assert sp.init({}, rng).board == s0.board;
Debug.print("2. spec wiring OK");

// ── 3. validate: a man moves forward only ──────────────────────────────────
let lonelyMan = withPieces([(idx(4, 3), #manP1)]);
switch (R.validate({ board = lonelyMan; toMove = #p1 }, #p1, #move { from = idx(4, 3); to = idx(3, 2) })) {
  case null {};
  case (?_) Runtime.trap("a man's own forward diagonal must be legal");
};
switch (R.validate({ board = lonelyMan; toMove = #p1 }, #p1, #move { from = idx(4, 3); to = idx(5, 4) })) {
  case (?_) {};
  case null Runtime.trap("a man may not move backward");
};
Debug.print("3. man forward-only OK");

// ── 4. validate: a king may move either direction ──────────────────────────
let lonelyKing = withPieces([(idx(4, 3), #kingP1)]);
switch (R.validate({ board = lonelyKing; toMove = #p1 }, #p1, #move { from = idx(4, 3); to = idx(5, 4) })) {
  case null {};
  case (?_) Runtime.trap("a king must be able to move backward too");
};
Debug.print("4. king both-directions OK");

// ── 5. validate: mandatory capture blocks a plain move, and offers the jump
//      instead ──────────────────────────────────────────────────────────────
let captureBoard = withPieces([(idx(4, 3), #manP1), (idx(3, 2), #manP2)]);
switch (R.validate({ board = captureBoard; toMove = #p1 }, #p1, #move { from = idx(4, 3); to = idx(3, 4) })) {
  case (?_) {};
  case null Runtime.trap("a plain move must be illegal while a capture is available");
};
switch (R.validate({ board = captureBoard; toMove = #p1 }, #p1, #jump { path = [idx(4, 3), idx(2, 1)] })) {
  case null {};
  case (?_) Runtime.trap("the capture itself must be legal");
};
Debug.print("5. mandatory capture OK");

// ── 6. validate: a capture chain must be completed with the same piece ─────
let chainBoard = withPieces([(idx(6, 1), #manP1), (idx(5, 2), #manP2), (idx(3, 4), #manP2)]);
switch (R.validate({ board = chainBoard; toMove = #p1 }, #p1, #jump { path = [idx(6, 1), idx(4, 3)] })) {
  case (?_) {};
  case null Runtime.trap("stopping mid-chain while another capture is available must be rejected");
};
switch (R.validate({ board = chainBoard; toMove = #p1 }, #p1, #jump { path = [idx(6, 1), idx(4, 3), idx(2, 5)] })) {
  case null {};
  case (?_) Runtime.trap("the full, maximal chain must be legal");
};
Debug.print("6. maximal capture chain OK");

// ── 7. resolve: a plain move relocates the piece, nothing else ─────────────
do {
  let r = R.resolve({ board = lonelyMan; toMove = #p1 }, #p1, #move { from = idx(4, 3); to = idx(3, 2) });
  assert r.state.board[idx(4, 3)] == null;
  assert r.state.board[idx(3, 2)] == ?#manP1;
  assert r.verdict == ?#p1Wins; // the lone p2... there IS no p2 piece, so
  // the opponent has zero pieces and thus no legal move — win by
  // elimination, even though nothing was actually captured this move.
};
Debug.print("7. plain move OK");

// ── 8. resolve: a capture removes the victim and can chain multiple ────────
do {
  let r = R.resolve({ board = chainBoard; toMove = #p1 }, #p1, #jump { path = [idx(6, 1), idx(4, 3), idx(2, 5)] });
  assert r.state.board[idx(6, 1)] == null; // origin cleared
  assert r.state.board[idx(5, 2)] == null; // first victim gone
  assert r.state.board[idx(3, 4)] == null; // second victim gone
  assert r.state.board[idx(2, 5)] == ?#manP1; // landed, still a man (row 2 isn't p1's back row)
  assert r.verdict == ?#p1Wins; // p2 has zero pieces left after both captures
};
Debug.print("8. multi-jump chain OK");

// ── 9. resolve: reaching the far row promotes, without ending the game if
//      the opponent still has a move elsewhere ──────────────────────────────
do {
  let board = withPieces([(idx(1, 2), #manP1), (idx(6, 1), #manP2)]);
  let r = R.resolve({ board; toMove = #p1 }, #p1, #move { from = idx(1, 2); to = idx(0, 1) });
  assert r.state.board[idx(0, 1)] == ?#kingP1;
  assert r.verdict == null; // p2's own piece at (6,1) can still step to (7,0)/(7,2)
};
Debug.print("9. promotion without ending the game OK");

// ── 10. resolve: a seat with pieces but no legal move at all still loses
//      (stalemate, not just elimination) ────────────────────────────────────
do {
  // p2's lone piece at (0,7) has exactly one forward destination, (1,6) —
  // blocked by a p1 piece there, whose own landing square (2,5) is also
  // blocked, so p2 can't even jump it. A separate, unrelated p1 piece at
  // (4,3) makes the actual submitted move.
  let board = withPieces([
    (idx(0, 7), #manP2),
    (idx(1, 6), #manP1),
    (idx(2, 5), #manP1),
    (idx(4, 3), #manP1),
  ]);
  let r = R.resolve({ board; toMove = #p1 }, #p1, #move { from = idx(4, 3); to = idx(3, 2) });
  assert r.verdict == ?#p1Wins;
};
Debug.print("10. stalemate loss (pieces remain, but no legal move) OK");

// ── 11. legalActions: plain moves when nobody has a capture, the SAME
//      maximal chains `validate` accepts when a capture is mandatory ────────
do {
  assert R.legalActions(s0, #p1).size() == 7; // the standard opening's own count
  for (a in R.legalActions(s0, #p1).values()) {
    switch (a) {
      case (#move _) {};
      case (#jump _) Runtime.trap("no capture is available yet — every result must be a #move");
    };
  };

  // chainBoard (test 6, above): #p1 has exactly one capturing piece, and
  // exactly one maximal chain from it — legalActions must return that
  // one #jump, nothing else, and validate() must accept it unchanged.
  let chainMoves = R.legalActions({ board = chainBoard; toMove = #p1 }, #p1);
  assert chainMoves.size() == 1;
  switch (chainMoves[0]) {
    case (#jump { path }) {
      assert path == [idx(6, 1), idx(4, 3), idx(2, 5)];
      switch (R.validate({ board = chainBoard; toMove = #p1 }, #p1, #jump { path })) {
        case null {};
        case (?why) Runtime.trap("legalActions produced an illegal chain: " # why);
      };
    };
    case (#move _) Runtime.trap("a capture is mandatory here — legalActions must not offer a #move");
  };

  // a seat with no legal action at all gets back an empty array — the
  // same condition resolve()'s own win check tests.
  let stalemateBoard = withPieces([
    (idx(0, 7), #manP2),
    (idx(1, 6), #manP1),
    (idx(2, 5), #manP1),
  ]);
  assert R.legalActions({ board = stalemateBoard; toMove = #p1 }, #p2).size() == 0;
};
Debug.print("11. legalActions mirrors validate's own legality, including mandatory-capture OK");

Debug.print("ALL CHECKERS RULES UNIT CHECKS PASSED");
