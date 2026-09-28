// One short session narrative, driven through the REAL engine end to
// end: join, a couple of real opening moves (exercising board routing for
// real), then (per
// skills/duel-game-core/references/testing-deep-dive.md's technique) the
// live board is seeded directly via `Table.phase`'s own public `var`
// field to a position one legal placement from winning the WHOLE match,
// and that final move is submitted for real — so the engine's own turn/
// seat/timestamp bookkeeping around the ending is exercised genuinely,
// only the long middle game (up to 81 plies in the worst case) is
// skipped.
// Run: moc -r --package core <core/src> --package duel-game-core
//      <duel-game-core-backend/src> test/Lifecycle.test.mo
import TP "mo:duel-game-core";
import Table "mo:duel-game-core/table";
import Array "mo:core/Array";
import Rules "../src/UltimateTicTacToeRules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

type Tbl = TP.Table<Rules.State, Rules.Action>;

let spec = Rules.spec();
let now : Int = 1_000_000_000_000;

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func withCells(marks : [(Nat, Nat, TP.Seat)]) : [?TP.Seat] {
  var cells = Array.repeat<?TP.Seat>(null, 81);
  for ((board, cell, seat) in marks.values()) {
    let idx = board * 9 + cell;
    cells := cells.mapEntries<?TP.Seat, ?TP.Seat>(func(cur, j) = if (j == idx) ?seat else cur);
  };
  cells;
};

func withResults(overrides : [(Nat, Rules.BoardResult)]) : [?Rules.BoardResult] {
  var results = Array.repeat<?Rules.BoardResult>(null, 9);
  for ((board, r) in overrides.values()) {
    results := results.mapEntries<?Rules.BoardResult, ?Rules.BoardResult>(func(cur, j) = if (j == board) ?r else cur);
  };
  results;
};

let t = Table.new<Rules.State, Rules.Action>(60_000_000_000, 15_000_000_000, #open, "test");

// ── 1. join seats X/O, X moves first ────────────────────────────────────────
ignore ok(t.join(spec, now, "x", #p1), "x joins");
switch (ok(t.join(spec, now, "o", #p2), "o joins")) {
  case (#started _) {};
  case (_) Runtime.trap("o's join should complete the pair and start the game");
};
Debug.print("1. join OK");

// ── 2. a couple of genuine opening moves resolve through the real board,
//        routing enforced ───────────────────────────────────────────────────
func genOf(session : Text) : Nat = switch (t.status(spec, now, session)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in an active game");
};
func turnOf(session : Text) : Nat = switch (t.status(spec, now, session)) {
  case (#inGame v) v.turn;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};
ignore ok(t.submit(spec, now, "x", genOf("x"), turnOf("x"), #place { board = 4; cell = 4 }), "x opens the center board's center cell");
ignore ok(t.submit(spec, now, "o", genOf("o"), turnOf("o"), #place { board = 4; cell = 0 }), "o replies, routing x to board 0");
switch (t.status(spec, now, "x")) {
  case (#inGame v) { assert v.turn == 2; assert v.game.activeBoard == ?0 };
  case (_) Runtime.trap("x should be back on turn, routed to board 0");
};
Debug.print("2. opening moves through the real board, routing enforced OK");

// ── 3. seed the board one legal placement from winning the WHOLE match:
//        p1 already owns local boards 0 and 1 outright, and board 2 is
//        one move from a p1 win too — completing the top meta-row ─────────
switch (t.phase) {
  case (#active g) {
    t.phase := #active {
      g with
      game = {
        cells = withCells([(2, 0, #p1), (2, 1, #p1), (2, 3, #p2), (2, 4, #p2)]);
        results = withResults([(0, #p1), (1, #p1)]);
        activeBoard = ?2;
      };
    };
  };
  case (_) Runtime.trap("expected a live game to seed");
};
switch (ok(t.submit(spec, now, "x", genOf("x"), turnOf("x"), #place { board = 2; cell = 2 }), "x's finishing placement")) {
  case (#gameEnded r) { assert r.verdict == #p1Wins };
  case (_) Runtime.trap("completing the top meta-row must end the whole match");
};
switch (t.status(spec, now, "o")) {
  case (#debrief d) switch (d.end) {
    case (#finished(#p1Wins)) {};
    case (_) Runtime.trap("expected a #finished(#p1Wins) debrief");
  };
  case (_) Runtime.trap("o should land in a shared debrief too");
};
Debug.print("3. finishing placement ends the whole match through the real engine OK");

Debug.print("ALL ULTIMATE TIC-TAC-TOE LIFECYCLE CHECKS PASSED");
