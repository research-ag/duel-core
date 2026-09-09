// Per-operation unit checks for the generic engine. Where Lifecycle.test.mo
// walks ONE long session narrative, this suite drives each entry point in
// isolation on a FRESH table, covering the error variants, the takeover
// gates and the status views that the narrative never reaches.
// Plugged-in rules: FakeGame.mo, a minimal throwaway Spec that exists
// purely to exercise the engine — not a real game.
// Run: moc -r --package core <core/src> test/Engine.test.mo
import TP "../src/lib";
import Rules "FakeGame";
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

/// Pulls the `gen` a real client would have to stamp onto a later
/// `submit`/`leave`/`reset` off `session`'s own current view — see
/// lib.mo's `Table.gen` doc. Only meaningful for a session actually in a
/// live phase; a call made on behalf of an outsider passes a literal `0`
/// instead (see those call sites' own comments for why that's fine).
func genOf(t : Tbl, at : Int, session : Text) : Nat = switch (TP.status(t, at, session)) {
  case (#stagingYou v) v.gen;
  case (#inGame v) v.gen;
  case (#debrief v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in a live phase");
};

/// Same, for the `turn` a `submit` must additionally stamp.
func turnOf(t : Tbl, at : Int, session : Text) : Nat = switch (TP.status(t, at, session)) {
  case (#inGame v) v.turn;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};

/// A live game: "a" on #p1, "b" on #p2, both seated at `at`.
func gameOf(at : Int) : Tbl {
  let t = fresh();
  ignore ok(TP.join(spec, t, at, "a", #p1), "a joins");
  ignore ok(TP.join(spec, t, at, "b", #p2), "b joins");
  t;
};

/// A #finished debrief: "a" wins on turn 2 (both gather, then a attacks an
/// undefended b).
func debriefOf(at : Int) : Tbl {
  let t = gameOf(at);
  ignore ok(TP.submit(spec, t, at, "a", genOf(t, at, "a"), turnOf(t, at, "a"), #gather), "a gathers");
  ignore ok(TP.submit(spec, t, at, "b", genOf(t, at, "b"), turnOf(t, at, "b"), #gather), "b gathers");
  ignore ok(TP.submit(spec, t, at, "a", genOf(t, at, "a"), turnOf(t, at, "a"), #attack), "a attacks");
  ignore ok(TP.submit(spec, t, at, "b", genOf(t, at, "b"), turnOf(t, at, "b"), #gather), "b gathers again");
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
let g6 = genOf(t, T0, "a");
ignore ok(TP.submit(spec, t, T0, "a", g6, 0, #gather), "a's move");
switch (TP.submit(spec, t, T0, "a", g6, 0, #gather)) {
  case (#err(#alreadySubmitted)) {};
  case (_) Runtime.trap("a second move in one round must be rejected");
};
switch (TP.submit(spec, t, T0, "zz", g6, 0, #gather)) {
  case (#err(#notSeated)) {};
  case (_) Runtime.trap("an outsider cannot move");
};
switch (TP.submit(spec, fresh(), T0, "a", 0, 0, #gather)) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("no game is running on an empty board");
};
// A stale `gen`/`turn` (from a match/round that's already moved on) is
// rejected as #stale, not silently replayed against the current one —
// see Table.gen's own doc and lib.mo's guarantee 6.
switch (TP.submit(spec, t, T0, "b", g6 + 1, 0, #gather)) {
  case (#err(#stale)) {};
  case (_) Runtime.trap("a stale gen must be rejected, not replayed");
};
switch (TP.submit(spec, t, T0, "b", g6, 1, #gather)) {
  case (#err(#stale)) {};
  case (_) Runtime.trap("a stale turn must be rejected, not replayed");
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
// b has no resource: the attack is refused and b is still free to act this round.
switch (TP.submit(spec, t, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #attack)) {
  case (#err(#illegalMove _)) {};
  case (_) Runtime.trap("0-resource attack must be refused");
};
switch (TP.status(t, T0, "b")) {
  case (#inGame g) { assert not g.youSubmitted };
  case (_) Runtime.trap("b is still in the game");
};
switch (ok(TP.submit(spec, t, T0, "b", genOf(t, T0, "b"), turnOf(t, T0, "b"), #gather), "b's real move")) {
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
ok(TP.leave(t, T0, "nobody", 0), "leaving an empty board is a no-op"); // gen ignored on #empty
ignore ok(TP.join(spec, t, T0, "a", #p1), "a stages");
// "zz" is not a's staging's session, so this is refused as #notSeated
// regardless of gen (0 here is arbitrary — see genOf's own doc).
expectErr(TP.leave(t, T0, "zz", 0), "outsider leave from staging");
ok(TP.leave(t, T0, "a", genOf(t, T0, "a")), "a leaves its own staging");
switch (TP.status(t, T0, "a")) {
  case (#lobby l) { assert l.p1Open; assert l.p2Open };
  case (_) Runtime.trap("board should be empty again");
};
Debug.print("9. leave from staging / empty OK");

// ── 9b. leave: a stale gen (from a match that's since moved on) is
//         rejected, not silently applied to the CURRENT one ───────────────
t := gameOf(T0);
let g9b = genOf(t, T0, "a");
switch (TP.leave(t, T0, "a", g9b + 1)) {
  case (#err(#stale)) {};
  case (_) Runtime.trap("a stale leave must not abort the live game");
};
switch (TP.status(t, T0, "a")) {
  case (#inGame _) {};
  case (_) Runtime.trap("the live game must survive a stale leave untouched");
};
Debug.print("9b. leave rejects a stale gen OK");

// ── 10. The debrief frees the board only when BOTH players dismiss it ──────
t := debriefOf(T0);
// Captured once, up front: once "a" acks below, `TP.status(t, T0, "a")`
// stops being a live-phase view for a (see the #busy comment further
// down) so `genOf` can no longer read it off a — but the debrief's own
// `gen` doesn't change underneath a repeat/partner dismissal, so this
// same value is still the right one to reuse for every `leave` call in
// this whole section.
let g10 = genOf(t, T0, "a");
expectErr(TP.leave(t, T0, "zz", 0), "outsider leave from debrief");
ok(TP.leave(t, T0, "a", g10), "a dismisses");
switch (TP.status(t, T0, "b")) {
  case (#debrief _) {};
  case (_) Runtime.trap("b has not dismissed yet");
};
// a's OWN status must stop showing the debrief it just dismissed — the
// board itself legitimately stays #debrief (b might still want a
// rematch), but a is no longer a participant of it as far as a's own
// view is concerned. Before this, a kept seeing the exact same #debrief
// screen — with live Rematch/Leave buttons — until b also left, giving
// no sign the click had done anything ("Return to lobby" not working).
switch (TP.status(t, T0, "a")) {
  case (#busy _) {};
  case (_) Runtime.trap("a should stop seeing its own dismissed debrief");
};
// ...and every OTHER debrief-phase operation treats a the same way, not
// just status — a stale rematch/join click can't silently revive a match
// with the old partner after a already said it was done.
expectErr(TP.rematch(spec, t, T0, "a"), "a can't rematch a debrief it already left");
expectErr(TP.join(spec, t, T0, "a", #p1), "a can't rejoin a debrief it already left (still gated by the timeout)");
ok(TP.leave(t, T0, "a", g10), "a dismisses twice");
switch (TP.status(t, T0, "b")) {
  case (#debrief _) {};
  case (_) Runtime.trap("one player acking twice must not free the board");
};
ok(TP.leave(t, T0, "b", g10), "b dismisses");
switch (TP.status(t, T0, "b")) {
  case (#lobby _) {};
  case (_) Runtime.trap("both dismissed — board should be free");
};
Debug.print("10. debrief needs both acks, dismissal idempotent OK");

// ── 11. reset: owner any time, outsider only once idle ────────────────────
t := fresh();
ignore ok(TP.join(spec, t, T0, "a", #p1), "a stages");
switch (TP.reset(t, SOON, "zz", 0)) { // outsider path never consults gen
  case (#err(#notIdle n)) { assert n.secondsLeft == 59 };
  case (_) Runtime.trap("outsider reset must be gated by the timeout");
};
ok(TP.reset(t, SOON, "a", genOf(t, SOON, "a")), "owner resets its own staging");
switch (TP.status(t, SOON, "a")) {
  case (#lobby _) {};
  case (_) Runtime.trap("owner reset should empty the board");
};
ignore ok(TP.join(spec, t, T0, "a", #p1), "a stages again");
ok(TP.reset(t, LATER, "zz", 0), "outsider resets an idle staging"); // outsider path
switch (TP.status(t, LATER, "zz")) {
  case (#lobby _) {};
  case (_) Runtime.trap("idle staging should be resettable");
};
Debug.print("11. reset gating OK");

// ── 11b. reset: a stale gen from a participant is rejected, exactly like
//         a stale `leave` (reset delegates straight to it) ────────────────
t := gameOf(T0);
switch (TP.reset(t, T0, "a", genOf(t, T0, "a") + 1)) {
  case (#err(#stale)) {};
  case (_) Runtime.trap("a stale participant reset must not abort the live game");
};
switch (TP.status(t, T0, "a")) {
  case (#inGame _) {};
  case (_) Runtime.trap("the live game must survive a stale reset untouched");
};
Debug.print("11b. reset rejects a stale gen OK");

// ── 12. A participant's reset mid-game is an abort, not a silent wipe ──────
t := gameOf(T0);
ok(TP.reset(t, T0, "a", genOf(t, T0, "a")), "a resets mid-game");
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
ok(TP.reset(t, LATER, "zz", 0), "outsider clears the dead game"); // outsider path
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

// ── 14b. lastEnded holds independent notices — a second vanished game on
//         the same (now-free) board must not erase an earlier, still-
//         unacked one. Regression for a real bug: `lastEnded` used to be a
//         single slot, so noting the SECOND game silently dropped the
//         first pair's #endedByOther notice if they hadn't acked yet ──────
t := gameOf(T0);
ok(TP.reset(t, LATER, "zz", 0), "outsider clears a's/b's dead game"); // outsider path
let SECOND_START = LATER + 1_000_000_000;      // board is free; a new pair joins
ignore ok(TP.join(spec, t, SECOND_START, "c", #p1), "c joins the freed board");
ignore ok(TP.join(spec, t, SECOND_START, "d", #p2), "d joins");
let SECOND_IDLE = SECOND_START + TIMEOUT + 1_000_000_000; // c/d's own game goes idle
ok(TP.reset(t, SECOND_IDLE, "zz2", 0), "outsider clears c's/d's dead game too"); // outsider path
switch (TP.status(t, SECOND_IDLE, "a")) {
  case (#endedByOther) {};
  case (_) Runtime.trap("a's earlier notice must survive a second vanished game on the same board");
};
switch (TP.status(t, SECOND_IDLE, "c")) {
  case (#endedByOther) {};
  case (_) Runtime.trap("c must see its own, independent notice");
};
TP.ackEnded(t, "a");
switch (TP.status(t, SECOND_IDLE, "a")) {
  case (#endedByOther) Runtime.trap("a's ack did not clear a's own notice");
  case (_) {};
};
switch (TP.status(t, SECOND_IDLE, "c")) {
  case (#endedByOther) {};
  case (_) Runtime.trap("a's ack must not clear c's unrelated notice");
};
TP.ackEnded(t, "c");
TP.ackEnded(t, "d");
switch (TP.status(t, SECOND_IDLE, "c")) {
  case (#endedByOther) Runtime.trap("c's/d's notice should be gone once both acked");
  case (_) {};
};
Debug.print("14b. lastEnded keeps independent per-game notices OK");

// ── 15. The reserved rematch partner may accept via `join`, not just
//        `rematch` — both acceptance paths must work (CLAUDE.md rule 6) ───
t := debriefOf(T0);
ignore ok(TP.rematch(spec, t, T0, "a"), "a requests a rematch");
switch (ok(TP.join(spec, t, SOON, "b", #p2), "b accepts via join")) {
  case (#started(#p2)) {};
  case (_) Runtime.trap("b should be able to accept a rematch invitation via join");
};
switch (TP.status(t, SOON, "b")) {
  case (#inGame g) { assert g.seat == #p2; assert g.turn == 0 };
  case (_) Runtime.trap("b should now be playing");
};
Debug.print("15. reserved partner accepts via join OK");

// ── 16. An outsider's `join` during a live (unexpired) debrief is
//        refused with a takeover countdown, not silently allowed ──────────
t := debriefOf(T0);
switch (TP.join(spec, t, SOON, "zz", #p1)) {
  case (#err(#notIdle n)) { assert n.secondsLeft == 59 };
  case (_) Runtime.trap("an outsider must not hijack a fresh debrief");
};
Debug.print("16. outsider join during live debrief: #notIdle OK");

// ── 17. reset() during a debrief: a participant's reset is ack-by-another-
//        name (delegates to leave); an outsider is gated by the idle
//        timeout like every other phase ────────────────────────────────────
t := debriefOf(T0);
switch (TP.reset(t, T0, "zz", 0)) { // outsider path never consults gen
  case (#err(#notIdle n)) { assert n.secondsLeft == 60 };
  case (_) Runtime.trap("outsider reset of a fresh debrief must be gated");
};
ok(TP.reset(t, T0, "a", genOf(t, T0, "a")), "a resets (= acks) its own debrief");
switch (TP.status(t, T0, "b")) {
  case (#debrief _) {};
  case (_) Runtime.trap("b has not acked yet; debrief must still stand");
};
ok(TP.reset(t, T0, "b", genOf(t, T0, "b")), "b resets (= acks) its own debrief too");
switch (TP.status(t, T0, "b")) {
  case (#lobby _) {};
  case (_) Runtime.trap("both acked via reset — board should be free");
};
Debug.print("17. debrief reset delegates to leave-semantics OK");

// ── 18. sweep: frees an idle board with no visitor, on every phase ─────────
// #empty: a no-op.
t := fresh();
TP.sweep(t, T0);
switch (TP.status(t, T0, "zz")) {
  case (#lobby _) {};
  case (_) Runtime.trap("sweeping an empty board must stay a no-op");
};

// #staging: untouched before the timeout, freed after.
t := fresh();
ignore ok(TP.join(spec, t, T0, "a", #p1), "a stages");
TP.sweep(t, SOON);
switch (TP.status(t, SOON, "a")) {
  case (#stagingYou _) {};
  case (_) Runtime.trap("a fresh staging must survive a sweep");
};
TP.sweep(t, LATER);
switch (TP.status(t, LATER, "a")) {
  case (#lobby l) { assert l.p1Open; assert l.p2Open };
  case (_) Runtime.trap("an idle staging must be swept away");
};
Debug.print("18a. sweep on #staging OK");

// #active: untouched before the timeout; after it, freed with
// #endedByOther for BOTH former players — nobody needs to visit the
// board to learn their game is over, unlike outsider takeover.
t := gameOf(T0);
TP.sweep(t, SOON);
switch (TP.status(t, SOON, "a")) {
  case (#inGame _) {};
  case (_) Runtime.trap("a live game must survive a sweep");
};
TP.sweep(t, LATER);
switch (TP.status(t, LATER, "a")) {
  case (#endedByOther) {};
  case (_) Runtime.trap("a stalled game must be swept into #endedByOther for a");
};
switch (TP.status(t, LATER, "b")) {
  case (#endedByOther) {};
  case (_) Runtime.trap("...and for b too, with no visitor required");
};
switch (TP.status(t, LATER, "zz")) {
  case (#lobby l) { assert l.p1Open; assert l.p2Open };
  case (_) Runtime.trap("an outsider should see the board free after a sweep");
};
Debug.print("18b. sweep on #active OK");

// #debrief: untouched before the timeout; after it, freed, and both
// participants are pre-acked (they already saw their debrief) — same
// asymmetry an outsider's join/reset already applies to an expired
// debrief (see CLAUDE.md's architecture rule 7): unlike a stalled #active
// game (18b, fresh #endedByOther — nobody has seen anything yet), a
// swept debrief goes straight to #lobby, since both players already
// saw their result.
t := debriefOf(T0);
TP.sweep(t, SOON);
switch (TP.status(t, SOON, "a")) {
  case (#debrief _) {};
  case (_) Runtime.trap("a fresh debrief must survive a sweep");
};
TP.sweep(t, LATER);
switch (TP.status(t, LATER, "a")) {
  case (#lobby _) {};
  case (_) Runtime.trap("a swept, already-seen debrief should go straight to #lobby");
};
switch (TP.status(t, LATER, "b")) {
  case (#lobby _) {};
  case (_) Runtime.trap("...and for b too, with no visitor required");
};
switch (ok(TP.join(spec, t, LATER, "a", #p1), "a re-joins after the sweep")) {
  case (#staged(#p1)) {};
  case (_) Runtime.trap("a should be a fresh outsider, not still #notSeated-gated");
};
Debug.print("18c. sweep on #debrief OK");

// ── 19. The concrete replay scenario `gen`-binding exists to close: a's
//         `leave` from the FIRST match's debrief is delayed (e.g. a
//         client-side resend of a call whose original attempt secretly
//         already landed — see gateway-client.ts's `_queueResend` doc) and
//         only reaches the engine AFTER a and b have already rematched and
//         started a brand-new game. Session identity alone can't tell the
//         two matches apart (same "a"/"b"); only `gen` can — the stale
//         `leave` must be rejected, and the new game must survive
//         untouched, instead of getting silently aborted out from under
//         both players ────────────────────────────────────────────────────
t := debriefOf(T0);
let staleLeaveGen = genOf(t, T0, "a"); // captured as of the FIRST match's debrief
ignore ok(TP.rematch(spec, t, T0, "a"), "a requests a rematch");
ignore ok(TP.join(spec, t, T0, "b", #p2), "b accepts — a brand-new match starts");
switch (TP.status(t, T0, "a")) {
  case (#inGame _) {};
  case (_) Runtime.trap("the rematch should be live");
};
switch (TP.leave(t, T0, "a", staleLeaveGen)) {
  case (#err(#stale)) {};
  case (_) Runtime.trap("a's stale leave from the OLD match must not abort the NEW one");
};
switch (TP.status(t, T0, "a")) {
  case (#inGame _) {};
  case (_) Runtime.trap("the rematch must survive the stale leave completely untouched");
};
switch (TP.status(t, T0, "b")) {
  case (#inGame _) {};
  case (_) Runtime.trap("...for b too — no shared #aborted debrief should appear");
};
Debug.print("19. a stale cross-match leave is rejected, not replayed OK");

Debug.print("ALL ENGINE CHECKS PASSED");
