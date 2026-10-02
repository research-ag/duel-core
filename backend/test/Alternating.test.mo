// Per-operation unit checks for the engine's `#alternating` mode, against
// FakeTurnGame.mo.
import TP "../src/lib";
import Table "../src/table";
import Rules "FakeTurnGame";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

type Tbl = TP.Table<Rules.State, Rules.Action>;

let spec = Rules.spec();

let TIMEOUT : Int = 60_000_000_000; // 60 s
let CLAIM_TIMEOUT : Int = 20_000_000_000; // 20 s
let T0 : Int = 1_000_000_000_000;
let CLAIMABLE : Int = T0 + 21_000_000_000; // +21 s — past the claim window

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

/// A live game: "a" on #p1, "b" on #p2, both seated at `at`. p1 always
/// moves first (turn 0), per `Table.toMove`.
func gameOf(at : Int) : Tbl {
  let t = fresh();
  ignore ok(t.join(spec, at, "a", #p1), "a joins");
  ignore ok(t.join(spec, at, "b", #p2), "b joins");
  t;
};

// ── 1. status reports #alternating mode, and whose turn it is via
//      youSubmitted/oppSubmitted ────────────────────────────────────────────
var t = gameOf(T0);
switch (t.status(spec, T0, "a")) {
  case (#inGame v) {
    assert v.mode == #alternating;
    assert v.turn == 0;
    assert not v.youSubmitted;
    assert v.oppSubmitted;
  };
  case (_) Runtime.trap("a should be in a fresh alternating game");
};
switch (t.status(spec, T0, "b")) {
  case (#inGame v) {
    // b is NOT on turn — the mirror image of a's own view.
    assert v.youSubmitted;
    assert not v.oppSubmitted;
  };
  case (_) Runtime.trap("b should be in a fresh alternating game");
};
Debug.print("1. status reports mode + whose turn OK");

// ── 2. the off-turn seat may not submit ────────────────────────────────────
t := gameOf(T0);
expectErr(t.submit(spec, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #inc), "b submits out of turn");
switch (t.submit(spec, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #inc)) {
  case (#err(#notYourTurn)) {};
  case (_) Runtime.trap("out-of-turn submit must be #notYourTurn specifically");
};
Debug.print("2. off-turn submit rejected with #notYourTurn OK");

// ── 3. validate still gates the on-turn seat's own move ────────────────────
t := gameOf(T0);
expectErr(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #winNow), "a wins with nothing to win with");
switch (ok(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #inc), "a incs")) {
  case (#roundResolved 1) {};
  case (_) Runtime.trap("a single legal move must resolve the round immediately");
};
switch (t.status(spec, T0, "b")) {
  case (#inGame v) {
    assert v.turn == 1;
    assert not v.youSubmitted;
    assert v.oppSubmitted;
  };
  case (_) Runtime.trap("turn should have passed to b");
};
// And now it's b's turn, not a's.
expectErr(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #inc), "a submits again, still out of turn");
Debug.print("3. validate + immediate single-move resolve + turn flip OK");

// ── 4. resolve can end the match outright, same debrief shape as the
//      simultaneous engine ──────────────────────────────────────────────────
t := gameOf(T0);
ignore ok(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #inc), "a incs");
switch (ok(t.submit(spec, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #winNow), "b wins")) {
  case (#gameEnded r) { assert r.verdict == #p2Wins; assert r.turns == 2 };
  case (_) Runtime.trap("b's winNow should end the match crediting p2");
};
switch (t.status(spec, T0, "a")) {
  case (#debrief d) switch (d.end) {
    case (#finished(#p2Wins)) {};
    case (_) Runtime.trap("expected a #finished(#p2Wins) debrief");
  };
  case (_) Runtime.trap("both should land in a shared debrief");
};
Debug.print("4. resolve ending the match OK");

// ── 5. claim-win: only the WAITING seat (not the one on turn) may claim, and
//      only once overdue ────────────────────────────────────────────────────
t := gameOf(T0);
ignore ok(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #inc), "a incs, now it's b's turn");
let gAtT0 = genOf(t, T0, "a");
// b is on turn — b may never claim, regardless of how much time passes.
switch (t.claimWin(spec, CLAIMABLE, "b", genOf(t, CLAIMABLE, "b"))) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("the seat currently on turn must never be able to claimWin");
};
// a is the waiting seat, but the window hasn't elapsed yet at T0.
switch (t.claimWin(spec, T0, "a", gAtT0)) {
  case (#err(#notOverdue _)) {};
  case (_) Runtime.trap("a claiming before the window elapsed must be #notOverdue");
};
// Once overdue, the waiting seat may claim.
ok(t.claimWin(spec, CLAIMABLE, "a", gAtT0), "a claims the overdue win");
switch (t.status(spec, CLAIMABLE, "b")) {
  case (#debrief d) switch (d.end) {
    case (#claimed(#p1)) {};
    case (_) Runtime.trap("expected a's claimed win in the shared debrief");
  };
  case (_) Runtime.trap("b should see a's claimed win");
};
Debug.print("5. claim-win gated to the waiting seat only OK");

// ── 6. the table's variant reaches `init`, for the first game and a rematch ─
t := Table.new<Rules.State, Rules.Action>(TIMEOUT, CLAIM_TIMEOUT, #open, "test", "headStart");
ignore ok(t.join(spec, T0, "a", #p1), "a joins");
ignore ok(t.join(spec, T0, "b", #p2), "b joins");
switch (t.status(spec, T0, "a")) {
  case (#inGame v) assert v.game.count == 1;
  case (_) Runtime.trap("a should be in a headStart game");
};
switch (ok(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #winNow), "a wins at once")) {
  case (#gameEnded _) {};
  case (_) Runtime.trap("headStart makes WINNOW legal on turn 0");
};
ignore ok(t.rematch(spec, T0, "a"), "a requests a rematch");
ignore ok(t.rematch(spec, T0, "b"), "b accepts");
switch (t.status(spec, T0, "b")) {
  case (#inGame v) { assert v.turn == 0; assert v.game.count == 1 };
  case (_) Runtime.trap("the rematch should start from the same variant");
};
Debug.print("6. variant flows into init, rematch included OK");
Debug.print("ALL ALTERNATING ENGINE CHECKS PASSED");
