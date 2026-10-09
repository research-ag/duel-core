// Checks for `transport.mo`: a `Duel` driven by two principals — revs and
// `#unchanged`, the lobby's `yours`, the table cap, the anonymous caller,
// and a waiting table kept open by `keepAlive` through a `sweep`.
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";

import Rules "FakeGame";
import Registry "../src/registry";
import TP "../src/lib";
import Transport "../src/transport";

let PA = Principal.fromText("kcyov-mibae-aqcai-baeaq-cai");
let PB = Principal.fromText("l2hgx-oicai-baeaq-caiba-eaq");
let SEC : Int = 1_000_000_000;

func check(cond : Bool, msg : Text) {
  if (not cond) Runtime.trap(msg);
};

func fresh() : Transport.Duel<Rules.State, Rules.Action> {
  let state = Transport.new<Rules.State, Rules.Action>();
  state.registry.setTimeouts(SEC, SEC);
  Transport.Duel<Rules.State, Rules.Action>(state, Rules.spec(), null, null);
};

func acked(a : Transport.Ack, msg : Text) : { tableId : TP.TableId; rev : Nat } = switch (a) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " failed: " # debug_show e);
};

func lobbyOf(r : Transport.LobbyResult) : { rev : Nat; tables : [TP.TableSummary]; yours : [TP.TableId] } = switch (r) {
  case (#changed l) l;
  case (#unchanged) Runtime.trap("expected a lobby");
};

// ── 1. playerOf(): the caller's principal; never the anonymous one ──────────
do {
  check(Transport.playerOf(PA) == ?PA.toText(), "1a: a player is the caller's principal");
  check(Transport.playerOf(Principal.anonymous()) == null, "1b: the anonymous principal is no player");
  Debug.print("1. playerOf() OK");
};

// ── 2. a table's rev: #changed on rev 0 or a stale rev, else #unchanged ─────
do {
  let duel = fresh();
  let { tableId; rev } = acked(await* duel.createTable<system>(PA, #p1, #open, ""), "2: PA creates");
  check(rev > 0, "2a: a created table has moved off rev 0");
  switch (duel.table(PA, tableId, 0)) {
    case (#changed { rev = r; view = #stagingYou _ }) check(r == rev, "2b: rev 0 gets the view at the acked rev");
    case (other) Runtime.trap("2b: expected PA's staging view, got " # debug_show other);
  };
  check(duel.table(PA, tableId, rev) == #unchanged, "2c: the same rev is #unchanged");
  let joined = acked(await* duel.joinTable<system>(PB, tableId, #p2, null), "2: PB joins");
  check(joined.rev > rev, "2d: a join moves the table's rev");
  switch (duel.table(PA, tableId, rev)) {
    case (#changed { view = #inGame _ }) {};
    case (other) Runtime.trap("2e: PA's stale rev must get the game, got " # debug_show other);
  };
  check(duel.table(PA, 999, 0) == #gone, "2f: no such table is #gone");
  Debug.print("2. table revs OK");
};

// ── 3. the lobby: open tables for everyone, `yours` per caller ──────────────
do {
  let duel = fresh();
  let empty = lobbyOf(duel.lobbyOf(PB, 0));
  check(empty.tables.size() == 0 and empty.yours.size() == 0, "3a: an empty lobby");
  let { tableId } = acked(await* duel.createTable<system>(PA, #p1, #open, ""), "3: PA creates");
  let forB = lobbyOf(duel.lobbyOf(PB, 0));
  check(forB.rev > empty.rev, "3b: creating a table moves the lobby's rev");
  check(forB.tables.size() == 1 and forB.yours.size() == 0, "3c: PB sees the open table, none of its own");
  check(lobbyOf(duel.lobbyOf(PA, 0)).yours == [tableId], "3d: PA's own table is in `yours`");
  check(duel.lobbyOf(PB, forB.rev) == #unchanged, "3e: the same lobby rev is #unchanged");
  ignore await* duel.submit<system>(PA, tableId, 0, 0, #gather); // not in a game: rejected
  check(duel.lobbyOf(PB, forB.rev) == #unchanged, "3f: a rejected submit moves nothing");
  Debug.print("3. lobby revs and `yours` OK");
};

// ── 4. at most MAX_TABLES_PER_PLAYER tables; the anonymous caller is refused
do {
  let duel = fresh();
  for (_ in Nat.range(0, Registry.MAX_TABLES_PER_PLAYER)) {
    ignore acked(await* duel.createTable<system>(PA, #p1, #open, ""), "4: PA creates up to the cap");
  };
  switch (await* duel.createTable<system>(PA, #p1, #open, "")) {
    case (#err(#tooManyTables { max })) check(max == Registry.MAX_TABLES_PER_PLAYER, "4a: the cap is reported");
    case (other) Runtime.trap("4a: one table too many must be refused, got " # debug_show other);
  };
  check(lobbyOf(duel.lobbyOf(PA, 0)).yours.size() == Registry.MAX_TABLES_PER_PLAYER, "4b: PA holds exactly the cap");
  switch (await* duel.createTable<system>(Principal.anonymous(), #p1, #open, "")) {
    case (#err(#unauthorized)) {};
    case (other) Runtime.trap("4c: the anonymous caller must be refused, got " # debug_show other);
  };
  check(duel.keepAlive(Principal.anonymous()) == #err(#unauthorized), "4d: ...for keepAlive too");
  Debug.print("4. table cap and anonymous caller OK");
};

// ── 5. a waiting table: kept through a sweep while kept alive, then gone ────
do {
  let duel = fresh();
  let { tableId; rev } = acked(await* duel.createTable<system>(PA, #p1, #open, ""), "5: PA creates");
  let t0 = Time.now();
  check(duel.keepAlive(PA) == #ok, "5: keepAlive");
  // Past the 1 s idle timeout, still inside the presence TTL.
  await* duel.sweep<system>(t0 + 5 * SEC);
  check(duel.table(PA, tableId, rev) == #unchanged, "5a: a kept-alive waiting table survives the sweep");
  // The creator went silent for longer than the presence TTL.
  let lobbyBefore = lobbyOf(duel.lobbyOf(PB, 0)).rev;
  await* duel.sweep<system>(t0 + Transport.PRESENCE_TTL_NS + 5 * SEC);
  check(duel.table(PA, tableId, rev) == #gone, "5b: a silent creator's waiting table is cleared");
  check(lobbyOf(duel.lobbyOf(PB, 0)).rev > lobbyBefore, "5c: the sweep moved the lobby's rev");
  Debug.print("5. keep-alive and sweep OK");
};

Debug.print("ALL TRANSPORT CHECKS PASSED");
