// Proves the racing bot (`../bot/Bot.mo`/`BotLogic.mo`, the milestone-01
// hardcoded-script canister player) two ways: (1) `BotLogic.SCRIPT_P1`
// stays legal — RacingRules.validate-passing, no collision-forced illegal
// move — for its own full length plus several rounds of the post-script
// "hold the last entry" clamp, replayed against the REAL
// `RacingRules.validate`/`resolve` (this is the permanent regression
// guard for the numbers `BotLogic.mo`'s own doc comment says were
// derived offline); and (2) wired live through
// `mo:duel-game-core/canister_players`, a canister seated with this exact
// bot logic drives several real rounds against a human opponent with no
// illegal move and no trap, actually finishing the race by the time
// SCRIPT_P1 runs out — the "testing offline" pattern
// `../../../CLAUDE.md`'s "Canister players" note describes, using
// `BotLogic.chooseMove` directly as the `callBot` continuation so no
// actor/Candid round-trip (and no second, real canister) is needed here,
// same as `backend/test/CanisterPlayers.test.mo` does for its own
// FakeGame-backed suite.
// Run: mops test Bot
import Debug "mo:core/Debug";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import TP "mo:duel-game-core";
import CanisterPlayers "mo:duel-game-core/canister_players";
import Registry "mo:duel-game-core/registry";

import BotLogic "../bot/BotLogic";
import Rules "../src/RacingRules";

let spec = Rules.spec();

// ── 1. SCRIPT (plus the post-script hold) stays legal for a real,
//        collision-checked drive — not just the idealized no-wall
//        recurrence it was originally derived from ───────────────────────
do {
  var state = Rules.init();
  var i = 0;
  let steps = BotLogic.SCRIPT_P1.size() + 4; // a few rounds past the array's end too
  while (i < steps) {
    let req : TP.MoveRequest<Rules.State> = {
      tableId = 0;
      seat = #p1;
      game = state;
      mode = #simultaneous;
      turn = i;
      gen = 0;
      retryReason = null;
    };
    let move = BotLogic.chooseMove(req);
    switch (Rules.validate(state, #p1, move)) {
      case (?why) Runtime.trap("SCRIPT step " # debug_show (i) # " illegal: " # why);
      case null {};
    };
    let r = Rules.resolve(state, move, { l = 0.0; c = 0.0 }); // p2 sits still throughout
    state := r.state;
    i += 1;
  };
};
Debug.print("1. BotLogic.SCRIPT_P1 stays legal for its own length plus the post-script hold, against real collision checks OK");

// ── 2. wired live through canister_players.mo, the bot drives several
//        rounds against a human with no illegal move — and, since the
//        human sits completely still every round, SCRIPT_P1's own
//        post-script cruise actually carries the bot across the finish
//        line by the time its length runs out, ending the match with a
//        real #finished(#p1Wins) debrief rather than staying #active
//        forever ───────────────────────────────────────────────────────
let TIMEOUT : Int = 300_000_000_000;
let CLAIM_TIMEOUT : Int = 45_000_000_000;
let T0 : Int = 1_000_000_000_000;

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func atTableView(reg : TP.Registry<Rules.State, Rules.Action>, at : Int, session : Text) : TP.View<Rules.State> = switch (reg.status(spec, at, session)) {
  case (#atTable v) v.view;
  case (#browsing _) Runtime.trap("expected " # session # " to be at a table");
};

func noopAfterMutation(_now : Int, _sid : TP.SessionId, _reqId : ?Nat64, _id : ?TP.TableId, _broadcast : Bool) : async* () {};

let bot1 = Principal.fromText("aaaaa-aa");
let sidBot1 = CanisterPlayers.sidForCanister(bot1);

let reg = Registry.new<Rules.State, Rules.Action>(TIMEOUT, CLAIM_TIMEOUT);
let cp = CanisterPlayers.attach<Rules.State, Rules.Action>(
  spec,
  reg,
  noopAfterMutation,
  func(_session : TP.SessionId, req : TP.MoveRequest<Rules.State>, k : (?Rules.Action) -> async* ()) : async* () {
    await* k(?BotLogic.chooseMove(req));
  },
  func(_id : TP.TableId, _secs : Nat) : async* () {}, // armClaimCheck — not exercised here, see backend/test/CanisterPlayers.test.mo's own test 15
);

let id = ok(await* cp.createTable(bot1, #p1, #open), "bot creates a table");
// The human joins directly against `reg` — standing in for `ws.mo`
// dispatching a browser's own `joinTable`, exactly as
// `backend/test/CanisterPlayers.test.mo` does for its own human sessions.
ignore ok(reg.joinTable(spec, T0, "human", id, #p2, null), "human joins bot1's table");

var round = 0;
var finished = false;
while (round < BotLogic.SCRIPT_P1.size() + 2 and not finished) {
  await* cp.sweep(T0);
  switch (atTableView(reg, T0, sidBot1)) {
    case (#inGame v) assert v.youSubmitted; // the bot's scripted move landed legally
    case (#debrief d) switch (d.end) {
      case (#finished(#p1Wins)) finished := true; // the script actually finished the race, as tuned
      case (other) Runtime.trap("race ended unexpectedly at round " # debug_show (round) # ": " # debug_show (other));
    };
    case (_) Runtime.trap("bot1 should still be in-game or in debrief after round " # debug_show (round));
  };
  if (not finished) {
    let hv = switch (atTableView(reg, T0, "human")) {
      case (#inGame v) v;
      case (_) Runtime.trap("human should be in-game");
    };
    ignore ok(reg.submit(spec, T0, "human", hv.gen, hv.turn, { l = 0.0; c = 0.0 }), "human submits a no-op move; round resolves");
  };
  round += 1;
};
assert finished; // the script must actually finish the race within this many rounds
Debug.print("2. wired through canister_players.mo, the bot drives several live rounds against a human with no illegal move and finishes the race OK");

Debug.print("ALL RACING BOT CHECKS PASSED");
