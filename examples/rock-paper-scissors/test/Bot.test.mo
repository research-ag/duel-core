// Proves the rock-paper-scissors bot: `chooseMove` always returns a legal
// pick per variant (offline), and two canister-seated bots play a full real
// match per variant through `canister_players`.
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import TP "mo:duel-game-core";
import CanisterPlayers "mo:duel-game-core/canister_players";
import Registry "mo:duel-game-core/registry";

import BotLogic "../bot/BotLogic";
import Rules "../src/RockPaperScissorsRules";

let spec = Rules.spec();
let TIMEOUT : Int = 60_000_000_000;
let CLAIM_TIMEOUT : Int = 15_000_000_000;
let T0 : Int = 1_000_000_000_000;

// ── 1. chooseMove always returns a legal pick, whatever the entropy, and
//      covers the whole action set ───────────────────────────────────────────
for (raw in ["", "well"].values()) {
  let s0 = Rules.init(raw);
  var seen : [Rules.Action] = [];
  for (turn in Nat.range(0, 64)) {
    let req : TP.MoveRequest<Rules.State, Rules.Action> = {
      tableId = 0;
      seat = #p1;
      game = s0;
      mode = #simultaneous;
      turn;
      gen = 0;
      complexity = "";
      retryReason = null;
      opponent = "p2";
      opponentLastMove = null;
      lastRoundDurationNs = null;
    };
    let move = BotLogic.chooseMove(req, T0 + turn * 1_000_003);
    switch (Rules.validate(s0, #p1, move)) {
      case null {};
      case (?why) Runtime.trap("chooseMove produced an illegal pick: " # why);
    };
    if (seen.find(func(a : Rules.Action) : Bool { a == move }) == null) {
      seen := seen.concat([move]);
    };
  };
  assert seen.size() == (if (raw == "") 3 else 4);
};
Debug.print("1. BotLogic.chooseMove always picks a legal move and reaches every action, in classic and well alike OK");

// ── 2/3. wired live through canister_players.mo, two canister seats play a
//      full real #simultaneous match to a decisive finish ───────────────────

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func noopAfterMutation(_now : Int, _sid : TP.SessionId, _id : ?TP.TableId, _broadcast : Bool) : async* () {};

let bot1 = Principal.fromText("aaaaa-aa");
let bot2 = Principal.fromText("2vxsx-fae");

var entropy : Int = T0;

func playFullMatch(variant : Text) : async* () {
  let reg = Registry.new<Rules.State, Rules.Action>();
  reg.setTimeouts(TIMEOUT, CLAIM_TIMEOUT);
  let cp = CanisterPlayers.attach<Rules.State, Rules.Action>(
    spec,
    reg,
    noopAfterMutation,
    func(_session : TP.SessionId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
      entropy += 1_000_003;
      await* k(?BotLogic.chooseMove(req, entropy));
    },
    func(_id : TP.TableId, _secs : Nat) : async* () {}, // armClaimCheck — not exercised here, see backend/test/CanisterPlayers.test.mo's own test 15
  );

  let id = ok(await* cp.createTable(bot1, #p1, #open, variant, ""), "bot1 creates a table");
  let sidBot1 = CanisterPlayers.sidForCanister(bot1, id, "");
  // bot2's own joinTable eagerly triggers both seats' opening picks with no
  // sweep call needed at all
  ignore ok(await* cp.joinTable(bot2, id, #p2, null, ""), "bot2 joins; game starts");

  // Whatever didn't already cascade to conclusion above gets driven the rest
  // of the way here
  var round = 0;
  var stalled = true;
  label loop_ while (round < 12) {
    switch (reg.status(spec, T0, sidBot1)) {
      case (#atTable { view = #inGame _ }) {};
      case (#atTable { view = #debrief d }) {
        switch (d.end) {
          case (#finished(_)) { stalled := false };
          case (other) Runtime.trap("match ended unexpectedly: " # debug_show (other));
        };
        break loop_;
      };
      case (#browsing _) {
        // The match already concluded AND both canister debriefs
        // auto-acked, all within `joinTable`'s own cascade above.
        stalled := false;
        break loop_;
      };
      case (other) Runtime.trap("unexpected state for bot1: " # debug_show (other));
    };
    await* cp.sweep(T0);
    round += 1;
  };
  assert not stalled; // two rule-following bots with varying entropy must reach 3 round wins well within 12 rounds
};

await* playFullMatch(""); // classic
Debug.print("2. two canister-seated bots play a full real classic-mode match to a decisive finish OK");

await* playFullMatch("well");
Debug.print("3. two canister-seated bots play a full real well-mode match to a decisive finish OK");

Debug.print("ALL ROCKPAPERSCISSORS BOT CHECKS PASSED");
