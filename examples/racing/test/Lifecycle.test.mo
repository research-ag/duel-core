// Interpreter-run simulation of the full session lifecycle through the
// generic engine with the racing rules plugged in.
import TP "mo:duel-game-core";
import Rng "mo:duel-game-core/rng";
import Table "mo:duel-game-core/table";
import Rules "../src/RacingRules";
import H "RaceTestHelpers";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let rng = Rng.new(42);

let spec = Rules.spec;
let t = Table.new<Rules.State, Rules.Action, Rules.Options>(60_000_000_000, 60_000_000_000, #open, "test", {}); // 60s
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

/// Pulls the `gen` a real client would have to stamp onto a later
/// `submit`/`leave`/`reset` off `session`'s own current view — see
/// `mo:duel-game-core`'s `Table.gen` doc.
func genOf(at : Int, session : Text) : Nat = switch (t.status(spec, at, session)) {
  case (#stagingYou v) v.gen;
  case (#inGame v) v.gen;
  case (#debrief v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in a live phase");
};

/// Same, for the `turn` a `submit` must additionally stamp.
func turnOf(at : Int, session : Text) : Nat = switch (t.status(spec, at, session)) {
  case (#inGame v) v.step;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};

// ── 1. Two players join; a third is refused ────────────────────────────────
ignore ok(t.join(spec, rng, tick(), "alice", #p1), "alice join");
ignore ok(t.join(spec, rng, tick(), "bob", #p2), "bob join");
expectErr(t.join(spec, rng, tick(), "carol", #p1), "carol join during game");
expectErr(t.reset(tick(), "carol", 0), "carol reset during active (idle-gated)"); // outsider path
Debug.print("1. join/lockout OK");

// ── 2. Server-side legality: a wildly-too-far move is rejected ─────────────
expectErr(t.submit(spec, rng, tick(), "alice", genOf(now, "alice"), turnOf(now, "alice"), { l = 999.0; c = 0.0 }), "out-of-envelope move");
Debug.print("2. validate OK");

// ── 3. A round: both sit still, then alice drives across the line ──────────
ignore ok(t.submit(spec, rng, tick(), "alice", genOf(now, "alice"), turnOf(now, "alice"), H.STILL), "a still");
switch (ok(t.submit(spec, rng, tick(), "bob", genOf(now, "bob"), turnOf(now, "bob"), H.STILL), "b still")) {
  case (#stepped _) {};
  case (_) Runtime.trap("expected roundResolved");
};
H.seedP1NearFinish(t); // one legal move from completing the lap — see RaceTestHelpers.mo
ignore ok(t.submit(spec, rng, tick(), "alice", genOf(now, "alice"), turnOf(now, "alice"), H.FINISH_MOVE), "alice finishes");
switch (ok(t.submit(spec, rng, tick(), "bob", genOf(now, "bob"), turnOf(now, "bob"), H.STILL), "b still 2")) {
  case (#gameEnded _) {};
  case (_) Runtime.trap("expected gameEnded (alice completed the lap)");
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
Debug.print("3. round resolution + verdict OK");

// ── 4. Race-free rematch: both request; converge into one fresh game ───────
// Captured BEFORE the rematch: the `gen` alice's FIRST-match debrief
// carried, kept around to replay against the SECOND match in step 4b.
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
Debug.print("4. rematch convergence OK");

// ── 4b. A `leave` delayed across the rematch ───────────────────────────────
switch (t.leave(now, "alice", firstMatchGen)) {
  case (#err(#stale)) {};
  case (_) Runtime.trap("alice's stale leave from the FIRST match must not abort the rematch");
};
switch (t.status(spec, now, "alice")) {
  case (#inGame _) {};
  case (_) Runtime.trap("the rematch must survive the stale leave completely untouched");
};
switch (t.status(spec, now, "bob")) {
  case (#inGame _) {};
  case (_) Runtime.trap("...for bob too — no shared #aborted debrief should appear");
};
Debug.print("4b. a stale cross-match leave is rejected, not replayed OK");

// ── 5. Leave mid-game → BOTH get the special aborted debrief ───────────────
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
switch (t.status(spec, now, "bob")) {
  case (#debrief d) {
    switch (d.end) {
      case (#aborted _) {};
      case (_) Runtime.trap("expected #aborted for bob too");
    };
  };
  case (_) Runtime.trap("bob missing abort debrief");
};
Debug.print("5. shared abort debrief OK");

// ── 6. Idle takeover over an EXPIRED DEBRIEF: no #endedByOther (they saw
//      their debrief already) ───────────────────────────────────────────────
expectErr(t.join(spec, rng, tick(), "carol", #p1), "carol during debrief precedence");
now += 61_000_000_000; // 61s pass
ok(t.reset(now, "carol", 0), "carol reset after idle"); // outsider path
ignore ok(t.join(spec, rng, now, "carol", #p1), "carol joins after idle");
switch (t.status(spec, now, "alice")) {
  case (#endedByOther _) Runtime.trap("alice already saw her debrief - no ghost notice due");
  case (#debrief _) Runtime.trap("stale debrief leaked");
  case (_) {};
};
Debug.print("6. debrief takeover: clean lobby fallback OK");

// ── 7. Idle takeover of an ACTIVE game → #endedByOther until acked ─────────
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
Debug.print("7. active-game takeover: #endedByOther + per-player ack OK");

Debug.print("ALL SIM CHECKS PASSED");
