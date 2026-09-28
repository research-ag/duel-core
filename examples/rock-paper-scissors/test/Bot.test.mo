// Proves the rock-paper-scissors bot (`../bot/Bot.mo`/`BotLogic.mo`, the
// rule-following canister player — no lookahead, no opponent modeling)
// two ways: (1) `BotLogic.chooseMove` always returns a value from its own
// fixed action set, offline, no engine, no actor; and (2) wired live
// through `mo:duel-game-core/canister_players`, two canister-seated bots
// play each other through a full, real #simultaneous match to a decisive
// finish — the "testing offline" pattern `../../CLAUDE.md`'s "Canister
// players" note describes, using `BotLogic.chooseMove` directly as the
// `callBot` continuation so no real second canister is needed here, same
// as `backend/test/CanisterPlayers.test.mo` and
// `examples/racing/test/Bot.test.mo`.
// Run: mops test Bot
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

// ── 1. chooseMove always returns a legal pick, whatever the turn ───────────
do {
  let s0 = Rules.init();
  for (turn in Nat.range(0, 6)) {
    let req : TP.MoveRequest<Rules.State, Rules.Action> = {
      tableId = 0;
      seat = #p1;
      game = s0;
      mode = #simultaneous;
      turn;
      gen = 0;
      retryReason = null;
      opponent = "p2";
      opponentLastMove = null;
      lastRoundDurationNs = null;
    };
    let move = BotLogic.chooseMove(req);
    switch (Rules.validate(s0, #p1, move)) {
      case null {};
      case (?why) Runtime.trap("chooseMove produced an illegal pick: " # why);
    };
  };
};
Debug.print("1. BotLogic.chooseMove always picks a legal move OK");

// ── 2. wired live through canister_players.mo, two canister seats play a
//        full real #simultaneous match to a decisive finish ────────────────
let TIMEOUT : Int = 60_000_000_000;
let CLAIM_TIMEOUT : Int = 15_000_000_000;
let T0 : Int = 1_000_000_000_000;

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func noopAfterMutation(_now : Int, _sid : TP.SessionId, _reqId : ?Nat64, _id : ?TP.TableId, _broadcast : Bool) : async* () {};

let bot1 = Principal.fromText("aaaaa-aa");
let bot2 = Principal.fromText("2vxsx-fae");

let reg = Registry.new<Rules.State, Rules.Action>(TIMEOUT, CLAIM_TIMEOUT);
let cp = CanisterPlayers.attach<Rules.State, Rules.Action>(
  spec,
  reg,
  noopAfterMutation,
  func(_session : TP.SessionId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
    await* k(?BotLogic.chooseMove(req));
  },
  func(_id : TP.TableId, _secs : Nat) : async* () {}, // armClaimCheck — not exercised here, see backend/test/CanisterPlayers.test.mo's own test 15
);

let id = ok(await* cp.createTable(bot1, #p1, #open), "bot1 creates a table");
let sidBot1 = CanisterPlayers.sidForCanister(bot1, id);
// bot2's own joinTable eagerly triggers both seats' opening picks with no
// sweep call needed at all — and, since a #simultaneous round leaves
// BOTH seats due again for the next round the instant it resolves,
// `notifyAndApply`'s own `maybeSettleBoth` re-check (see
// canister_players.mo's own doc) keeps cascading through several rounds
// in a row from this ONE call, unlike checkers' #alternating counterpart
// (where only one seat is ever due at a time). A #simultaneous bot-vs-bot
// match with a bot on both sides can therefore finish — and get its
// debrief auto-acked (canister vs canister, unconditional) — entirely
// within this single call, with the table already back to #browsing by
// the time it returns.
ignore ok(await* cp.joinTable(bot2, id, #p2, null), "bot2 joins; game starts");

// Whatever didn't already cascade to conclusion above gets driven the
// rest of the way here — never more than a handful of sweeps for a
// match that must decide within a few rounds (see BotLogic.mo's own doc
// on why the per-seat multiplier guarantees a decisive round well before
// `round` below runs out).
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
assert not stalled; // two rule-following bots picking a fixed rotation must reach 3 round wins well within 12 rounds
Debug.print("2. two canister-seated bots play a full real #simultaneous match to a decisive finish OK");

Debug.print("ALL ROCKPAPERSCISSORS BOT CHECKS PASSED");
