// One short narrative through the real engine: join, a couple of real opening
// moves, then the live board is seeded via `Table.phase` to one placement
// from finishing.
import TP "mo:duel-game-core";
import Table "mo:duel-game-core/table";
import Array "mo:core/Array";
import Rules "../src/TicTacToeRules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

type Tbl = TP.Table<Rules.State, Rules.Action>;

let spec = Rules.spec();
let now : Int = 1_000_000_000_000;

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func withMarks(marks : [(Nat, TP.Seat)]) : Rules.Board {
  var b = Array.repeat<?TP.Seat>(null, 9);
  for ((i, seat) in marks.values()) {
    b := b.mapEntries<?TP.Seat, ?TP.Seat>(func(cur, j) = if (j == i) ?seat else cur);
  };
  b;
};

let t = Table.new<Rules.State, Rules.Action>(60_000_000_000, 15_000_000_000, #open, "test", "");

// ── 1. join seats X/O, X moves first ───────────────────────────────────────
ignore ok(t.join(spec, now, "x", #p1), "x joins");
switch (ok(t.join(spec, now, "o", #p2), "o joins")) {
  case (#started _) {};
  case (_) Runtime.trap("o's join should complete the pair and start the game");
};
Debug.print("1. join OK");

// ── 2. a couple of genuine opening moves resolve through the real board ────
func genOf(session : Text) : Nat = switch (t.status(spec, now, session)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in an active game");
};
func turnOf(session : Text) : Nat = switch (t.status(spec, now, session)) {
  case (#inGame v) v.turn;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};
ignore ok(t.submit(spec, now, "x", genOf("x"), turnOf("x"), #place { at = 4 }), "x opens center");
ignore ok(t.submit(spec, now, "o", genOf("o"), turnOf("o"), #place { at = 0 }), "o replies corner");
switch (t.status(spec, now, "x")) {
  case (#inGame v) assert v.turn == 2;
  case (_) Runtime.trap("x should be back on turn");
};
Debug.print("2. opening moves through the real board OK");

// ── 3. seed the board one legal placement from a finish, then play it for
//      real: X holds the top row's first two cells and finishes it ──────────
switch (t.phase) {
  case (#active g) {
    t.phase := #active {
      g with
      game = { board = withMarks([(0, #p1), (1, #p1), (3, #p2), (4, #p2)]) };
    };
  };
  case (_) Runtime.trap("expected a live game to seed");
};
switch (ok(t.submit(spec, now, "x", genOf("x"), turnOf("x"), #place { at = 2 }), "x's finishing placement")) {
  case (#gameEnded r) { assert r.verdict == #p1Wins };
  case (_) Runtime.trap("completing the top row must end the match");
};
switch (t.status(spec, now, "o")) {
  case (#debrief d) switch (d.end) {
    case (#finished(#p1Wins)) {};
    case (_) Runtime.trap("expected a #finished(#p1Wins) debrief");
  };
  case (_) Runtime.trap("o should land in a shared debrief too");
};
Debug.print("3. finishing placement ends the match through the real engine OK");

Debug.print("ALL TICTACTOE LIFECYCLE CHECKS PASSED");
