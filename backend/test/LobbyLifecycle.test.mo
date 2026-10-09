// A multi-table narrative: two tables running independently and interleaved
// through `Registry` (join, interleaved rounds, a finish, a rematch, a mid-
// game abort), proving tables never cross-talk.
import Rules "FakeGame";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

import TP "../src/lib";
import Rng "../src/rng";
import Registry "../src/registry";

let spec = Rules.spec();
let rng = Rng.new(42);

// The player's first table, and their view of it or `#browsing`.
func idOf(reg : TP.Registry<Rules.State, Rules.Action, Rules.Options>, p : Text) : TP.TableId {
  let ids = reg.tablesOf(p);
  if (ids.size() == 0) Runtime.trap(p # " is at no table");
  ids[0];
};
func statusOf(reg : TP.Registry<Rules.State, Rules.Action, Rules.Options>, at : Int, p : Text) : {
  #atTable : { id : TP.TableId; view : TP.TableView<Rules.State> };
  #browsing;
} {
  let ids = reg.tablesOf(p);
  if (ids.size() == 0) return #browsing;
  switch (reg.view(spec, at, p, ids[0])) {
    case (?v) #atTable { id = ids[0]; view = v };
    case null #browsing;
  };
};

let reg = Registry.new<Rules.State, Rules.Action, Rules.Options>();
reg.setTimeouts(60_000_000_000, 20_000_000_000); // 60s idle, 20s claim-win
var now : Int = 1_000_000_000_000;
func tick() : Int { now += 1_000_000_000; now }; // +1s

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func atTableView(session : Text) : TP.TableView<Rules.State> = switch (statusOf(reg, now, session)) {
  case (#atTable v) v.view;
  case (#browsing _) Runtime.trap("expected " # session # " to be at a table");
};

/// Pulls the `gen` a real client would have to stamp onto a later
/// `submit`/`leave`/`reset` off `session`'s own current view — see
/// lib.mo's `Table.gen` doc.
func genOf(session : Text) : Nat = switch (atTableView(session)) {
  case (#stagingYou v) v.gen;
  case (#inGame v) v.gen;
  case (#debrief v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in a live phase");
};
func turnOf(session : Text) : Nat = switch (atTableView(session)) {
  case (#inGame v) v.step;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};

// ── 1. two tables created and filled, interleaved ──────────────────────────
let tableA = ok(reg.createTable(spec, rng, tick(), "alice", #p1, #open, ""), "alice opens table A");
let tableB = ok(reg.createTable(spec, rng, tick(), "carol", #p1, #code("friends-only"), ""), "carol opens protected table B");
assert tableA != tableB;
// Both tables are listed, one seat free each — table B flagged protected.
switch (reg.listTables(now)) {
  case (rows) {
    assert rows.size() == 2;
    for (r in rows.values()) {
      assert (r.id == tableA and not r.protected) or (r.id == tableB and r.protected);
    };
  };
};
ignore ok(reg.joinTable(spec, rng, tick(), "bob", tableA, #p2, null), "bob joins table A");
ignore ok(reg.joinTable(spec, rng, tick(), "dave", tableB, #p2, ?"friends-only"), "dave joins table B with the code");
assert reg.listTables(now).size() == 0; // both tables full now
Debug.print("1. two tables created/filled independently, listing reflects both OK");

// ── 2. interleaved rounds: A and B never see each other's moves ────────────
ignore ok(reg.submit(spec, rng, tick(), "alice", idOf(reg, "alice"), genOf("alice"), turnOf("alice"), #gather), "alice gathers on A");
switch (atTableView("carol")) {
  case (#inGame g) assert not g.oppSubmitted; // table B is untouched by A's move
  case (_) Runtime.trap("carol should still be mid-game on B");
};
ignore ok(reg.submit(spec, rng, tick(), "carol", idOf(reg, "carol"), genOf("carol"), turnOf("carol"), #gather), "carol gathers on B");
ignore ok(reg.submit(spec, rng, tick(), "dave", idOf(reg, "dave"), genOf("dave"), turnOf("dave"), #gather), "dave gathers on B — round resolves");
switch (atTableView("carol")) {
  case (#inGame g) assert g.step == 1; // B moved on to round 2
  case (_) Runtime.trap("carol should be on round 2 of B");
};
switch (atTableView("alice")) {
  case (#inGame g) assert g.step == 0; // A untouched by B's own resolution
  case (_) Runtime.trap("alice should still be on round 1 of A");
};
ignore ok(reg.submit(spec, rng, tick(), "bob", idOf(reg, "bob"), genOf("bob"), turnOf("bob"), #gather), "bob gathers on A too — A's round resolves");
Debug.print("2. rounds resolve per table, with zero cross-talk OK");

// ── 3. table A finishes, debriefs, and rematches WHILE B keeps playing ─────
ignore ok(reg.submit(spec, rng, tick(), "alice", idOf(reg, "alice"), genOf("alice"), turnOf("alice"), #attack), "alice attacks on A");
switch (ok(reg.submit(spec, rng, tick(), "bob", idOf(reg, "bob"), genOf("bob"), turnOf("bob"), #gather), "bob doesn't attack — A ends")) {
  case (#gameEnded r) assert r.verdict == #p1Wins;
  case (_) Runtime.trap("A should have ended with alice winning");
};
ignore ok(reg.rematch(spec, rng, tick(), "alice", idOf(reg, "alice")), "alice requests a rematch on A");
ignore ok(reg.rematch(spec, rng, tick(), "bob", idOf(reg, "bob")), "bob accepts — A restarts under the SAME table id");
switch (statusOf(reg, now, "alice")) {
  case (#atTable v) {
    assert v.id == tableA; // the rematch reuses the same table, not a new one
    switch (v.view) {
      case (#inGame g) assert g.step == 0;
      case (_) Runtime.trap("A should be freshly live again");
    };
  };
  case (_) Runtime.trap("alice should be back at table A");
};
// Table B was never touched by any of A's finish/rematch traffic.
switch (atTableView("carol")) {
  case (#inGame g) assert g.step == 1;
  case (_) Runtime.trap("carol should be exactly where table B's own play left her");
};
Debug.print("3. a finish + rematch on A leaves B's own live game completely untouched OK");

// ── 4. table B ends early (a mid-game leave) ───────────────────────────────
ok(reg.leave(tick(), "carol", idOf(reg, "carol"), genOf("carol")), "carol forfeits table B mid-game");
switch (atTableView("carol")) {
  case (#debrief d) switch (d.end) {
    case (#aborted(#p1)) {};
    case (_) Runtime.trap("carol should see her own abort");
  };
  case (_) Runtime.trap("carol's own abort must still show HER the shared debrief, not bounce to browsing");
};
switch (atTableView("dave")) {
  case (#debrief d) switch (d.end) {
    case (#aborted(#p1)) {};
    case (_) Runtime.trap("dave should see carol's abort");
  };
  case (_) Runtime.trap("dave should be in the shared debrief");
};
// Table A, meanwhile, is completely unaffected.
switch (atTableView("alice")) {
  case (#inGame _) {};
  case (_) Runtime.trap("A should still be live, untouched by B's abort");
};
ok(reg.leave(tick(), "carol", idOf(reg, "carol"), genOf("carol")), "carol acks her own debrief");
switch (statusOf(reg, now, "carol")) {
  case (#browsing _) {};
  case (_) Runtime.trap("carol should now be back to browsing");
};
ok(reg.leave(tick(), "dave", idOf(reg, "dave"), genOf("dave")), "dave acks too — table B is now fully quiesced");
switch (statusOf(reg, now, "dave")) {
  case (#browsing _) {};
  case (_) Runtime.trap("dave should now be back to browsing");
};
for (r in reg.listTables(now).values()) { assert r.id != tableB }; // B is gone for good
switch (atTableView("alice")) {
  case (#inGame _) {};
  case (_) Runtime.trap("A should still be live, untouched by B's teardown");
};
Debug.print("4. table B's own mid-game teardown GCs cleanly and never disturbs table A OK");

Debug.print("ALL LOBBY LIFECYCLE CHECKS PASSED");
