// One short session narrative, driven through the REAL engine end to end:
// join, a full match to a decisive finish, rematch, a mid-game leave, and
// idle takeover.
import TP "mo:duel-game-core";
import Rng "mo:duel-game-core/rng";
import Table "mo:duel-game-core/table";
import Rules "../src/RockPaperScissorsRules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let rng = Rng.new(42);

let spec = Rules.spec;
let t = Table.new<Rules.State, Rules.Action, Rules.Options>(60_000_000_000, 15_000_000_000, #open, "test", { variant = #classic; winsNeeded = 3 }); // 60s idle, 15s claim
var now : Int = 1_000_000_000_000;
func tick() : Int { now += 1_000_000_000; now }; // +1s

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};
func expectErr<T>(r : TP.Res<T>, msg : Text) = switch (r) {
  case (#ok _) Runtime.trap(msg # " unexpectedly succeeded");
  case (#err _) ();
};

func genOf(at : Int, session : Text) : Nat = switch (t.status(spec, at, session)) {
  case (#stagingYou v) v.gen;
  case (#inGame v) v.gen;
  case (#debrief v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in a live phase");
};
func turnOf(at : Int, session : Text) : Nat = switch (t.status(spec, at, session)) {
  case (#inGame v) v.step;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};

// ── 1. Two players join; a third is refused ────────────────────────────────
ignore ok(t.join(spec, rng, tick(), "alice", #p1), "alice join");
ignore ok(t.join(spec, rng, tick(), "bob", #p2), "bob join");
expectErr(t.join(spec, rng, tick(), "carol", #p1), "carol join during game");
Debug.print("1. join/lockout OK");

// ── 2. A full match: alice wins 3 rounds to 0 ──────────────────────────────
ignore ok(t.submit(spec, rng, tick(), "alice", genOf(now, "alice"), turnOf(now, "alice"), #rock), "alice r1");
ignore ok(t.submit(spec, rng, tick(), "bob", genOf(now, "bob"), turnOf(now, "bob"), #scissors), "bob r1");
ignore ok(t.submit(spec, rng, tick(), "alice", genOf(now, "alice"), turnOf(now, "alice"), #paper), "alice r2");
ignore ok(t.submit(spec, rng, tick(), "bob", genOf(now, "bob"), turnOf(now, "bob"), #rock), "bob r2");
ignore ok(t.submit(spec, rng, tick(), "alice", genOf(now, "alice"), turnOf(now, "alice"), #scissors), "alice r3");
switch (ok(t.submit(spec, rng, tick(), "bob", genOf(now, "bob"), turnOf(now, "bob"), #paper), "bob r3")) {
  case (#gameEnded r) { assert r.verdict == #p1Wins };
  case (_) Runtime.trap("expected gameEnded, alice at 3 round wins");
};
switch (t.status(spec, now, "alice")) {
  case (#debrief d) {
    switch (d.end) {
      case (#finished(#p1Wins)) {};
      case (_) Runtime.trap("wrong verdict");
    };
  };
  case (_) Runtime.trap("alice not in debrief");
};
Debug.print("2. full match to a decisive finish OK");

// ── 3. Race-free rematch: both request; converge into one fresh game ───────
let firstMatchGen = genOf(now, "alice");
ignore ok(t.rematch(spec, rng, tick(), "alice"), "alice rematch");
switch (ok(t.rematch(spec, rng, tick(), "bob"), "bob rematch")) {
  case (#started) {};
  case (_) Runtime.trap("bob's rematch should complete the pair");
};
switch (t.status(spec, now, "bob")) {
  case (#inGame g) { assert g.step == 0 };
  case (_) Runtime.trap("bob not in fresh game");
};
// A `leave` delayed across the rematch (the transport resends a call
// that threw) must be rejected as #stale, not replayed against
// the new match.
switch (t.leave(now, "alice", firstMatchGen)) {
  case (#err(#stale)) {};
  case (_) Runtime.trap("alice's stale leave from the FIRST match must not abort the rematch");
};
switch (t.status(spec, now, "alice")) {
  case (#inGame _) {};
  case (_) Runtime.trap("the rematch must survive the stale leave completely untouched");
};
Debug.print("3. rematch convergence + stale cross-match leave rejected OK");

// ── 4. Leave mid-game → BOTH get the special aborted debrief ───────────────
ok(t.leave(tick(), "bob", genOf(now, "bob")), "bob leaves");
switch (t.status(spec, now, "alice")) {
  case (#debrief d) {
    switch (d.end) {
      case (#aborted _) {};
      case (_) Runtime.trap("expected #aborted");
    };
  };
  case (_) Runtime.trap("alice missing abort debrief");
};
Debug.print("4. shared abort debrief OK");

// ── 5. Idle takeover over an EXPIRED DEBRIEF: no #endedByOther (they saw
//      their debrief already) ───────────────────────────────────────────────
now += 61_000_000_000; // 61s pass
ok(t.reset(now, "carol", 0), "carol reset after idle"); // outsider path
ignore ok(t.join(spec, rng, now, "carol", #p1), "carol joins after idle");
switch (t.status(spec, now, "alice")) {
  case (#endedByOther _) Runtime.trap("alice already saw her debrief - no ghost notice due");
  case (#debrief _) Runtime.trap("stale debrief leaked");
  case (_) {};
};
Debug.print("5. debrief takeover: clean lobby fallback OK");

// ── 6. Idle takeover of an ACTIVE game → #endedByOther until acked ─────────
ignore ok(t.join(spec, rng, tick(), "dave", #p2), "dave joins carol");
now += 61_000_000_000; // both idle mid-game
ok(t.reset(now, "eve", 0), "eve reset over dead active game"); // outsider path
ignore ok(t.join(spec, rng, now, "eve", #p1), "eve joins after takeover");
switch (t.status(spec, now, "carol")) {
  case (#endedByOther _) {};
  case (_) Runtime.trap("carol should see #endedByOther");
};
t.ackEnded("carol");
switch (t.status(spec, now, "carol")) {
  case (#endedByOther _) Runtime.trap("ack did not clear the notice");
  case (_) {};
};
switch (t.status(spec, now, "dave")) {
  case (#endedByOther _) {};
  case (_) Runtime.trap("dave's notice must survive carol's ack");
};
Debug.print("6. active-game takeover: #endedByOther + per-player ack OK");

Debug.print("ALL ROCKPAPERSCISSORS LIFECYCLE CHECKS PASSED");
