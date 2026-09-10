// Per-operation unit checks for `Registry` — the multi-table registry
// layered on top of the single-`Table` engine (see `Engine.test.mo`,
// which already covers every per-table primitive `Lobby` itself
// delegates into). This suite drives `createTable`/`listTables`/
// `joinTable` and the routed `submit`/`rematch`/`leave`/`reset`/
// `ackEnded`/`status`, with several tables live at once, on a FRESH
// registry per scenario. Plugged-in rules: FakeGame.mo.
// Run: moc -r --package core <core/src> test/Lobby.test.mo
import Rules "FakeGame";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

import TP "../src/lib";
import Registry "../src/registry";

type Reg = TP.Registry<Rules.State, Rules.Action>;

let spec = Rules.spec();

let TIMEOUT : Int = 60_000_000_000; // 60 s
let T0 : Int = 1_000_000_000_000;
let LATER : Int = T0 + 61_000_000_000; // +61 s — past the timeout

func fresh() : Reg = Registry.new<Rules.State, Rules.Action>(TIMEOUT);

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};
func expectErr<T>(r : TP.Res<T>, msg : Text) = switch (r) {
  case (#ok _) Runtime.trap(msg # " unexpectedly succeeded");
  case (#err _) ();
};

func atTableView(reg : Reg, at : Int, session : Text) : TP.View<Rules.State> = switch (reg.status(at, session)) {
  case (#atTable v) v.view;
  case (#browsing _) Runtime.trap("expected " # session # " to be at a table");
};

/// Pulls the `gen` a real client would have to stamp onto a later
/// `submit`/`leave`/`reset` off `session`'s own current view — see
/// lib.mo's `Table.gen` doc.
func genOf(reg : Reg, at : Int, session : Text) : Nat = switch (atTableView(reg, at, session)) {
  case (#stagingYou v) v.gen;
  case (#inGame v) v.gen;
  case (#debrief v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in a live phase");
};
func turnOf(reg : Reg, at : Int, session : Text) : Nat = switch (atTableView(reg, at, session)) {
  case (#inGame v) v.turn;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};

// ── 1. createTable seats the creator; ids are sequential from 1 ────────────
let reg = fresh();
let id1 = ok(reg.createTable(spec, T0, "a", #p1, #open), "a creates a table");
assert id1 == 1;
switch (reg.status(T0, "a")) {
  case (#atTable v) {
    assert v.id == id1;
    switch (v.view) {
      case (#stagingYou sv) assert sv.seat == #p1;
      case (_) Runtime.trap("a should be staging");
    };
  };
  case (_) Runtime.trap("a should be at a table");
};
let id2 = ok(reg.createTable(spec, T0, "z", #p1, #open), "z creates a second table");
assert id2 == 2;
Debug.print("1. createTable seats the creator, ids are sequential OK");

// ── 2. a session already at a table can't create or join another ──────────
expectErr(reg.createTable(spec, T0, "a", #p2, #open), "a tries to create a second table");
expectErr(reg.joinTable(spec, T0, "a", id2, #p2, null), "a tries to join z's table too");
Debug.print("2. already-at-a-table guard blocks create/join OK");

// ── 3. listTables: open tables with a free seat; protected ones hidden ────
switch (reg.listTables(T0)) {
  case (rows) {
    assert rows.size() == 2; // id1, id2 — both p1-taken/p2-open
    for (r in rows.values()) { assert not r.p1Open; assert r.p2Open };
  };
};
let idProt = ok(reg.createTable(spec, T0, "q", #p1, #code("secret")), "q creates a protected table");
assert reg.listTables(T0).size() == 2; // idProt must not appear
Debug.print("3. listTables shows open tables only, protected ones hidden OK");

// ── 4. joinTable: bad id, bad/missing code, correct code, open needs none ──
switch (reg.joinTable(spec, T0, "b", 9999, #p2, null)) {
  case (#err(#noSuchTable)) {};
  case (_) Runtime.trap("a bogus table id should be #noSuchTable");
};
switch (reg.joinTable(spec, T0, "b", idProt, #p2, null)) {
  case (#err(#badCode)) {};
  case (_) Runtime.trap("no code on a protected table should be #badCode");
};
switch (reg.joinTable(spec, T0, "b", idProt, #p2, ?"wrong")) {
  case (#err(#badCode)) {};
  case (_) Runtime.trap("the wrong code on a protected table should be #badCode");
};
switch (ok(reg.joinTable(spec, T0, "b", idProt, #p2, ?"secret"), "b joins with the right code")) {
  case (#started(#p2)) {};
  case (_) Runtime.trap("the right code should seat b and start the game");
};
switch (ok(reg.joinTable(spec, T0, "z2", id1, #p2, null), "z2 joins the open table with no code")) {
  case (#started(#p2)) {};
  case (_) Runtime.trap("an open table needs no code at all");
};
Debug.print("4. joinTable: #noSuchTable / #badCode / correct code / open needs none OK");

// ── 5. routing: a move on one table never touches another ─────────────────
// id1 now has a(p1)/z2(p2) live; idProt has q(p1)/b(p2) live.
ignore ok(
  reg.submit(spec, T0, "a", genOf(reg, T0, "a"), turnOf(reg, T0, "a"), #gather),
  "a gathers on id1",
);
switch (atTableView(reg, T0, "q")) {
  case (#inGame g) assert not g.oppSubmitted; // idProt untouched by a's move on id1
  case (_) Runtime.trap("q should still be mid-game, unaffected by id1");
};
Debug.print("5. submit routes to the acting session's own table only OK");

// ── 6. leave returns the session to browsing and GCs an empty table ───────
ignore ok(reg.leave(T0, "z", genOf(reg, T0, "z")), "z (alone, staging id2) leaves");
switch (reg.status(T0, "z")) {
  case (#browsing _) {};
  case (_) Runtime.trap("z should be back to browsing");
};
for (r in reg.listTables(T0).values()) { assert r.id != id2 }; // GC'd — id2 is gone
let id3 = ok(reg.createTable(spec, T0, "z", #p1, #open), "z creates a fresh table after leaving");
assert id3 != id2; // ids are never reused, even once GC'd
Debug.print("6. leave returns to browsing and GCs an empty table; ids are never reused OK");

// ── 7. an idle table resurfaces through listTables, in any phase ──────────
// id1 (a vs z2) sits idle past the timeout without anyone visiting it.
var idle1Found = false;
for (r in reg.listTables(LATER).values()) {
  if (r.id == id1) { idle1Found := true; assert r.p1Open; assert r.p2Open };
};
assert idle1Found; // an idle #active table must resurface as open, never stay a ghost
switch (ok(reg.joinTable(spec, LATER, "outsider", id1, #p1, null), "an outsider takes over the idle table")) {
  case (#staged(#p1)) {};
  case (_) Runtime.trap("idle takeover should stage the outsider");
};
switch (atTableView(reg, LATER, "a")) {
  case (#endedByOther) {};
  case (_) Runtime.trap("a (evicted) should see #endedByOther");
};
reg.ackEnded("a");
switch (reg.status(LATER, "a")) {
  case (#browsing _) {};
  case (_) Runtime.trap("acking #endedByOther should return a to browsing");
};
Debug.print("7. idle takeover resurfaces via listTables; ackEnded returns to browsing OK");

// ── 8. a permanently-unacked notice doesn't pin a ghost table forever ─────
// Regression for a real bug: a's/b's game goes idle and nobody ever visits
// to ack the notice sweep records for them (e.g. both closed their tab for
// good) — that alone used to keep the table in the registry forever, even
// once c/d play an entirely separate, cleanly-finished game on the very
// same freed board afterward: it kept resurfacing in `listTables`,
// reporting itself freshly "open" (`waitingSecs == 0`, since an `#empty`
// table's "since" is always `now` — see `openness`'s own doc), on every
// single load, forever.
let reg8 = fresh();
let idG = ok(reg8.createTable(spec, T0, "a", #p1, #open), "a creates a table");
ignore ok(reg8.joinTable(spec, T0, "b", idG, #p2, null), "b joins; game live");
let VANISH = T0 + TIMEOUT + 1_000_000_000; // a/b's own game goes idle
reg8.sweep(VANISH); // the periodic timer frees it with nobody visiting
var ghostSeen = false;
for (r in reg8.listTables(VANISH).values()) { if (r.id == idG) ghostSeen := true };
assert ghostSeen; // freed, but not GC'd — a/b are still owed their notice
// c and d play an entirely separate, cleanly-finished game on the same
// freed board — same id, since ids are only ever handed out fresh.
ignore ok(reg8.joinTable(spec, VANISH, "c", idG, #p1, null), "c joins the freed board");
ignore ok(reg8.joinTable(spec, VANISH, "d", idG, #p2, null), "d joins; game live");
let cGen = genOf(reg8, VANISH, "c");
let dGen = genOf(reg8, VANISH, "d");
ignore ok(reg8.leave(VANISH, "c", cGen), "c forfeits (leave from the live game)");
ignore ok(reg8.leave(VANISH, "c", cGen), "c also acks their own shared debrief");
ignore ok(reg8.leave(VANISH, "d", dGen), "d acks the shared debrief too");
ghostSeen := false;
for (r in reg8.listTables(VANISH).values()) { if (r.id == idG) ghostSeen := true };
assert ghostSeen; // a/b's still-unacked notice blocks GC even after c/d's clean finish
// long after: a/b were never coming back — the notice goes stale and is pruned
let LONG_AFTER = VANISH + TIMEOUT * 10 + 1_000_000_000;
reg8.sweep(LONG_AFTER);
for (r in reg8.listTables(LONG_AFTER).values()) { assert r.id != idG }; // finally GC'd
switch (reg8.status(LONG_AFTER, "a")) {
  case (#browsing _) {}; // the stale notice is gone quietly, not shown forever either
  case (_) Runtime.trap("a's ancient, never-acked notice should have expired quietly");
};
Debug.print("8. a permanently-unacked notice is eventually pruned, unblocking GC OK");

Debug.print("ALL LOBBY CHECKS PASSED");
