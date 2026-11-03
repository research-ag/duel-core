// Per-operation unit checks for the engine's `#turnBased` mode, against
// FakeTurnGame.mo.
import TP "../src/lib";
import Rng "../src/rng";
import Table "../src/table";
import Rules "FakeTurnGame";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

type Tbl = TP.Table<Rules.State, Rules.Action, Rules.Options>;

let spec = Rules.spec();
let rng = Rng.new(42);

let TIMEOUT : Int = 60_000_000_000; // 60 s
let CLAIM_TIMEOUT : Int = 20_000_000_000; // 20 s
let T0 : Int = 1_000_000_000_000;
let CLAIMABLE : Int = T0 + 21_000_000_000; // +21 s — past the claim window

func fresh() : Tbl = Table.new<Rules.State, Rules.Action, Rules.Options>(TIMEOUT, CLAIM_TIMEOUT, #open, "test", "");

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
  case (#inGame v) v.step;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};

/// A live game: "a" on #p1, "b" on #p2, both seated at `at`. p1 always
/// moves first (turn 0), per `Table.toMove`.
func gameOf(at : Int) : Tbl {
  let t = fresh();
  ignore ok(t.join(spec, rng, at, "a", #p1), "a joins");
  ignore ok(t.join(spec, rng, at, "b", #p2), "b joins");
  t;
};

// ── 1. status reports #turnBased mode, and whose turn it is via
//      youSubmitted/oppSubmitted ────────────────────────────────────────────
var t = gameOf(T0);
switch (t.status(spec, T0, "a")) {
  case (#inGame v) {
    assert v.mode == #turnBased;
    assert v.step == 0;
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
expectErr(t.submit(spec, rng, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #inc), "b submits out of turn");
switch (t.submit(spec, rng, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #inc)) {
  case (#err(#notYourTurn)) {};
  case (_) Runtime.trap("out-of-turn submit must be #notYourTurn specifically");
};
Debug.print("2. off-turn submit rejected with #notYourTurn OK");

// ── 3. validate still gates the on-turn seat's own move ────────────────────
t := gameOf(T0);
expectErr(t.submit(spec, rng, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #winNow), "a wins with nothing to win with");
switch (ok(t.submit(spec, rng, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #inc), "a incs")) {
  case (#stepped 1) {};
  case (_) Runtime.trap("a single legal move must resolve the round immediately");
};
switch (t.status(spec, T0, "b")) {
  case (#inGame v) {
    assert v.step == 1;
    assert not v.youSubmitted;
    assert v.oppSubmitted;
  };
  case (_) Runtime.trap("turn should have passed to b");
};
// And now it's b's turn, not a's.
expectErr(t.submit(spec, rng, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #inc), "a submits again, still out of turn");
Debug.print("3. validate + immediate single-move resolve + turn flip OK");

// ── 4. resolve can end the match outright, same debrief shape as the
//      simultaneous engine ──────────────────────────────────────────────────
t := gameOf(T0);
ignore ok(t.submit(spec, rng, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #inc), "a incs");
switch (ok(t.submit(spec, rng, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #winNow), "b wins")) {
  case (#gameEnded r) { assert r.verdict == #p2Wins; assert r.steps == 2 };
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
ignore ok(t.submit(spec, rng, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #inc), "a incs, now it's b's turn");
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
t := Table.new<Rules.State, Rules.Action, Rules.Options>(TIMEOUT, CLAIM_TIMEOUT, #open, "test", "headStart");
ignore ok(t.join(spec, rng, T0, "a", #p1), "a joins");
ignore ok(t.join(spec, rng, T0, "b", #p2), "b joins");
switch (t.status(spec, T0, "a")) {
  case (#inGame v) assert v.game.count == 1;
  case (_) Runtime.trap("a should be in a headStart game");
};
switch (ok(t.submit(spec, rng, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #winNow), "a wins at once")) {
  case (#gameEnded _) {};
  case (_) Runtime.trap("headStart makes WINNOW legal on turn 0");
};
ignore ok(t.rematch(spec, rng, T0, "a"), "a requests a rematch");
ignore ok(t.rematch(spec, rng, T0, "b"), "b accepts");
switch (t.status(spec, T0, "b")) {
  case (#inGame v) { assert v.step == 0; assert v.game.count == 1 };
  case (_) Runtime.trap("the rematch should start from the same variant");
};
Debug.print("6. variant flows into init, rematch included OK");
// ── 7. several actions in one call: applied in order, the rest dropped
//      at the first that fails or once the game ends ────────────────────────
func countOf(t : Tbl, at : Int, session : Text) : Nat = switch (t.status(spec, at, session)) {
  case (#inGame v) v.game.count;
  case (_) Runtime.trap("countOf: " # session # " is not in an active game");
};
t := gameOf(T0);
switch (ok(t.submitMoves(spec, rng, T0, "a", genOf(t, T0, "a"), 0, [#again, #again, #inc]), "a's whole turn")) {
  case (#stepped 3) {};
  case (r) Runtime.trap("three applied actions are three steps, got " # debug_show (r));
};
assert countOf(t, T0, "b") == 3;
assert turnOf(t, T0, "b") == 3;
// b's turn ends on its first INC: the second is dropped, not an error.
switch (ok(t.submitMoves(spec, rng, T0, "b", genOf(t, T0, "b"), 3, [#again, #inc, #inc]), "b overshoots its turn")) {
  case (#stepped 5) {};
  case (r) Runtime.trap("the action after the turn passed must be dropped, got " # debug_show (r));
};
assert countOf(t, T0, "a") == 5;
// A failing FIRST action is the call's error, and nothing changes.
switch (t.submitMoves(spec, rng, T0, "b", genOf(t, T0, "b"), 5, [#inc])) {
  case (#err(#notYourTurn)) {};
  case (r) Runtime.trap("first action off turn must be #notYourTurn, got " # debug_show (r));
};
// The batch is stamped with the step BEFORE its first action.
switch (t.submitMoves(spec, rng, T0, "a", genOf(t, T0, "a"), 4, [#inc])) {
  case (#err(#stale)) {};
  case (r) Runtime.trap("an old step must be #stale, got " # debug_show (r));
};
expectErr(t.submitMoves(spec, rng, T0, "a", genOf(t, T0, "a"), 5, []), "an empty batch");
assert turnOf(t, T0, "a") == 5;
Debug.print("7. a batch applies in order and drops what follows a failure OK");

// ── 8. a batch stops once the game ends ────────────────────────────────────
t := gameOf(T0);
expectErr(t.submitMoves(spec, rng, T0, "a", genOf(t, T0, "a"), 0, [#winNow, #inc]), "WINNOW first, at 0");
switch (ok(t.submitMoves(spec, rng, T0, "a", genOf(t, T0, "a"), 0, [#again, #winNow, #inc]), "a wins mid-batch")) {
  case (#gameEnded { verdict = #p1Wins; steps = 2 }) {};
  case (r) Runtime.trap("the game must end on the second action, got " # debug_show (r));
};
Debug.print("8. a batch stops at the verdict OK");

// ── 9. a batch is one step for timing; its last action is the last move ──
func activeOf(t : Tbl) : TP.Active<Rules.State, Rules.Action> = switch (t.phase) {
  case (#active g) g;
  case (_) Runtime.trap("activeOf: no game is running");
};
let SEC : Int = 1_000_000_000;
t := gameOf(T0);
ignore ok(t.submitMoves(spec, rng, T0 + 5 * SEC, "a", genOf(t, T0, "a"), 0, [#again, #again, #inc]), "a's timed turn");
var g9 = activeOf(t);
assert g9.lastStepDurationNs == ?(5 * SEC);
assert g9.stepStartedAt == T0 + 5 * SEC;
assert g9.lastMoveP1 == ?#inc;
ignore ok(t.submitMoves(spec, rng, T0 + 8 * SEC, "b", genOf(t, T0, "b"), 3, [#again, #inc]), "b's timed turn");
g9 := activeOf(t);
assert g9.lastStepDurationNs == ?(3 * SEC);
assert g9.lastMoveP2 == ?#inc;
Debug.print("9. a batch's duration is the whole batch's OK");
Debug.print("ALL ALTERNATING ENGINE CHECKS PASSED");
