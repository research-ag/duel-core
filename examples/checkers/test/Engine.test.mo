// Checkers rules plugged into the real `Table`: turn-order enforcement
// through `submit` and claim-win gated to the waiting seat.
import TP "mo:duel-game-core";
import Table "mo:duel-game-core/table";
import Rules "../src/CheckersRules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

type Tbl = TP.Table<Rules.State, Rules.Action>;

let spec = Rules.spec();

let TIMEOUT : Int = 60_000_000_000; // 60s
let CLAIM_TIMEOUT : Int = 20_000_000_000; // 20s
let T0 : Int = 1_000_000_000_000;
let CLAIMABLE : Int = T0 + 21_000_000_000; // +21s — past the claim window

func fresh() : Tbl = Table.new<Rules.State, Rules.Action>(TIMEOUT, CLAIM_TIMEOUT, #open, "test", "");

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};
func expectErr<T>(r : TP.Res<T>, msg : Text) = switch (r) {
  case (#ok _) Runtime.trap(msg # " unexpectedly succeeded");
  case (#err _) ();
};

func genOf(t : Tbl, at : Int, session : Text) : Nat = switch (t.status(spec, at, session)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in an active game");
};
func turnOf(t : Tbl, at : Int, session : Text) : Nat = switch (t.status(spec, at, session)) {
  case (#inGame v) v.turn;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};

/// A live game: "black" on #p1, "red" on #p2, both seated at `at`. Black
/// always moves first (turn 0), per `Table.toMove`.
func gameOf(at : Int) : Tbl {
  let t = fresh();
  ignore ok(t.join(spec, at, "black", #p1), "black joins");
  ignore ok(t.join(spec, at, "red", #p2), "red joins");
  t;
};

// A legal opening move for black: the man at (5,0) steps to (4,1) — an
// empty square, forward for p1 (toward row 0), no capture available yet.
func idx(r : Nat, c : Nat) : Nat = r * 8 + c;
let BLACK_OPENING : Rules.Action = #move { from = idx(5, 0); to = idx(4, 1) };
// A legal reply for red: the man at (2,1) steps to (3,0) or (3,2);
// (3,2) stays clear of black's just-moved piece.
let RED_REPLY : Rules.Action = #move { from = idx(2, 1); to = idx(3, 2) };

// ── 1. status reports #alternating mode; black (p1) moves first ────────────
var t = gameOf(T0);
switch (t.status(spec, T0, "black")) {
  case (#inGame v) {
    assert v.mode == #alternating;
    assert v.turn == 0;
    assert v.oppSubmitted;
    assert not v.youSubmitted;
  };
  case (_) Runtime.trap("black should be in a fresh game");
};
Debug.print("1. #alternating status, black to move OK");

// ── 2. red may not move before black ───────────────────────────────────────
t := gameOf(T0);
switch (t.submit(spec, T0, "red", genOf(t, T0, "red"), turnOf(t, T0, "red"), RED_REPLY)) {
  case (#err(#notYourTurn)) {};
  case (_) Runtime.trap("red moving before black must be #notYourTurn");
};
Debug.print("2. off-turn submit rejected OK");

// ── 3. a legal opening resolves immediately and passes the turn ────────────
t := gameOf(T0);
switch (ok(t.submit(spec, T0, "black", genOf(t, T0, "black"), turnOf(t, T0, "black"), BLACK_OPENING), "black's opening")) {
  case (#roundResolved 1) {};
  case (_) Runtime.trap("a single legal move must resolve immediately");
};
ignore ok(t.submit(spec, T0, "red", genOf(t, T0, "red"), turnOf(t, T0, "red"), RED_REPLY), "red's reply");
switch (t.status(spec, T0, "black")) {
  case (#inGame v) {
    assert v.turn == 2;
    assert v.oppSubmitted;
    assert not v.youSubmitted;
  };
  case (_) Runtime.trap("black should be on turn again after both replies");
};
Debug.print("3. opening + reply, turn alternates OK");

// ── 4. claim-win: only the waiting seat may claim, and only once overdue ───
t := gameOf(T0);
ignore ok(t.submit(spec, T0, "black", genOf(t, T0, "black"), turnOf(t, T0, "black"), BLACK_OPENING), "black's opening");
let blackGen = genOf(t, T0, "black");
// red is on turn — red may never claim, no matter how long they wait.
switch (t.claimWin(spec, CLAIMABLE, "red", genOf(t, CLAIMABLE, "red"))) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("the seat on turn must never be able to claimWin");
};
// black is waiting, but the window hasn't elapsed yet at T0.
switch (t.claimWin(spec, T0, "black", blackGen)) {
  case (#err(#notOverdue _)) {};
  case (_) Runtime.trap("claiming before the window elapsed must be #notOverdue");
};
// Once overdue, the waiting seat may claim.
ok(t.claimWin(spec, CLAIMABLE, "black", blackGen), "black claims the overdue win");
switch (t.status(spec, CLAIMABLE, "red")) {
  case (#debrief d) switch (d.end) {
    case (#claimed(#p1)) {};
    case (_) Runtime.trap("expected black's claimed win in the shared debrief");
  };
  case (_) Runtime.trap("red should see black's claimed win");
};
Debug.print("4. claim-win gated to the waiting seat only OK");

Debug.print("ALL CHECKERS ENGINE CHECKS PASSED");
