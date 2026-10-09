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

// The player's first table and their view of it, or `#browsing`.
func statusOf(reg : TP.Registry<Rules.State, Rules.Action>, at : Int, p : TP.PlayerId) : { #atTable : { id : TP.TableId; view : TP.View<Rules.State> }; #browsing } {
  let ids = reg.tablesOf(p);
  if (ids.size() == 0) return #browsing;
  switch (reg.view(spec, at, p, ids[0])) {
    case (?v) #atTable { id = ids[0]; view = v };
    case null #browsing;
  };
};

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};


let bot1 = Principal.fromText("aaaaa-aa");
let bot2 = Principal.fromText("2vxsx-fae");

var entropy : Int = T0;

func playFullMatch(variant : Text) : async* () {
  let reg = Registry.new<Rules.State, Rules.Action>();
  reg.setTimeouts(TIMEOUT, CLAIM_TIMEOUT);
  // The bots without the transport: every mutation settles the table
  // right away, and no timers (the interpreter has none).
  func settleAfter<system>(now : Int, id : TP.TableId, _ : Bool) : async* () {
    await* CanisterPlayers.settle<system, Rules.State, Rules.Action>(ctx, now, id);
  };
  let ctx : CanisterPlayers.Ctx<Rules.State, Rules.Action> = {
    registry = reg;
    spec;
    store = CanisterPlayers.newStore();
    call = func<system>(_session : TP.PlayerId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
        entropy += 1_000_003;
        await* k<system>(?BotLogic.chooseMove(req, entropy));
    };
    afterMutation = func<system>(now : Int, id : TP.TableId, b : Bool) : async* () { await* settleAfter<system>(now, id, b) };
    arm = func<system>(_ : TP.TableId, _ : Nat) {};
  };
  let cp = CanisterPlayers.endpointOf(ctx);

  let id = ok(await* cp.createTable<system>(bot1, #p1, #open, variant, ""), "bot1 creates a table");
  let sidBot1 = CanisterPlayers.idForCanister(bot1, "");
  // bot2's own joinTable eagerly triggers both seats' opening picks with no
  // sweep call needed at all
  ignore ok(await* cp.joinTable<system>(bot2, id, #p2, null, ""), "bot2 joins; game starts");

  // Whatever didn't already cascade to conclusion above gets driven the rest
  // of the way here
  var round = 0;
  var stalled = true;
  label loop_ while (round < 12) {
    switch (statusOf(reg, T0, sidBot1)) {
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
    await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx, T0);
    round += 1;
  };
  assert not stalled; // two rule-following bots with varying entropy must reach 3 round wins well within 12 rounds
};

await* playFullMatch(""); // classic
Debug.print("2. two canister-seated bots play a full real classic-mode match to a decisive finish OK");

await* playFullMatch("well");
Debug.print("3. two canister-seated bots play a full real well-mode match to a decisive finish OK");

Debug.print("ALL ROCKPAPERSCISSORS BOT CHECKS PASSED");
