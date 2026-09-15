// One short session narrative, driven through the REAL engine end to
// end: join, a couple of real opening moves, then (per
// skills/duel-game-core/references/testing-deep-dive.md's technique —
// playing a genuine game to a win from the standard opening would take
// far more moves than is worth driving through the interpreter) the
// live board is seeded directly with `Table.phase`'s own public `var`
// field to a position one legal capture from finishing, and that final
// move is submitted for real — so the engine's own turn/seat/timestamp
// bookkeeping around the ending is exercised genuinely, only the long
// middle game is skipped.
// Run: moc -r --package core <core/src> --package duel-game-core
//      <duel-game-core-backend/src> test/Lifecycle.test.mo
import TP "mo:duel-game-core";
import Table "mo:duel-game-core/table";
import Array "mo:core/Array";
import Rules "../src/CheckersRules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

type Tbl = TP.Table<Rules.State, Rules.Action>;

let spec = Rules.spec();
let now : Int = 1_000_000_000_000;

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func idx(r : Nat, c : Nat) : Nat = r * 8 + c;

func emptyBoard() : Rules.Board = Array.repeat<()>((), 64).mapEntries<(), ?Rules.Piece>(func(_, _) = null);
func withPieces(pieces : [(Nat, Rules.Piece)]) : Rules.Board {
  var b = emptyBoard();
  for ((i, p) in pieces.values()) {
    b := b.mapEntries<?Rules.Piece, ?Rules.Piece>(func(cur, j) = if (j == i) ?p else cur);
  };
  b;
};

let t = Table.new<Rules.State, Rules.Action>(60_000_000_000, 15_000_000_000, #open, "test");

// ── 1. join seats red/black, red moves first ────────────────────────────
ignore ok(t.join(spec, now, "red", #p1), "red joins");
switch (ok(t.join(spec, now, "black", #p2), "black joins")) {
  case (#started _) {};
  case (_) Runtime.trap("black's join should complete the pair and start the game");
};
Debug.print("1. join OK");

// ── 2. a couple of genuine opening moves resolve through the real board ─
func genOf(session : Text) : Nat = switch (t.status(spec, now, session)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in an active game");
};
func turnOf(session : Text) : Nat = switch (t.status(spec, now, session)) {
  case (#inGame v) v.turn;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};
ignore ok(t.submit(spec, now, "red", genOf("red"), turnOf("red"), #move { from = idx(5, 0); to = idx(4, 1) }), "red opens");
ignore ok(t.submit(spec, now, "black", genOf("black"), turnOf("black"), #move { from = idx(2, 1); to = idx(3, 2) }), "black replies");
switch (t.status(spec, now, "red")) {
  case (#inGame v) assert v.turn == 2;
  case (_) Runtime.trap("red should be back on turn");
};
Debug.print("2. opening moves through the real board OK");

// ── 3. seed the board one legal capture from a finish, then play it for
//      real: red's man at (4,3) jumps black's last remaining piece at
//      (3,2), landing at (2,1) — black is left with zero pieces ────────
switch (t.phase) {
  case (#active g) {
    t.phase := #active {
      g with
      game = { board = withPieces([(idx(4, 3), #manP1), (idx(3, 2), #manP2)]) };
    };
  };
  case (_) Runtime.trap("expected a live game to seed");
};
switch (
  ok(
    t.submit(spec, now, "red", genOf("red"), turnOf("red"), #jump { path = [idx(4, 3), idx(2, 1)] }),
    "red's finishing capture",
  )
) {
  case (#gameEnded r) { assert r.verdict == #p1Wins };
  case (_) Runtime.trap("capturing black's last piece must end the match");
};
switch (t.status(spec, now, "black")) {
  case (#debrief d) switch (d.end) {
    case (#finished(#p1Wins)) {};
    case (_) Runtime.trap("expected a #finished(#p1Wins) debrief");
  };
  case (_) Runtime.trap("black should land in a shared debrief too");
};
Debug.print("3. finishing capture ends the match through the real engine OK");

Debug.print("ALL CHECKERS LIFECYCLE CHECKS PASSED");
