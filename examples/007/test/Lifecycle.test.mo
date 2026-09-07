// Interpreter-run simulation of the full session lifecycle through the
// generic engine with the 007 rules plugged in.
// Run: moc -r --package core <core/src> --package duel-game-core <backend/src> test/Lifecycle.test.mo
import TP "mo:duel-game-core";
import Rules "../src/Duel007Rules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let spec = Rules.spec();
let t = TP.create<Rules.State, Rules.Action>(60_000_000_000); // 60s
var now : Int = 1_000_000_000_000;
func tick() : Int { now += 1_000_000_000; now }; // +1s

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show(e));
};
func expectErr<T>(r : TP.Res<T>, msg : Text) = switch (r) {
  case (#ok _) Runtime.trap(msg # " unexpectedly succeeded");
  case (#err _) ();
};

// ── 1. Two players join; a third is refused ────────────────────────────────
ignore ok(TP.join(spec, t, tick(), "alice", #p1), "alice join");
ignore ok(TP.join(spec, t, tick(), "bob", #p2), "bob join");
expectErr(TP.join(spec, t, tick(), "carol", #p1), "carol join during game");
expectErr(TP.reset(t, tick(), "carol"), "carol reset during active (idle-gated)");
Debug.print("1. join/lockout OK");

// ── 2. Server-side legality: 0-ammo shoot rejected ─────────────────────────
expectErr(TP.submit(spec, t, tick(), "alice", #shoot), "0-ammo shoot");
Debug.print("2. validate OK: " );

// ── 3. A round: both load, then alice shoots bob (no defense) ──────────────
ignore ok(TP.submit(spec, t, tick(), "alice", #load), "a load");
switch (ok(TP.submit(spec, t, tick(), "bob", #load), "b load")) {
  case (#roundResolved _) {};
  case (_) Runtime.trap("expected roundResolved");
};
ignore ok(TP.submit(spec, t, tick(), "alice", #shoot), "a shoot");
switch (ok(TP.submit(spec, t, tick(), "bob", #load), "b load 2")) {
  case (#gameEnded _) {};
  case (_) Runtime.trap("expected gameEnded (bob had no defense)");
};
switch (TP.status(t, now, "alice")) {
  case (#debrief d) {
    switch (d.end) { case (#finished (#p1Wins)) {}; case (_) Runtime.trap("wrong verdict") };
  };
  case (_) Runtime.trap("alice not in debrief");
};
Debug.print("3. round resolution + verdict OK");

// ── 4. Race-free rematch: both request; converge into one fresh game ───────
ignore ok(TP.rematch(spec, t, tick(), "alice"), "alice rematch");
switch (ok(TP.rematch(spec, t, tick(), "bob"), "bob rematch")) {
  case (#started) {};
  case (_) Runtime.trap("bob's rematch should complete the pair");
};
switch (TP.status(t, now, "bob")) {
  case (#inGame g) { assert g.turn == 0 };
  case (_) Runtime.trap("bob not in fresh game");
};
Debug.print("4. rematch convergence OK");

// ── 5. Leave mid-game → BOTH get the special aborted debrief ───────────────
ignore ok(TP.leave(t, tick(), "bob"), "bob leaves");
switch (TP.status(t, now, "alice")) {
  case (#debrief d) {
    switch (d.end) { case (#aborted _) {}; case (_) Runtime.trap("expected #aborted") };
  };
  case (_) Runtime.trap("alice missing abort debrief");
};
switch (TP.status(t, now, "bob")) {
  case (#debrief d) {
    switch (d.end) { case (#aborted _) {}; case (_) Runtime.trap("expected #aborted for bob too") };
  };
  case (_) Runtime.trap("bob missing abort debrief");
};
Debug.print("5. shared abort debrief OK");

// ── 6. Idle takeover over an EXPIRED DEBRIEF: no #endedByOther (they saw
//       their debrief already) — they just fall back to the lobby ──────────
expectErr(TP.join(spec, t, tick(), "carol", #p1), "carol during debrief precedence");
now += 61_000_000_000; // 61s pass
ignore ok(TP.reset(t, now, "carol"), "carol reset after idle");
ignore ok(TP.join(spec, t, now, "carol", #p1), "carol joins after idle");
switch (TP.status(t, now, "alice")) {
  case (#endedByOther _) Runtime.trap("alice already saw her debrief - no ghost notice due");
  case (#debrief _) Runtime.trap("stale debrief leaked");
  case (_) {};
};
Debug.print("6. debrief takeover: clean lobby fallback OK");

// ── 7. Idle takeover of an ACTIVE game → #endedByOther until acked ─────────
ignore ok(TP.join(spec, t, tick(), "dave", #p2), "dave joins carol");
now += 61_000_000_000; // both idle mid-game
ignore ok(TP.reset(t, now, "eve"), "eve reset over dead active game");
ignore ok(TP.join(spec, t, now, "eve", #p1), "eve joins after takeover");
switch (TP.status(t, now, "carol")) {
  case (#endedByOther _) {};
  case (_) Runtime.trap("carol should see #endedByOther");
};
TP.ackEnded(t, "carol");
switch (TP.status(t, now, "carol")) {
  case (#endedByOther _) Runtime.trap("ack did not clear the notice");
  case (_) {};
};
switch (TP.status(t, now, "dave")) {
  case (#endedByOther _) {};
  case (_) Runtime.trap("dave's notice must survive carol's ack");
};
Debug.print("7. active-game takeover: #endedByOther + per-player ack OK");

Debug.print("ALL SIM CHECKS PASSED");
