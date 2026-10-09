// Per-operation unit checks for `Registry`, with several tables live at once.
import Rules "FakeGame";
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Runtime "mo:core/Runtime";

import TP "../src/lib";
import Registry "../src/registry";

type Reg = TP.Registry<Rules.State, Rules.Action>;

let spec = Rules.spec();

let TIMEOUT : Int = 60_000_000_000; // 60 s
let CLAIM_TIMEOUT : Int = 20_000_000_000; // 20 s
let T0 : Int = 1_000_000_000_000;
let LATER : Int = T0 + 61_000_000_000; // +61 s — past the timeout
let CLAIMABLE : Int = T0 + 21_000_000_000; // +21 s — past the claim window

let nobody = func(_ : Text) : Bool = false;

func fresh() : Reg {
  let r = Registry.new<Rules.State, Rules.Action>();
  r.setTimeouts(TIMEOUT, CLAIM_TIMEOUT);
  r;
};

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};
func expectErr<T>(r : TP.Res<T>, msg : Text) = switch (r) {
  case (#ok _) Runtime.trap(msg # " unexpectedly succeeded");
  case (#err _) ();
};

// The player's first table, and their view of it or `#browsing`.
func idOf(reg : Reg, p : Text) : TP.TableId {
  let ids = reg.tablesOf(p);
  if (ids.size() == 0) Runtime.trap(p # " is at no table");
  ids[0];
};
func statusOf(reg : Reg, at : Int, p : Text) : {
  #atTable : { id : TP.TableId; view : TP.View<Rules.State> };
  #browsing;
} {
  let ids = reg.tablesOf(p);
  if (ids.size() == 0) return #browsing;
  switch (reg.view(spec, at, p, ids[0])) {
    case (?v) #atTable { id = ids[0]; view = v };
    case null #browsing;
  };
};

func atTableView(reg : Reg, at : Int, session : Text) : TP.View<Rules.State> = switch (statusOf(reg, at, session)) {
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
let id1 = ok(reg.createTable(spec, T0, "a", #p1, #open, ""), "a creates a table");
assert id1 == 1;
switch (statusOf(reg, T0, "a")) {
  case (#atTable v) {
    assert v.id == id1;
    switch (v.view) {
      case (#stagingYou sv) assert sv.seat == #p1;
      case (_) Runtime.trap("a should be staging");
    };
  };
  case (_) Runtime.trap("a should be at a table");
};
let id2 = ok(reg.createTable(spec, T0, "z", #p1, #open, ""), "z creates a second table");
assert id2 == 2;
Debug.print("1. createTable seats the creator, ids are sequential OK");

// ── 2. a player may hold up to MAX_TABLES_PER_PLAYER tables, no more ───────
do {
  let reg2 = fresh();
  let other = ok(reg2.createTable(spec, T0, "z", #p1, #open, ""), "z creates a table");
  for (_ in Nat.range(0, Registry.MAX_TABLES_PER_PLAYER)) {
    ignore ok(reg2.createTable(spec, T0, "a", #p1, #open, ""), "a creates another table, up to the cap");
  };
  assert reg2.tablesOf("a").size() == Registry.MAX_TABLES_PER_PLAYER;
  switch (reg2.createTable(spec, T0, "a", #p1, #open, "")) {
    case (#err(#tooManyTables _)) {};
    case (_) Runtime.trap("one table past the cap must be #tooManyTables");
  };
  switch (reg2.joinTable(spec, T0, "a", other, #p2, null)) {
    case (#err(#tooManyTables _)) {};
    case (_) Runtime.trap("joining one past the cap must be #tooManyTables too");
  };
};
Debug.print("2. the per-player table cap blocks create/join OK");

// ── 3. listTables: open tables with a free seat, occupant ids included ─────
switch (reg.listTables(T0)) {
  case (rows) {
    assert rows.size() == 2; // id1, id2 — both p1-taken/p2-open
    for (r in rows.values()) {
      assert not r.p1Open;
      assert r.p2Open;
      assert not r.protected;
      assert r.p2Session == null; // open seat names nobody
    };
  };
};
switch (reg.listTables(T0).find<TP.TableSummary>(func(r) = r.id == id1)) {
  case (?r) assert r.p1Session == ?"a"; // the taken seat names its occupant
  case null Runtime.trap("id1 should still be listed");
};
let idProt = ok(reg.createTable(spec, T0, "q", #p1, #code("secret"), ""), "q creates a protected table");
// A protected table is listed too, just flagged — never its own code.
switch (reg.listTables(T0).find<TP.TableSummary>(func(r) = r.id == idProt)) {
  case (?r) {
    assert r.protected;
    assert not r.p1Open;
    assert r.p2Open;
    assert r.p1Session == ?"q";
  };
  case null Runtime.trap("idProt should be listed, flagged protected");
};
assert reg.listTables(T0).size() == 3;
// q's own view echoes the table's visibility (code included) back to
// them — the only way a "Protected" table's own creator can learn its
// code well enough to actually share it with a friend; a1's own OPEN
// table carries #open instead, never a phantom code.
switch (atTableView(reg, T0, "q")) {
  case (#stagingYou v) switch (v.visibility) {
    case (#code c) assert c == "secret";
    case (#open) Runtime.trap("q's own protected table should echo back #code(\"secret\")");
  };
  case (_) Runtime.trap("q should be staging");
};
switch (atTableView(reg, T0, "a")) {
  case (#stagingYou v) switch (v.visibility) {
    case (#open) {};
    case (#code _) Runtime.trap("a's own open table should never carry a code");
  };
  case (_) Runtime.trap("a should be staging");
};
Debug.print("3. listTables lists open AND protected tables, with occupant ids OK");

// ── 4. joinTable: bad id, bad/missing code, correct code, open needs none ───
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

// ── 5. routing: a move on one table never touches another ──────────────────
// id1 now has a(p1)/z2(p2) live; idProt has q(p1)/b(p2) live.
ignore ok(
  reg.submit(spec, T0, "a", idOf(reg, "a"), genOf(reg, T0, "a"), turnOf(reg, T0, "a"), #gather),
  "a gathers on id1",
);
switch (atTableView(reg, T0, "q")) {
  case (#inGame g) assert not g.oppSubmitted; // idProt untouched by a's move on id1
  case (_) Runtime.trap("q should still be mid-game, unaffected by id1");
};
Debug.print("5. submit routes to the acting session's own table only OK");

// ── 6. leave returns the session to browsing and GCs an empty table ────────
ok(reg.leave(T0, "z", idOf(reg, "z"), genOf(reg, T0, "z")), "z (alone, staging id2) leaves");
switch (statusOf(reg, T0, "z")) {
  case (#browsing _) {};
  case (_) Runtime.trap("z should be back to browsing");
};
for (r in reg.listTables(T0).values()) { assert r.id != id2 }; // GC'd — id2 is gone
let id3 = ok(reg.createTable(spec, T0, "z", #p1, #open, ""), "z creates a fresh table after leaving");
assert id3 != id2; // ids are never reused, even once GC'd
Debug.print("6. leave returns to browsing and GCs an empty table; ids are never reused OK");

// ── 7. an idle table resurfaces through listTables, in any phase ───────────
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
reg.ackEnded("a", idOf(reg, "a"));
switch (statusOf(reg, LATER, "a")) {
  case (#browsing _) {};
  case (_) Runtime.trap("acking #endedByOther should return a to browsing");
};
Debug.print("7. idle takeover resurfaces via listTables; ackEnded returns to browsing OK");

// ── 8. a permanently-unacked notice doesn't pin a ghost table forever ──────
// Regression for a real bug: a's/b's game goes idle and nobody ever visits to
// ack the notice sweep records for them (e.g. both closed their tab for good)
let reg8 = fresh();
let idG = ok(reg8.createTable(spec, T0, "a", #p1, #open, ""), "a creates a table");
ignore ok(reg8.joinTable(spec, T0, "b", idG, #p2, null), "b joins; game live");
let VANISH = T0 + TIMEOUT + 1_000_000_000; // a/b's own game goes idle
reg8.sweep(VANISH, nobody); // the periodic timer frees it with nobody visiting
var ghostSeen = false;
for (r in reg8.listTables(VANISH).values()) {
  if (r.id == idG) ghostSeen := true;
};
assert ghostSeen; // freed, but not GC'd — a/b are still owed their notice
// c and d play an entirely separate, cleanly-finished game on the same
// freed board — same id, since ids are only ever handed out fresh.
ignore ok(reg8.joinTable(spec, VANISH, "c", idG, #p1, null), "c joins the freed board");
ignore ok(reg8.joinTable(spec, VANISH, "d", idG, #p2, null), "d joins; game live");
let cGen = genOf(reg8, VANISH, "c");
let dGen = genOf(reg8, VANISH, "d");
ok(reg8.leave(VANISH, "c", idOf(reg8, "c"), cGen), "c forfeits (leave from the live game)");
ok(reg8.leave(VANISH, "c", idOf(reg8, "c"), cGen), "c also acks their own shared debrief");
ok(reg8.leave(VANISH, "d", idOf(reg8, "d"), dGen), "d acks the shared debrief too");
ghostSeen := false;
for (r in reg8.listTables(VANISH).values()) {
  if (r.id == idG) ghostSeen := true;
};
assert ghostSeen; // a/b's still-unacked notice blocks GC even after c/d's clean finish
// long after: a/b were never coming back — the notice goes stale and is pruned
let LONG_AFTER = VANISH + TIMEOUT * 10 + 1_000_000_000;
reg8.sweep(LONG_AFTER, nobody);
for (r in reg8.listTables(LONG_AFTER).values()) { assert r.id != idG }; // finally GC'd
switch (statusOf(reg8, LONG_AFTER, "a")) {
  case (#browsing _) {}; // the stale notice is gone quietly, not shown forever either
  case (_) Runtime.trap("a's ancient, never-acked notice should have expired quietly");
};
Debug.print("8. a permanently-unacked notice is eventually pruned, unblocking GC OK");

// ── 9. the exact reported bug: a clicks "Return to lobby", THEN b clicks
//      "Rematch" ────────────────────────────────────────────────────────────
let reg9 = fresh();
let idR = ok(reg9.createTable(spec, T0, "a", #p1, #open, ""), "a creates a table");
ignore ok(reg9.joinTable(spec, T0, "b", idR, #p2, null), "b joins; game live");
ignore ok(reg9.submit(spec, T0, "a", idOf(reg9, "a"), genOf(reg9, T0, "a"), turnOf(reg9, T0, "a"), #gather), "a gathers");
ignore ok(reg9.submit(spec, T0, "b", idOf(reg9, "b"), genOf(reg9, T0, "b"), turnOf(reg9, T0, "b"), #gather), "b gathers");
ignore ok(reg9.submit(spec, T0, "a", idOf(reg9, "a"), genOf(reg9, T0, "a"), turnOf(reg9, T0, "a"), #attack), "a attacks");
ignore ok(reg9.submit(spec, T0, "b", idOf(reg9, "b"), genOf(reg9, T0, "b"), turnOf(reg9, T0, "b"), #gather), "b gathers again; a wins, both land in debrief");
ok(reg9.leave(T0, "a", idOf(reg9, "a"), genOf(reg9, T0, "a")), "a returns to the lobby first");
switch (statusOf(reg9, T0, "a")) {
  case (#browsing _) {};
  case (_) Runtime.trap("a should be back to browsing after their own leave");
};
switch (ok(reg9.rematch(spec, T0, "b", idOf(reg9, "b")), "b requests a rematch after a already left")) {
  case (#awaitingPartner) {};
  case (_) Runtime.trap("b's rematch should still stage");
};
switch (atTableView(reg9, T0, "b")) {
  case (#stagingYou v) assert not v.reservedForPartner;
  case (_) Runtime.trap("b's seat must be open, not reserved for a's ghost");
};
var listed = false;
for (r in reg9.listTables(T0).values()) { if (r.id == idR) listed := true };
assert listed; // no longer hidden behind a reservation nobody can ever fill
ignore ok(reg9.joinTable(spec, T0, "c", idR, #p1, null), "an unrelated visitor takes the open seat");
Debug.print("9. rematch after the partner already left doesn't strand the requester OK");

// ── 10. a still-live rematch invite can be DECLINED, not just accepted or
//      silently waited out ──────────────────────────────────────────────────
let reg10 = fresh();
let idR2 = ok(reg10.createTable(spec, T0, "a", #p1, #open, ""), "a creates a table");
ignore ok(reg10.joinTable(spec, T0, "b", idR2, #p2, null), "b joins; game live");
ignore ok(reg10.submit(spec, T0, "a", idOf(reg10, "a"), genOf(reg10, T0, "a"), turnOf(reg10, T0, "a"), #gather), "a gathers");
ignore ok(reg10.submit(spec, T0, "b", idOf(reg10, "b"), genOf(reg10, T0, "b"), turnOf(reg10, T0, "b"), #gather), "b gathers");
ignore ok(reg10.submit(spec, T0, "a", idOf(reg10, "a"), genOf(reg10, T0, "a"), turnOf(reg10, T0, "a"), #attack), "a attacks");
ignore ok(reg10.submit(spec, T0, "b", idOf(reg10, "b"), genOf(reg10, T0, "b"), turnOf(reg10, T0, "b"), #gather), "b gathers again; a wins");
ignore ok(reg10.rematch(spec, T0, "a", idOf(reg10, "a")), "a requests a rematch, reserving b's old seat");
let declineGen = switch (atTableView(reg10, T0, "b")) {
  case (#awaitingRematch v) v.gen;
  case (_) Runtime.trap("b should see the invitation");
};
ok(reg10.leave(T0, "b", idOf(reg10, "b"), declineGen), "b declines");
switch (statusOf(reg10, T0, "b")) {
  case (#browsing _) {};
  case (_) Runtime.trap("declining should return b to browsing, not strand them either");
};
switch (atTableView(reg10, T0, "a")) {
  case (#stagingYou v) assert not v.reservedForPartner;
  case (_) Runtime.trap("a's own staging must survive b's decline, now open");
};
ignore ok(reg10.joinTable(spec, T0, "c", idR2, #p2, null), "an unrelated visitor takes the declined seat");
Debug.print("10. a still-live rematch invite can be declined, not just accepted or ignored OK");

// ── 11. a session a phase transition moved past isn't locked out of the game
//      FOREVER ──────────────────────────────────────────────────────────────

// 11a. a lone staging never times out for its occupant: it stays theirs
//        until they leave it (or a sweep finds them absent, 11b).
let reg11a = fresh();
let idA = ok(reg11a.createTable(spec, T0, "a", #p1, #open, ""), "a stages, alone");
assert reg11a.tablesOf("a") == [idA]; // a still holds their idle staging
expectErr(reg11a.joinTable(spec, LATER, "b", idA, #p1, null), "nobody takes a's idle staged seat");
ok(reg11a.leave(LATER, "a", idOf(reg11a, "a"), genOf(reg11a, LATER, "a")), "a leaves their staging");
assert reg11a.tablesOf("a").size() == 0; // leaving let the table go
Debug.print("11a. an idle staging stays its occupant's until they leave OK");

// 11b. a sweep frees an absent occupant's idle staging — the swept
//        session must recover, and the table is GC'd.
let reg11b = fresh();
let idB = ok(reg11b.createTable(spec, T0, "a", #p1, #open, ""), "a stages, alone");
reg11b.sweep(LATER, func(s) = s == "a");
assert reg11b.tablesOf("a") == [idB]; // a is present: their staging survives the sweep
reg11b.sweep(LATER, nobody);
for (r in reg11b.listTables(LATER).values()) { assert r.id != idB };
assert reg11b.tablesOf("a").size() == 0; // swept while absent: the table is gone
Debug.print("11b. a staging swept while its occupant is absent is GC'd OK");

// 11c. a full debrief expires pre-acked — an outsider's `join` is what
//        actually marks it that way (see `join`'s own #debrief doc);
//        neither a nor b ever called leave/ackEnded themselves.
let reg11c = fresh();
let idC = ok(reg11c.createTable(spec, T0, "a", #p1, #open, ""), "a creates a table");
ignore ok(reg11c.joinTable(spec, T0, "b", idC, #p2, null), "b joins; game live");
ignore ok(reg11c.submit(spec, T0, "a", idOf(reg11c, "a"), genOf(reg11c, T0, "a"), turnOf(reg11c, T0, "a"), #gather), "a gathers");
ignore ok(reg11c.submit(spec, T0, "b", idOf(reg11c, "b"), genOf(reg11c, T0, "b"), turnOf(reg11c, T0, "b"), #gather), "b gathers");
ignore ok(reg11c.submit(spec, T0, "a", idOf(reg11c, "a"), genOf(reg11c, T0, "a"), turnOf(reg11c, T0, "a"), #attack), "a attacks");
ignore ok(reg11c.submit(spec, T0, "b", idOf(reg11c, "b"), genOf(reg11c, T0, "b"), turnOf(reg11c, T0, "b"), #gather), "b gathers again; a wins, both land in debrief");
ignore ok(reg11c.joinTable(spec, LATER, "c", idC, #p1, null), "an outsider's join marks the expired debrief pre-acked");
ignore ok(reg11c.createTable(spec, LATER, "a", #p1, #open, ""), "a (never left/acked their own debrief) can still create again");
ignore ok(reg11c.createTable(spec, LATER, "b", #p1, #open, ""), "b (never left/acked their own debrief) can still create again too");
Debug.print("11c. a debrief expiring pre-acked doesn't lock either participant out either OK");

// ── 12. createTable rejects a `#code("")` table ────────────────────────────
let reg12 = fresh();
expectErr(reg12.createTable(spec, T0, "a", #p1, #code(""), ""), "an empty access code should be rejected");
switch (statusOf(reg12, T0, "a")) {
  case (#browsing _) {};
  case (_) Runtime.trap("a rejected createTable must not leave a leftover at-a-table mapping behind");
};
// a real code still works fine, including right after the rejection —
// the bad attempt above left nothing behind.
let idOk = ok(reg12.createTable(spec, T0, "a", #p1, #code("real-code"), ""), "a creates a table with a real code");
switch (reg12.joinTable(spec, T0, "b", idOk, #p2, null)) {
  case (#err(#badCode)) {};
  case (_) Runtime.trap("no code on a real protected table should still be #badCode");
};
ignore ok(reg12.joinTable(spec, T0, "b", idOk, #p2, ?"real-code"), "the real code joins it fine");
Debug.print("12. createTable rejects an empty access code instead of producing an unjoinable table OK");

// ── 13. claimWin routes to the acting session's own table only, and is gated
//      by ITS OWN table's `claimTimeoutNs` exactly like `submit` ────────────
let reg13 = fresh();
let idW1 = ok(reg13.createTable(spec, T0, "a", #p1, #open, ""), "a creates table 1");
ignore ok(reg13.joinTable(spec, T0, "b", idW1, #p2, null), "b joins table 1; game live");
let idW2 = ok(reg13.createTable(spec, T0, "q", #p1, #open, ""), "q creates a second, unrelated table");
ignore ok(reg13.joinTable(spec, T0, "r", idW2, #p2, null), "r joins table 2; game live too");
let g13 = genOf(reg13, T0, "a");
ignore ok(reg13.submit(spec, T0, "a", idOf(reg13, "a"), g13, turnOf(reg13, T0, "a"), #gather), "a moves on table 1; b goes quiet");
switch (reg13.claimWin(spec, T0, "a", idOf(reg13, "a"), g13)) {
  case (#err(#notOverdue _)) {};
  case (_) Runtime.trap("table 1's own claim window hasn't elapsed yet");
};
switch (reg13.claimWin(spec, CLAIMABLE, "q", idOf(reg13, "q"), genOf(reg13, T0, "q"))) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("q never submitted a move — nothing for q to claim on table 2");
};
ok(reg13.claimWin(spec, CLAIMABLE, "a", idOf(reg13, "a"), g13), "a claims the overdue win on table 1");
switch (atTableView(reg13, CLAIMABLE, "a")) {
  case (#debrief d) switch (d.end) {
    case (#claimed(#p1)) {};
    case (_) Runtime.trap("a's claim should credit p1");
  };
  case (_) Runtime.trap("a should be in a claimed debrief");
};
// Table 2 (q vs r) is completely unaffected by table 1's claim.
switch (atTableView(reg13, CLAIMABLE, "r")) {
  case (#inGame _) {};
  case (_) Runtime.trap("table 2 should still be live, untouched by table 1's claim");
};
Debug.print("13. claimWin routes per-table and is gated per-table OK");

// ── 14. createTableReserving: Flow 2's atomic dual-seat assignment ─────────
let reg14 = fresh();
ignore ok(reg14.createTableReserving(spec, T0, "a", #p1, #open, "b", ""), "a creates a table reserving b for the other seat");
switch (atTableView(reg14, T0, "a"), atTableView(reg14, T0, "b")) {
  case (#inGame va, #inGame vb) { assert va.seat == #p1; assert vb.seat == #p2 };
  case (_, _) Runtime.trap("both a and b should already be #inGame — no second join call needed");
};
expectErr(reg14.createTableReserving(spec, T0, "c", #p1, #open, "c", ""), "c can't reserve itself for the other seat");
let reg14b = fresh();
for (_ in Nat.range(0, Registry.MAX_TABLES_PER_PLAYER)) {
  ignore ok(reg14b.createTable(spec, T0, "x", #p1, #open, ""), "x fills up their tables");
};
switch (reg14b.createTableReserving(spec, T0, "y", #p1, #open, "x", "")) {
  case (#err(#tooManyTables _)) {};
  case (_) Runtime.trap("can't reserve x — x is at the table cap");
};
Debug.print("14. createTableReserving atomically seats both sides, rejecting self-reservation and a reservee at the cap OK");

// ── 15. setTimeouts: re-applied to the registry AND every existing table ──
let reg15 = fresh();
let id15 = ok(reg15.createTable(spec, T0, "a", #p1, #open, ""), "a creates a table before the timeouts change");
reg15.setTimeouts(TIMEOUT * 2, CLAIM_TIMEOUT * 2);
assert reg15.idleTimeoutNs == TIMEOUT * 2;
assert reg15.claimTimeoutNs == CLAIM_TIMEOUT * 2;
func idleOf(id : Nat) : Int = switch (reg15.tables.get(id)) {
  case (?t) t.idleTimeoutNs;
  case null Runtime.trap("table " # debug_show id # " should exist");
};
assert idleOf(id15) == TIMEOUT * 2;
let id15b = ok(reg15.createTable(spec, T0, "b", #p1, #open, ""), "b creates a table after the timeouts change");
assert id15b != id15;
assert idleOf(id15b) == TIMEOUT * 2;
Debug.print("15. setTimeouts rewrites the registry defaults and every live table OK");

Debug.print("ALL LOBBY CHECKS PASSED");
