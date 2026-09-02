// Per-operation unit checks for the generic engine. Where Lifecycle.test.mo
// walks ONE long session narrative, this suite drives each entry point in
// isolation on a FRESH table, covering the error variants, the takeover
// gates and the status views that the narrative never reaches.
// Run: moc -r --package core <core/src> --package duel-game-core <backend/src> test/Engine.test.mo
import TP "mo:duel-game-core";
import Rules "../src/RacingRules";
import H "RaceTestHelpers";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

type Tbl = TP.Table<Rules.State, Rules.Action>;

let spec = Rules.spec();

let TIMEOUT : Int = 60_000_000_000;    // 60 s
let T0 : Int = 1_000_000_000_000;
let SOON : Int = T0 + 1_000_000_000;   // +1 s — still fresh
let LATER : Int = T0 + 61_000_000_000; // +61 s — past the timeout

func fresh() : Tbl = TP.create<Rules.State, Rules.Action>(TIMEOUT);

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show(e));
};
func expectErr<T>(r : TP.Res<T>, msg : Text) = switch (r) {
  case (#ok _) Runtime.trap(msg # " unexpectedly succeeded");
  case (#err _) ();
};

/// A live game: "a" on #p1, "b" on #p2, both seated at `at`.
func gameOf(at : Int) : Tbl {
  let t = fresh();
  ignore ok(TP.join(spec, t, at, "a", #p1), "a joins");
  ignore ok(TP.join(spec, t, at, "b", #p2), "b joins");
  t;
};

/// A #finished debrief: "a" wins by completing its lap. Rather than
/// simulating a whole realistic race, this seeds the live table with a car
/// one legal move from the finish line and submits that one real move —
/// see RaceTestHelpers.mo.
func debriefOf(at : Int) : Tbl {
  let t = gameOf(at);
  H.seedP1NearFinish(t);
  ignore ok(TP.submit(spec, t, at, "a", H.FINISH_MOVE), "a finishes");
  ignore ok(TP.submit(spec, t, at, "b", H.STILL), "b sits still");
  t;
};

// ── 1. otherSeat is an involution ──────────────────────────────────────────
assert TP.otherSeat(#p1) == #p2;
assert TP.otherSeat(#p2) == #p1;
Debug.print("1. otherSeat OK");

// ── 2. join on a staging: idempotent re-click, then a seat switch ──────────
var t = fresh();
ignore ok(TP.join(spec, t, T0, "a", #p1), "a stages");
switch (ok(TP.join(spec, t, SOON, "a", #p1), "a re-clicks")) {
  case (#staged(#p1)) {};
  case (_) Runtime.trap("re-click must be idempotent, not a new match");
};
switch (ok(TP.join(spec, t, SOON, "a", #p2), "a switches seat")) {
  case (#staged(#p2)) {};
  case (_) Runtime.trap("switching seats while alone must be allowed");
};
switch (TP.status(t, SOON, "a")) {
  case (#stagingYou v) {
    assert v.seat == #p2;
    assert not v.reservedForPartner;
    // Switching seats re-stamps `since = now` (see lib.mo's join, the
    // seat-switch branch) — so even though the ORIGINAL join was at T0,
    // the clock restarted at SOON when "a" switched to p2, and checking
    // at that same instant sees the full 60s, not 59.
    assert v.secondsUntilReclaimable == 60;
  };
  case (_) Runtime.trap("a should still be staging");
};
Debug.print("2. join idempotence + seat switch OK");

// ── 3. A held seat is #seatTaken until it goes idle, then evictable ────────
t := fresh();
ignore ok(TP.join(spec, t, T0, "a", #p1), "a stages");
switch (TP.join(spec, t, SOON, "b", #p1)) {
  case (#err(#seatTaken)) {};
  case (_) Runtime.trap("a fresh seat must not be stealable");
};
// Once expired but before anyone actually evicts it, "a" still sees their
// OWN #stagingYou (status()'s own-occupant branch never checks expiry) —
// secondsUntilReclaimable clamps to 0 rather than going negative, which is
// what a host's UI uses to switch from a quiet wait into an active warning
// (see frontend/render.js's renderReclaimWarning).
switch (TP.status(t, LATER, "a")) {
  case (#stagingYou v) { assert v.secondsUntilReclaimable == 0 };
  case (_) Runtime.trap("a should still see their own staging until evicted");
};
switch (ok(TP.join(spec, t, LATER, "b", #p1), "b evicts the squatter")) {
  case (#staged(#p1)) {};
  case (_) Runtime.trap("an idle squatter must be evictable");
};
switch (TP.status(t, LATER, "a")) {
  case (#stagingYou _) Runtime.trap("evicted player still holds the seat");
  case (#lobby l) { assert not l.p1Open; assert l.p2Open };
  case (_) Runtime.trap("evicted player should fall back to the lobby");
};
Debug.print("3. seat squat: #seatTaken then eviction OK");

// ── 4. A rematch reservation blocks outsiders — until it expires ───────────
t := debriefOf(T0);
ignore ok(TP.rematch(spec, t, T0, "a"), "a requests a rematch");
switch (TP.join(spec, t, SOON, "c", #p2)) {
  case (#err(#reserved r)) { assert r.secondsLeft == 59 };
  case (_) Runtime.trap("the open seat is reserved for b");
};
// The reserved partner sees the invitation; an outsider only sees #busy.
switch (TP.status(t, SOON, "b")) {
  case (#awaitingRematch r) { assert r.openSeat == #p2 };
  case (_) Runtime.trap("b should be invited to the open seat");
};
switch (TP.status(t, SOON, "c")) {
  case (#busy v) { assert v.secondsUntilTakeover == 59 };
  case (_) Runtime.trap("outsider should see #busy during a reservation");
};
// Once the reservation goes stale the outsider may take the seat.
switch (ok(TP.join(spec, t, LATER, "c", #p2), "c takes the stale seat")) {
  case (#started(#p2)) {};
  case (_) Runtime.trap("an expired reservation must not block forever");
};
switch (TP.status(t, LATER, "a")) {
  case (#inGame g) { assert g.seat == #p1; assert g.turn == 0 };
  case (_) Runtime.trap("a should now be playing c");
};
Debug.print("4. reservation: #reserved / #awaitingRematch / expiry OK");

// ── 5. A veteran may rematch onto the OTHER seat; seats really swap ────────
t := debriefOf(T0);
switch (ok(TP.join(spec, t, T0, "a", #p2), "a rematches on p2")) {
  case (#staged(#p2)) {};
  case (_) Runtime.trap("a veteran may pick a different seat");
};
switch (TP.status(t, T0, "a")) {
  case (#stagingYou v) {
    assert v.seat == #p2;
    assert v.reservedForPartner;
    // staged and checked at the same instant — the full timeout is left.
    assert v.secondsUntilReclaimable == 60;
  };
  case (_) Runtime.trap("a's rematch staging should reserve b's seat");
};
switch (ok(TP.join(spec, t, T0, "b", #p1), "b takes the swapped seat")) {
  case (#started(#p1)) {};
  case (_) Runtime.trap("b completes the pair");
};
switch (TP.status(t, T0, "b")) {
  case (#inGame g) { assert g.seat == #p1; assert g.turn == 0 };
  case (_) Runtime.trap("b should hold p1 after the swap");
};
Debug.print("5. rematch with seat swap OK");

// ── 6. submit: double-submit, outsiders, empty board ───────────────────────
t := gameOf(T0);
ignore ok(TP.submit(spec, t, T0, "a", H.STILL), "a's move");
switch (TP.submit(spec, t, T0, "a", H.STILL)) {
  case (#err(#alreadySubmitted)) {};
  case (_) Runtime.trap("a second move in one round must be rejected");
};
switch (TP.submit(spec, t, T0, "zz", H.STILL)) {
  case (#err(#notSeated)) {};
  case (_) Runtime.trap("an outsider cannot move");
};
switch (TP.submit(spec, fresh(), T0, "a", H.STILL)) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("no game is running on an empty board");
};
Debug.print("6. submit rejections OK");

// ── 7. Pending moves stay hidden; a rejected move does not burn the turn ───
switch (TP.status(t, T0, "a")) {
  case (#inGame g) { assert g.youSubmitted; assert not g.oppSubmitted };
  case (_) Runtime.trap("a is in the game");
};
switch (TP.status(t, T0, "b")) {
  case (#inGame g) { assert not g.youSubmitted; assert g.oppSubmitted };
  case (_) Runtime.trap("b is in the game");
};
// A move far outside the reachable arc is refused; b is still free to act.
switch (TP.submit(spec, t, T0, "b", { l = 999.0; c = 0.0 })) {
  case (#err(#illegalMove _)) {};
  case (_) Runtime.trap("an out-of-envelope move must be refused");
};
switch (TP.status(t, T0, "b")) {
  case (#inGame g) { assert not g.youSubmitted };
  case (_) Runtime.trap("b is still in the game");
};
switch (ok(TP.submit(spec, t, T0, "b", H.STILL), "b's real move")) {
  case (#roundResolved 1) {};
  case (_) Runtime.trap("a refused move must not consume the round");
};
Debug.print("7. hidden pendings + non-consuming rejection OK");

// ── 8. An outsider watching a live game sees a takeover countdown ──────────
t := gameOf(T0);
switch (TP.status(t, SOON, "zz")) {
  case (#busy v) { assert v.secondsUntilTakeover == 59 };
  case (_) Runtime.trap("outsider should see #busy over a live game");
};
switch (TP.status(t, LATER, "zz")) {
  case (#lobby l) { assert l.resetAvailable };
  case (_) Runtime.trap("a dead game should offer a reset");
};
Debug.print("8. busy countdown → reset offer OK");

// ── 9. leave: own staging empties the board; outsiders are refused ─────────
t := fresh();
ok(TP.leave(t, T0, "nobody"), "leaving an empty board is a no-op");
ignore ok(TP.join(spec, t, T0, "a", #p1), "a stages");
expectErr(TP.leave(t, T0, "zz"), "outsider leave from staging");
ok(TP.leave(t, T0, "a"), "a leaves its own staging");
switch (TP.status(t, T0, "a")) {
  case (#lobby l) { assert l.p1Open; assert l.p2Open };
  case (_) Runtime.trap("board should be empty again");
};
Debug.print("9. leave from staging / empty OK");

// ── 10. The debrief frees the board only when BOTH players dismiss it ──────
t := debriefOf(T0);
expectErr(TP.leave(t, T0, "zz"), "outsider leave from debrief");
ok(TP.leave(t, T0, "a"), "a dismisses");
switch (TP.status(t, T0, "b")) {
  case (#debrief _) {};
  case (_) Runtime.trap("b has not dismissed yet");
};
ok(TP.leave(t, T0, "a"), "a dismisses twice");
switch (TP.status(t, T0, "b")) {
  case (#debrief _) {};
  case (_) Runtime.trap("one player acking twice must not free the board");
};
ok(TP.leave(t, T0, "b"), "b dismisses");
switch (TP.status(t, T0, "b")) {
  case (#lobby _) {};
  case (_) Runtime.trap("both dismissed — board should be free");
};
Debug.print("10. debrief needs both acks, dismissal idempotent OK");

// ── 11. reset: owner any time, outsider only once idle ────────────────────
t := fresh();
ignore ok(TP.join(spec, t, T0, "a", #p1), "a stages");
switch (TP.reset(t, SOON, "zz")) {
  case (#err(#notIdle n)) { assert n.secondsLeft == 59 };
  case (_) Runtime.trap("outsider reset must be gated by the timeout");
};
ok(TP.reset(t, SOON, "a"), "owner resets its own staging");
switch (TP.status(t, SOON, "a")) {
  case (#lobby _) {};
  case (_) Runtime.trap("owner reset should empty the board");
};
ignore ok(TP.join(spec, t, T0, "a", #p1), "a stages again");
ok(TP.reset(t, LATER, "zz"), "outsider resets an idle staging");
switch (TP.status(t, LATER, "zz")) {
  case (#lobby _) {};
  case (_) Runtime.trap("idle staging should be resettable");
};
Debug.print("11. reset gating OK");

// ── 12. A participant's reset mid-game is an abort, not a silent wipe ──────
t := gameOf(T0);
ok(TP.reset(t, T0, "a"), "a resets mid-game");
switch (TP.status(t, T0, "b")) {
  case (#debrief d) {
    switch (d.end) {
      case (#aborted(#p1)) {};
      case (_) Runtime.trap("b should be told a (p1) walked out");
    };
  };
  case (_) Runtime.trap("a participant reset must produce a shared debrief");
};
Debug.print("12. participant reset = shared abort OK");

// ── 13. rematch is refused from every phase that is not a debrief ──────────
switch (TP.rematch(spec, fresh(), T0, "a")) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("nothing to rematch on an empty board");
};
t := debriefOf(T0);
switch (TP.rematch(spec, t, T0, "zz")) {
  case (#err(#notSeated)) {};
  case (_) Runtime.trap("an outsider cannot rematch someone else's game");
};
ignore ok(TP.rematch(spec, t, T0, "a"), "a stages a rematch");
switch (ok(TP.rematch(spec, t, SOON, "a"), "a clicks rematch again")) {
  case (#awaitingPartner) {};
  case (_) Runtime.trap("a repeated rematch click must be idempotent");
};
switch (TP.rematch(spec, t, SOON, "zz")) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("an outsider cannot hijack a staged rematch");
};
t := gameOf(T0);
switch (TP.rematch(spec, t, T0, "a")) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("cannot rematch a game that is still running");
};
switch (TP.rematch(spec, t, T0, "zz")) {
  case (#err(#notSeated)) {};
  case (_) Runtime.trap("an outsider is not seated in the running game");
};
Debug.print("13. rematch phase guards OK");

// ── 14. ackEnded: per-player, idempotent, and inert for strangers ──────────
t := gameOf(T0);
ok(TP.reset(t, LATER, "zz"), "outsider clears the dead game");
TP.ackEnded(t, "stranger"); // not a participant — must change nothing
switch (TP.status(t, LATER, "a")) {
  case (#endedByOther) {};
  case (_) Runtime.trap("a's notice must survive a stranger's ack");
};
TP.ackEnded(t, "a");
TP.ackEnded(t, "a"); // idempotent
switch (TP.status(t, LATER, "a")) {
  case (#endedByOther) Runtime.trap("a's ack did not clear the notice");
  case (_) {};
};
switch (TP.status(t, LATER, "b")) {
  case (#endedByOther) {};
  case (_) Runtime.trap("b's notice must survive a's ack");
};
TP.ackEnded(fresh(), "a"); // no game ever ended — must not trap
Debug.print("14. ackEnded scoping OK");

Debug.print("ALL ENGINE CHECKS PASSED");
