// Unit checks for `legacy_layout_migration.mo`: session ids become player
// ids, every phase converts, and the registry's own fields carry over.
import Debug "mo:core/Debug";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import CanisterPlayers "../src/canister_players";
import M "../src/legacy_layout_migration";
import T "../src/types";

type OldState = { n : Nat };
type NewState = { n : Nat; toMove : T.Seat };
type Options = { tag : Text };

let P = "2vxsx-fae";
let BOT = "rrkah-fqaaa-aaaaa-aaaaq-cai";

func expect(ok : Bool, msg : Text) {
  if (not ok) Runtime.trap(msg);
};

// ── 1. Session ids map to player ids ───────────────────────────────────────
do {
  expect(M.playerOf("ii:" # P) == P, "1a: ii: drops the prefix");
  expect(M.playerOf("an:" # P) == P, "1b: an: drops the prefix");
  expect(M.playerOf("cp:" # BOT # ":7:Hard") == "cp:" # BOT # ":Hard", "1c: cp: drops the table id");
  expect(M.playerOf("cp:" # BOT # ":7:a:b") == "cp:" # BOT # ":a:b", "1d: a complexity keeps its colons");
  expect(M.playerOf("cp:" # BOT # ":7:") == "cp:" # BOT # ":Default", "1e: an empty complexity normalizes");
  expect(
    M.playerOf("cp:" # BOT # ":7:Hard") == CanisterPlayers.idForCanister(Principal.fromText(BOT), "Hard"),
    "1f: the bot id is idForCanister's",
  );
  expect(M.playerOf("odd") == "odd", "1g: anything else is kept");
  expect(M.seatOnTurn(0) == #p1 and M.seatOnTurn(3) == #p2, "1h: seatOnTurn alternates from p1");
  Debug.print("1. session ids map to player ids OK");
};

// ── 2. A registry with a table in every phase ──────────────────────────────
func oldTable(variant : Text, phase : M.OldPhase<OldState, Nat>) : M.OldTable<OldState, Nat> = {
  var idleTimeoutNs = 90;
  var claimTimeoutNs = 60;
  visibility = #code "abc";
  createdBy = "ii:" # P;
  variant;
  var phase = phase;
  var gen = 4;
  var lastEnded = [{
    p1 = "an:" # P;
    p2 = "cp:" # BOT # ":1:Easy";
    acked = ["an:" # P];
    since = 5;
  }];
  var debriefAcked = ["cp:" # BOT # ":1:Easy"];
};

let tables = Map.empty<T.TableId, M.OldTable<OldState, Nat>>();
tables.add(Nat.compare, 1, oldTable("", #empty));
tables.add(
  Nat.compare,
  2,
  oldTable("well", #staging { seat = #p2; session = "ii:" # P; reservedFor = ?("cp:" # BOT # ":2:Easy"); since = 6 }),
);
tables.add(
  Nat.compare,
  3,
  oldTable(
    "",
    #active {
      p1 = "ii:" # P;
      p2 = "cp:" # BOT # ":3:Hard";
      game = { n = 9 };
      pending1 = ?1;
      pending2 = null;
      turn = 3;
      lastActivity = 7;
      roundStartedAt = 8;
      lastRoundDurationNs = ?2;
      lastMoveP1 = ?4;
      lastMoveP2 = ?5;
    },
  ),
);
tables.add(
  Nat.compare,
  4,
  oldTable("", #debrief { p1 = "an:" # P; p2 = "ii:" # P; end = #aborted(#p1); turns = 2; finalGame = { n = 1 }; since = 9 }),
);

let directory = CanisterPlayers.newBotDirectory();
CanisterPlayers.registerBot(directory, Principal.fromText(BOT), "Bot", ["Easy"], 1);

let old : M.Old<OldState, Nat> = {
  registry = {
    var idleTimeoutNs = 111;
    var claimTimeoutNs = 222;
    var tables = tables;
    var bySession = Map.empty<Text, T.TableId>();
    var tableIdNonce = 5;
    var gamesStarted = null;
    var activeGames = null;
    var roundsPerGame = null;
    var matchmakingWaitSecs = null;
  };
  botDirectory = directory;
  wasm = { var live = []; staged = List.empty<Blob>() };
};

let migrated = M.run<OldState, NewState, Nat, Options>(
  old,
  {
    options = func(raw : Text) : Options = { tag = "v=" # raw };
    state = func(s : OldState, turn : Nat) : NewState = {
      n = s.n;
      toMove = M.seatOnTurn(turn);
    };
  },
);
let r = migrated.duel.registry;

func tableAt(id : T.TableId) : T.Table<NewState, Nat, Options> {
  let ?t = r.tables.get(Nat.compare, id) else Runtime.trap("table " # debug_show id # " missing");
  t;
};

do {
  expect(r.idleTimeoutNs == 111 and r.claimTimeoutNs == 222, "2a: timeouts carry over");
  expect(r.tableIdNonce == 5 and r.tables.size() == 4, "2b: nonce and every table carry over");
  let t1 = tableAt(1);
  expect(t1.createdBy == P and t1.options.tag == "v=" and t1.rev == 0, "2c: creator, options, rev");
  expect(t1.gen == 4 and t1.visibility == #code "abc", "2d: gen and visibility");
  expect(t1.debriefAcked == ["cp:" # BOT # ":Easy"], "2e: debriefAcked mapped");
  let e = t1.lastEnded[0];
  expect(e.p1 == P and e.p2 == "cp:" # BOT # ":Easy" and e.acked == [P], "2f: lastEnded mapped");
  expect(tableAt(2).options.tag == "v=well", "2g: options from the variant text");
  switch (tableAt(2).phase) {
    case (#staging s) expect(s.session == P and s.reservedFor == ?("cp:" # BOT # ":Easy") and s.seat == #p2, "2h: staging mapped");
    case _ Runtime.trap("2h: still staging");
  };
  switch (tableAt(3).phase) {
    case (#active a) {
      expect(a.p1 == P and a.p2 == "cp:" # BOT # ":Hard", "2i: active seats mapped");
      expect(a.step == 3 and a.stepStartedAt == 8 and a.lastStepDurationNs == ?2, "2j: turn fields renamed");
      expect(a.game.n == 9 and a.game.toMove == #p2, "2k: state converted with the turn");
      expect(a.pending1 == ?1 and a.lastMoveP1 == ?4 and a.lastMoveP2 == ?5, "2l: moves kept");
    };
    case _ Runtime.trap("2i: still active");
  };
  switch (tableAt(4).phase) {
    case (#debrief d) {
      expect(d.p1 == P and d.p2 == P and d.steps == 2 and d.end == #aborted(#p1), "2m: debrief mapped");
      expect(d.finalGame.toMove == #p1, "2n: final state converted with the turn count");
    };
    case _ Runtime.trap("2m: still a debrief");
  };
  expect(tableAt(1).phase == #empty, "2o: empty stays empty");
  Debug.print("2. every phase converts OK");
};

// ── 3. The rest of the new layout ──────────────────────────────────────────
do {
  expect(migrated.bots.directory.bots.size() == 1, "3a: bot directory kept");
  expect(migrated.bots.inFlight.size() == 0 and migrated.bots.replying.size() == 0, "3b: no asks in flight");
  expect(migrated.duel.presence.size() == 0 and migrated.duel.lobbyRev == 0, "3c: fresh presence and lobby rev");
  Debug.print("3. bots and duel OK");
};

Debug.print("ALL LEGACY LAYOUT MIGRATION CHECKS PASSED");
