// Ultimate tic-tac-toe rules plugged into the REAL engine (`Table`, not a
// synthetic call to `validate`/`resolve` directly) — focused on what's
// specific to this game on top of plain #alternating mechanics: board
// routing enforced through `submit` (a wrong-board resubmission refused,
// not just an occupied cell), and claim-win gated to the waiting seat.
// The engine's own generic #alternating mechanics (Err.#notYourTurn,
// immediate single-move resolve, claim-win gating, status's mode/turn
// reporting) already have their own exhaustive suite in duel-game-core
// itself (../../backend/test/Alternating.test.mo, against a trivial
// fixture) — this suite is not a second copy of that, just confirmation
// that real moves flow through the same machinery correctly.
// Run: moc -r --package core <core/src> --package duel-game-core
//      <duel-game-core-backend/src> test/Engine.test.mo
import TP "mo:duel-game-core";
import Table "mo:duel-game-core/table";
import Rules "../src/UltimateTicTacToeRules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

type Tbl = TP.Table<Rules.State, Rules.Action>;

let spec = Rules.spec();

let TIMEOUT : Int = 60_000_000_000; // 60s
let CLAIM_TIMEOUT : Int = 15_000_000_000; // 15s
let T0 : Int = 1_000_000_000_000;
let CLAIMABLE : Int = T0 + 16_000_000_000; // +16s — past the claim window

func fresh() : Tbl = Table.new<Rules.State, Rules.Action>(TIMEOUT, CLAIM_TIMEOUT, #open, "test", "");

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func genOf(t : Tbl, at : Int, session : Text) : Nat = switch (t.status(spec, at, session)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in an active game");
};
func turnOf(t : Tbl, at : Int, session : Text) : Nat = switch (t.status(spec, at, session)) {
  case (#inGame v) v.turn;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};

/// A live game: "x" on #p1, "o" on #p2, both seated at `at`. X always
/// moves first (turn 0), per `Table.toMove`.
func gameOf(at : Int) : Tbl {
  let t = fresh();
  ignore ok(t.join(spec, at, "x", #p1), "x joins");
  ignore ok(t.join(spec, at, "o", #p2), "o joins");
  t;
};

// ── 1. status reports #alternating mode; X (p1) moves first, free choice
//        of board on the very first move ──────────────────────────────────
var t = gameOf(T0);
switch (t.status(spec, T0, "x")) {
  case (#inGame v) {
    assert v.mode == #alternating;
    assert v.turn == 0;
    assert v.oppSubmitted;
    assert not v.youSubmitted;
    assert v.game.activeBoard == null;
  };
  case (_) Runtime.trap("x should be in a fresh game");
};
Debug.print("1. #alternating status, X to move, free choice of board OK");

// ── 2. O may not move before X ──────────────────────────────────────────────
t := gameOf(T0);
switch (t.submit(spec, T0, "o", genOf(t, T0, "o"), turnOf(t, T0, "o"), #place { board = 0; cell = 0 })) {
  case (#err(#notYourTurn)) {};
  case (_) Runtime.trap("O moving before X must be #notYourTurn");
};
Debug.print("2. off-turn submit rejected OK");

// ── 3. a legal opening resolves immediately, routes the opponent to the
//        board matching the cell just played, and a wrong-board /
//        occupied-cell resubmission is refused ─────────────────────────────
t := gameOf(T0);
switch (ok(t.submit(spec, T0, "x", genOf(t, T0, "x"), turnOf(t, T0, "x"), #place { board = 4; cell = 4 }), "x's opening")) {
  case (#roundResolved 1) {};
  case (_) Runtime.trap("a single legal placement must resolve immediately");
};
switch (t.status(spec, T0, "o")) {
  case (#inGame v) assert v.game.activeBoard == ?4; // x played cell 4 -> o routed to board 4
  case (_) Runtime.trap("o should be in-game, routed to board 4");
};
switch (t.submit(spec, T0, "o", genOf(t, T0, "o"), turnOf(t, T0, "o"), #place { board = 0; cell = 0 })) {
  case (#err(#illegalMove _)) {};
  case (_) Runtime.trap("o must be refused a placement outside the routed board");
};
ignore ok(t.submit(spec, T0, "o", genOf(t, T0, "o"), turnOf(t, T0, "o"), #place { board = 4; cell = 0 }), "o's reply");
switch (t.status(spec, T0, "x")) {
  case (#inGame v) {
    assert v.turn == 2;
    assert v.game.activeBoard == ?0; // o played cell 0 -> x routed to board 0
  };
  case (_) Runtime.trap("x should be back on turn, routed to board 0");
};
switch (t.submit(spec, T0, "x", genOf(t, T0, "x"), turnOf(t, T0, "x"), #place { board = 4; cell = 4 })) {
  case (#err(#illegalMove _)) {};
  case (_) Runtime.trap("placing on an occupied cell must be refused");
};
Debug.print("3. opening + reply, board routing enforced, wrong-board/occupied-cell rejected OK");

// ── 4. claim-win: only the waiting seat may claim, and only once overdue ────
t := gameOf(T0);
ignore ok(t.submit(spec, T0, "x", genOf(t, T0, "x"), turnOf(t, T0, "x"), #place { board = 4; cell = 4 }), "x's opening");
let xGen = genOf(t, T0, "x");
switch (t.claimWin(spec, CLAIMABLE, "o", genOf(t, CLAIMABLE, "o"))) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("the seat on turn must never be able to claimWin");
};
switch (t.claimWin(spec, T0, "x", xGen)) {
  case (#err(#notOverdue _)) {};
  case (_) Runtime.trap("claiming before the window elapsed must be #notOverdue");
};
ok(t.claimWin(spec, CLAIMABLE, "x", xGen), "x claims the overdue win");
switch (t.status(spec, CLAIMABLE, "o")) {
  case (#debrief d) switch (d.end) {
    case (#claimed(#p1)) {};
    case (_) Runtime.trap("expected x's claimed win in the shared debrief");
  };
  case (_) Runtime.trap("o should see x's claimed win");
};
Debug.print("4. claim-win gated to the waiting seat only OK");

Debug.print("ALL ULTIMATE TIC-TAC-TOE ENGINE CHECKS PASSED");
