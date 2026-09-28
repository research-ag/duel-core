// Rock-paper-scissors rules plugged into the REAL engine (`Table`, not a
// synthetic call to `validate`/`resolve` directly) — focused on what a
// #simultaneous game specifically exercises through it: round resolution
// once both seats submit, and claim-win gated to whichever seat already
// submitted. The engine's own generic #simultaneous mechanics (join,
// staging, rematch, idle takeover, sweep, ...) already have their own
// exhaustive suite in duel-game-core itself (backend/test/Engine.test.mo,
// against a trivial fixture) — this suite is not a second copy of that,
// just confirmation that real rock-paper-scissors rounds flow through the
// same machinery correctly.
// Run: moc -r --package core <core/src> --package duel-game-core
//      <duel-game-core-backend/src> test/Engine.test.mo
import TP "mo:duel-game-core";
import Table "mo:duel-game-core/table";
import Rules "../src/RockPaperScissorsRules";
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

/// A live game: "a" on #p1, "b" on #p2, both seated at `at`.
func gameOf(at : Int) : Tbl {
  let t = fresh();
  ignore ok(t.join(spec, at, "a", #p1), "a joins");
  ignore ok(t.join(spec, at, "b", #p2), "b joins");
  t;
};

// ── 1. status reports #simultaneous mode; neither seat has moved yet ────────
var t = gameOf(T0);
switch (t.status(spec, T0, "a")) {
  case (#inGame v) {
    assert v.mode == #simultaneous;
    assert v.turn == 0;
    assert not v.youSubmitted;
    assert not v.oppSubmitted;
  };
  case (_) Runtime.trap("a should be in a fresh game");
};
Debug.print("1. #simultaneous status, nobody moved yet OK");

// ── 2. one submission is hidden from the opponent, and doesn't resolve
//        the round on its own ──────────────────────────────────────────────
t := gameOf(T0);
switch (ok(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #rock), "a's pick")) {
  case (#waiting) {};
  case (_) Runtime.trap("one submission alone must not resolve the round");
};
switch (t.status(spec, T0, "a")) {
  case (#inGame v) { assert v.youSubmitted; assert not v.oppSubmitted };
  case (_) Runtime.trap("a is in the game");
};
switch (t.status(spec, T0, "b")) {
  case (#inGame v) { assert not v.youSubmitted; assert v.oppSubmitted };
  case (_) Runtime.trap("b sees a has submitted, but not what a picked");
};
Debug.print("2. pending submission hidden from the opponent OK");

// ── 3. a second submission resolves the round; a double-submit is rejected ──
switch (ok(t.submit(spec, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #scissors), "b's pick")) {
  case (#roundResolved 1) {};
  case (_) Runtime.trap("both picks in must resolve round 1 (rock beats scissors)");
};
switch (t.submit(spec, T0, "a", genOf(t, T0, "a"), 0, #rock)) {
  case (#err(#stale)) {};
  case (_) Runtime.trap("resubmitting into the finished round must be #stale");
};
Debug.print("3. round resolution + stale resubmit OK");

// ── 4. claim-win: only the seat that already submitted may claim, and
//        only once overdue ──────────────────────────────────────────────────
t := gameOf(T0);
ignore ok(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #rock), "a submits");
let aGen = genOf(t, T0, "a");
// b hasn't submitted at all — b can never claim, no matter how long b waits.
switch (t.claimWin(spec, CLAIMABLE, "b", genOf(t, CLAIMABLE, "b"))) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("the seat that hasn't submitted must never be able to claimWin");
};
// a submitted, but the window hasn't elapsed yet at T0.
switch (t.claimWin(spec, T0, "a", aGen)) {
  case (#err(#notOverdue _)) {};
  case (_) Runtime.trap("claiming before the window elapsed must be #notOverdue");
};
// Once overdue, the waiting (already-submitted) seat may claim.
ok(t.claimWin(spec, CLAIMABLE, "a", aGen), "a claims the overdue win");
switch (t.status(spec, CLAIMABLE, "b")) {
  case (#debrief d) switch (d.end) {
    case (#claimed(#p1)) {};
    case (_) Runtime.trap("expected a's claimed win in the shared debrief");
  };
  case (_) Runtime.trap("b should see a's claimed win");
};
Debug.print("4. claim-win gated to the already-submitted seat only OK");

// ── 5. leave mid-game produces a shared #aborted debrief ────────────────────
t := gameOf(T0);
ignore ok(t.leave(T0, "a", genOf(t, T0, "a")), "a leaves mid-game");
switch (t.status(spec, T0, "b")) {
  case (#debrief d) switch (d.end) {
    case (#aborted(#p1)) {};
    case (_) Runtime.trap("expected a's #aborted departure");
  };
  case (_) Runtime.trap("b should land in a shared debrief too");
};
Debug.print("5. leave mid-game = shared abort OK");

// ── 6. rematch converges into a fresh game, turn 0 ───────────────────────────
t := gameOf(T0);
ignore ok(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #rock), "a wins round 1");
ignore ok(t.submit(spec, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #scissors), "b");
ignore ok(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #paper), "a wins round 2");
ignore ok(t.submit(spec, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #rock), "b");
ignore ok(t.submit(spec, T0, "a", genOf(t, T0, "a"), turnOf(t, T0, "a"), #scissors), "a wins round 3");
switch (ok(t.submit(spec, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #paper), "b's last pick")) {
  case (#gameEnded r) { assert r.verdict == #p1Wins };
  case (_) Runtime.trap("3 round wins should end the match for a");
};
ignore ok(t.rematch(spec, T0, "a"), "a requests a rematch");
switch (ok(t.rematch(spec, T0, "b"), "b accepts")) {
  case (#started) {};
  case (_) Runtime.trap("b's rematch should complete the pair");
};
switch (t.status(spec, T0, "b")) {
  case (#inGame g) { assert g.turn == 0 };
  case (_) Runtime.trap("b should be in a fresh game");
};
Debug.print("6. first-to-3 finish + rematch OK");

// ── 7. ackEnded is per-player and idempotent ─────────────────────────────────
t := gameOf(T0);
ok(t.reset(T0 + TIMEOUT + 1, "zz", 0), "outsider clears the dead game"); // outsider path
t.ackEnded("a");
t.ackEnded("a"); // idempotent
switch (t.status(spec, T0 + TIMEOUT + 1, "a")) {
  case (#endedByOther) Runtime.trap("a's ack did not clear the notice");
  case (_) {};
};
switch (t.status(spec, T0 + TIMEOUT + 1, "b")) {
  case (#endedByOther) {};
  case (_) Runtime.trap("b's notice must survive a's ack");
};
Debug.print("7. ackEnded scoping OK");

Debug.print("ALL ROCKPAPERSCISSORS ENGINE CHECKS PASSED");
