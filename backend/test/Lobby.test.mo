// Per-operation unit checks for `Registry` — the multi-table registry
// layered on top of the single-`Table` engine (see `Engine.test.mo`,
// which already covers every per-table primitive `Lobby` itself
// delegates into). This suite drives `createTable`/`listTables`/
// `joinTable` and the routed `submit`/`rematch`/`leave`/`reset`/
// `ackEnded`/`status`, with several tables live at once, on a FRESH
// registry per scenario. Plugged-in rules: FakeGame.mo.
// Run: moc -r --package core <core/src> test/Lobby.test.mo
import Rules "FakeGame";
import Array "mo:core/Array";
import Debug "mo:core/Debug";
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

func fresh() : Reg = Registry.new<Rules.State, Rules.Action>(TIMEOUT, CLAIM_TIMEOUT);

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};
func expectErr<T>(r : TP.Res<T>, msg : Text) = switch (r) {
  case (#ok _) Runtime.trap(msg # " unexpectedly succeeded");
  case (#err _) ();
};

func atTableView(reg : Reg, at : Int, session : Text) : TP.View<Rules.State> = switch (reg.status(spec, at, session)) {
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
switch (reg.status(spec, T0, "a")) {
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

// ── 3. listTables: open tables with a free seat, occupant ids included ────
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
switch (Array.find<TP.TableSummary>(reg.listTables(T0), func(r) = r.id == id1)) {
  case (?r) assert r.p1Session == ?"a"; // the taken seat names its occupant
  case null Runtime.trap("id1 should still be listed");
};
let idProt = ok(reg.createTable(spec, T0, "q", #p1, #code("secret")), "q creates a protected table");
// A protected table is listed too, just flagged — never its own code.
switch (Array.find<TP.TableSummary>(reg.listTables(T0), func(r) = r.id == idProt)) {
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
switch (reg.status(spec, T0, "z")) {
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
switch (reg.status(spec, LATER, "a")) {
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
ignore ok(reg8.leave(VANISH, "c", cGen), "c forfeits (leave from the live game)");
ignore ok(reg8.leave(VANISH, "c", cGen), "c also acks their own shared debrief");
ignore ok(reg8.leave(VANISH, "d", dGen), "d acks the shared debrief too");
ghostSeen := false;
for (r in reg8.listTables(VANISH).values()) {
  if (r.id == idG) ghostSeen := true;
};
assert ghostSeen; // a/b's still-unacked notice blocks GC even after c/d's clean finish
// long after: a/b were never coming back — the notice goes stale and is pruned
let LONG_AFTER = VANISH + TIMEOUT * 10 + 1_000_000_000;
reg8.sweep(LONG_AFTER);
for (r in reg8.listTables(LONG_AFTER).values()) { assert r.id != idG }; // finally GC'd
switch (reg8.status(spec, LONG_AFTER, "a")) {
  case (#browsing _) {}; // the stale notice is gone quietly, not shown forever either
  case (_) Runtime.trap("a's ancient, never-acked notice should have expired quietly");
};
Debug.print("8. a permanently-unacked notice is eventually pruned, unblocking GC OK");

// ── 9. the exact reported bug: a clicks "Return to lobby", THEN b clicks
//        "Rematch" — b must not be stranded waiting on a reservation for a
//        partner who already left; a never sees anything because they
//        genuinely aren't a participant any more (see architecture rule
//        12) — that's correct, not a missed notification ────────────────
let reg9 = fresh();
let idR = ok(reg9.createTable(spec, T0, "a", #p1, #open), "a creates a table");
ignore ok(reg9.joinTable(spec, T0, "b", idR, #p2, null), "b joins; game live");
ignore ok(reg9.submit(spec, T0, "a", genOf(reg9, T0, "a"), turnOf(reg9, T0, "a"), #gather), "a gathers");
ignore ok(reg9.submit(spec, T0, "b", genOf(reg9, T0, "b"), turnOf(reg9, T0, "b"), #gather), "b gathers");
ignore ok(reg9.submit(spec, T0, "a", genOf(reg9, T0, "a"), turnOf(reg9, T0, "a"), #attack), "a attacks");
ignore ok(reg9.submit(spec, T0, "b", genOf(reg9, T0, "b"), turnOf(reg9, T0, "b"), #gather), "b gathers again; a wins, both land in debrief");
ignore ok(reg9.leave(T0, "a", genOf(reg9, T0, "a")), "a returns to the lobby first");
switch (reg9.status(spec, T0, "a")) {
  case (#browsing _) {};
  case (_) Runtime.trap("a should be back to browsing after their own leave");
};
switch (ok(reg9.rematch(spec, T0, "b"), "b requests a rematch after a already left")) {
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
//         silently waited out ─────────────────────────────────────────────
let reg10 = fresh();
let idR2 = ok(reg10.createTable(spec, T0, "a", #p1, #open), "a creates a table");
ignore ok(reg10.joinTable(spec, T0, "b", idR2, #p2, null), "b joins; game live");
ignore ok(reg10.submit(spec, T0, "a", genOf(reg10, T0, "a"), turnOf(reg10, T0, "a"), #gather), "a gathers");
ignore ok(reg10.submit(spec, T0, "b", genOf(reg10, T0, "b"), turnOf(reg10, T0, "b"), #gather), "b gathers");
ignore ok(reg10.submit(spec, T0, "a", genOf(reg10, T0, "a"), turnOf(reg10, T0, "a"), #attack), "a attacks");
ignore ok(reg10.submit(spec, T0, "b", genOf(reg10, T0, "b"), turnOf(reg10, T0, "b"), #gather), "b gathers again; a wins");
ignore ok(reg10.rematch(spec, T0, "a"), "a requests a rematch, reserving b's old seat");
let declineGen = switch (atTableView(reg10, T0, "b")) {
  case (#awaitingRematch v) v.gen;
  case (_) Runtime.trap("b should see the invitation");
};
ignore ok(reg10.leave(T0, "b", declineGen), "b declines");
switch (reg10.status(spec, T0, "b")) {
  case (#browsing _) {};
  case (_) Runtime.trap("declining should return b to browsing, not strand them either");
};
switch (atTableView(reg10, T0, "a")) {
  case (#stagingYou v) assert not v.reservedForPartner;
  case (_) Runtime.trap("a's own staging must survive b's decline, now open");
};
ignore ok(reg10.joinTable(spec, T0, "c", idR2, #p2, null), "an unrelated visitor takes the declined seat");
Debug.print("10. a still-live rematch invite can be declined, not just accepted or ignored OK");

// ── 11. a session a phase transition moved past isn't locked out of the
//         game FOREVER — regression for a real, critical shipped bug:
//         nothing ever cleared `bySession` off a transition that happens
//         without `leave`/`reset`/`ackEnded` running (a staging timeout,
//         an eviction by someone ELSE's `join`, or a debrief expiring
//         pre-acked), so `createTable`/`joinTable` refused that session
//         with `#wrongPhase` forever after — surviving even a fresh
//         reload, since the session id itself was what was poisoned ────

// 11a. nobody ever joins the abandoned seat, and no `sweep` has even run
//        — time passing alone must be enough; the fix can't depend on a
//        host's periodic timer having already flipped the phase.
let reg11a = fresh();
ignore ok(reg11a.createTable(spec, T0, "a", #p1, #open), "a stages, alone");
ignore ok(reg11a.createTable(spec, LATER, "a", #p1, #open), "a can create again once their own staging has expired");
Debug.print("11a. a lone staging that simply times out doesn't lock its session out OK");

// 11b. someone else's `join` evicts the expired squatter instead of a
//        sweep — the EVICTED session, not the evictor, must recover.
let reg11b = fresh();
let idB = ok(reg11b.createTable(spec, T0, "a", #p1, #open), "a stages, alone");
ignore ok(reg11b.joinTable(spec, LATER, "b", idB, #p1, null), "b evicts a's expired squat on the same seat");
ignore ok(reg11b.createTable(spec, LATER, "a", #p1, #open), "a (evicted by b) can create again");
Debug.print("11b. a session evicted by someone else's join can create again OK");

// 11c. a full debrief expires pre-acked — an outsider's `join` is what
//        actually marks it that way (see `join`'s own #debrief doc);
//        neither a nor b ever called leave/ackEnded themselves.
let reg11c = fresh();
let idC = ok(reg11c.createTable(spec, T0, "a", #p1, #open), "a creates a table");
ignore ok(reg11c.joinTable(spec, T0, "b", idC, #p2, null), "b joins; game live");
ignore ok(reg11c.submit(spec, T0, "a", genOf(reg11c, T0, "a"), turnOf(reg11c, T0, "a"), #gather), "a gathers");
ignore ok(reg11c.submit(spec, T0, "b", genOf(reg11c, T0, "b"), turnOf(reg11c, T0, "b"), #gather), "b gathers");
ignore ok(reg11c.submit(spec, T0, "a", genOf(reg11c, T0, "a"), turnOf(reg11c, T0, "a"), #attack), "a attacks");
ignore ok(reg11c.submit(spec, T0, "b", genOf(reg11c, T0, "b"), turnOf(reg11c, T0, "b"), #gather), "b gathers again; a wins, both land in debrief");
ignore ok(reg11c.joinTable(spec, LATER, "c", idC, #p1, null), "an outsider's join marks the expired debrief pre-acked");
ignore ok(reg11c.createTable(spec, LATER, "a", #p1, #open), "a (never left/acked their own debrief) can still create again");
ignore ok(reg11c.createTable(spec, LATER, "b", #p1, #open), "b (never left/acked their own debrief) can still create again too");
Debug.print("11c. a debrief expiring pre-acked doesn't lock either participant out either OK");

// ── 12. createTable rejects a `#code("")` table — regression: it used to
//          be accepted with no validation, producing a table unlisted
//          (protected) AND unjoinable by anyone (joinTable sends no code
//          at all whenever its own code field is empty, so an empty
//          stored code could never be matched) — the creator's own seat
//          would then just sit there until it expired into N1 ─────────
let reg12 = fresh();
expectErr(reg12.createTable(spec, T0, "a", #p1, #code("")), "an empty access code should be rejected");
switch (reg12.status(spec, T0, "a")) {
  case (#browsing _) {};
  case (_) Runtime.trap("a rejected createTable must not leave a leftover at-a-table mapping behind");
};
// a real code still works fine, including right after the rejection —
// the bad attempt above left nothing stale in `bySession`.
let idOk = ok(reg12.createTable(spec, T0, "a", #p1, #code("real-code")), "a creates a table with a real code");
switch (reg12.joinTable(spec, T0, "b", idOk, #p2, null)) {
  case (#err(#badCode)) {};
  case (_) Runtime.trap("no code on a real protected table should still be #badCode");
};
ignore ok(reg12.joinTable(spec, T0, "b", idOk, #p2, ?"real-code"), "the real code joins it fine");
Debug.print("12. createTable rejects an empty access code instead of producing an unjoinable table OK");

// ── 13. claimWin routes to the acting session's own table only, and is
//          gated by ITS OWN table's `claimTimeoutNs` exactly like `submit` ─
let reg13 = fresh();
let idW1 = ok(reg13.createTable(spec, T0, "a", #p1, #open), "a creates table 1");
ignore ok(reg13.joinTable(spec, T0, "b", idW1, #p2, null), "b joins table 1; game live");
let idW2 = ok(reg13.createTable(spec, T0, "q", #p1, #open), "q creates a second, unrelated table");
ignore ok(reg13.joinTable(spec, T0, "r", idW2, #p2, null), "r joins table 2; game live too");
let g13 = genOf(reg13, T0, "a");
ignore ok(reg13.submit(spec, T0, "a", g13, turnOf(reg13, T0, "a"), #gather), "a moves on table 1; b goes quiet");
switch (reg13.claimWin(spec, T0, "a", g13)) {
  case (#err(#notOverdue _)) {};
  case (_) Runtime.trap("table 1's own claim window hasn't elapsed yet");
};
switch (reg13.claimWin(spec, CLAIMABLE, "q", genOf(reg13, T0, "q"))) {
  case (#err(#wrongPhase _)) {};
  case (_) Runtime.trap("q never submitted a move — nothing for q to claim on table 2");
};
ok(reg13.claimWin(spec, CLAIMABLE, "a", g13), "a claims the overdue win on table 1");
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

Debug.print("ALL LOBBY CHECKS PASSED");
