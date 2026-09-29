// Chopsticks rules plugged into the REAL engine (`Table`, not a synthetic
// call to `validate`/`resolve` directly) — focused on what's specific to
// an #alternating game: turn-order enforcement through `submit`, claim-win
// gated to the waiting seat, and the table's own `variant` reaching
// `init`. The engine's own generic #alternating mechanics already have
// their own exhaustive suite in duel-game-core itself
// (backend/test/Alternating.test.mo).
// Run: moc -r --package core <core/src> --package duel-game-core
//      <duel-game-core-backend/src> test/Engine.test.mo
import TP "mo:duel-game-core";
import Table "mo:duel-game-core/table";
import Rules "../src/ChopsticksRules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

type Tbl = TP.Table<Rules.State, Rules.Action>;

let spec = Rules.spec();

let TIMEOUT : Int = 60_000_000_000; // 60s
let CLAIM_TIMEOUT : Int = 15_000_000_000; // 15s
let T0 : Int = 1_000_000_000_000;
let CLAIMABLE : Int = T0 + 16_000_000_000; // +16s — past the claim window

func fresh(variant : Text) : Tbl = Table.new<Rules.State, Rules.Action>(TIMEOUT, CLAIM_TIMEOUT, #open, "test", variant);

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
func gameOf(t : Tbl, at : Int, session : Text) : Rules.State = switch (t.status(spec, at, session)) {
  case (#inGame v) v.game;
  case (_) Runtime.trap("gameOf: " # session # " is not in an active game");
};

/// A live game: "a" on #p1, "b" on #p2, both seated at `at`. p1 moves
/// first (turn 0), per `Table.toMove`.
func liveGame(at : Int, variant : Text) : Tbl {
  let t = fresh(variant);
  ignore ok(t.join(spec, at, "a", #p1), "a joins");
  ignore ok(t.join(spec, at, "b", #p2), "b joins");
  t;
};

let ATTACK_LL : Rules.Action = #attack { from = #l; to = #l };

// ── 1. status reports #alternating mode; p1 moves first; the table's own
//        variant text reached init ─────────────────────────────────────────
var t = liveGame(T0, "instructables");
switch (t.status(spec, T0, "a")) {
  case (#inGame v) {
    assert v.mode == #alternating;
    assert v.turn == 0;
    assert v.oppSubmitted;
    assert not v.youSubmitted;
    assert v.game.variant == #instructables;
  };
  case (_) Runtime.trap("a should be in a fresh game");
};
assert gameOf(liveGame(T0, ""), T0, "a").variant == #classic;
Debug.print("1. #alternating status, p1 to move, variant flows through OK");

// ── 2. p2 may not move before p1 ───────────────────────────────────────────
t := liveGame(T0, "");
switch (t.submit(spec, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), ATTACK_LL)) {
  case (#err(#notYourTurn)) {};
  case (_) Runtime.trap("p2 moving before p1 must be #notYourTurn");
};
Debug.print("2. off-turn submit rejected OK");

// ── 3. a legal opening resolves immediately and passes the turn; an
//        illegal split is refused with #illegalMove ─────────────────────────
t := liveGame(T0, "");
switch (ok(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), ATTACK_LL), "a's opening")) {
  case (#roundResolved 1) {};
  case (_) Runtime.trap("a single legal attack must resolve immediately");
};
assert gameOf(t, T0, "a").p2 == { l = 2; r = 1 };
ignore ok(t.submit(spec, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #attack { from = #l; to = #r }), "b's reply");
switch (t.status(spec, T0, "a")) {
  case (#inGame v) {
    assert v.turn == 2;
    assert v.game.p1 == { l = 1; r = 3 };
    assert v.oppSubmitted;
    assert not v.youSubmitted;
  };
  case (_) Runtime.trap("a should be on turn again after both replies");
};
switch (t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #split { l = 3; r = 1 })) {
  case (#err(#illegalMove _)) {};
  case (_) Runtime.trap("a pure swap must be refused");
};
Debug.print("3. opening + reply, turn alternates, pure swap rejected OK");

// ── 4. claim-win: only the waiting seat may claim, and only once overdue ────
t := liveGame(T0, "");
ignore ok(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), ATTACK_LL), "a's opening");
let aGen = genOf(t, T0, "a");
switch (t.claimWin(spec, CLAIMABLE, "b", genOf(t, CLAIMABLE, "b"))) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("the seat on turn must never be able to claimWin");
};
switch (t.claimWin(spec, T0, "a", aGen)) {
  case (#err(#notOverdue _)) {};
  case (_) Runtime.trap("claiming before the window elapsed must be #notOverdue");
};
ok(t.claimWin(spec, CLAIMABLE, "a", aGen), "a claims the overdue win");
switch (t.status(spec, CLAIMABLE, "b")) {
  case (#debrief d) switch (d.end) {
    case (#claimed(#p1)) {};
    case (_) Runtime.trap("expected a's claimed win in the shared debrief");
  };
  case (_) Runtime.trap("b should see a's claimed win");
};
Debug.print("4. claim-win gated to the waiting seat only OK");

Debug.print("ALL CHOPSTICKS ENGINE CHECKS PASSED");
