// Proves the racing bot: `SCRIPT_P1` stays legal against the real
// `validate`/`resolve` for its full length plus the post-script clamp, and a
// canister seated with it drives several real rounds against a human through
// `canister_players`, finishing the race.
import Debug "mo:core/Debug";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import TP "mo:duel-game-core";
import Rng "mo:duel-game-core/rng";
import CanisterPlayers "mo:duel-game-core/canister_players";
import Registry "mo:duel-game-core/registry";

import BotLogic "../bot/BotLogic";
import Rules "../src/RacingRules";

let rng = Rng.new(42);

let spec = Rules.spec;

// ── 1. SCRIPT (plus the post-script hold) stays legal for a real, collision-
//      checked drive ────────────────────────────────────────────────────────
do {
  var state = Rules.init({}, rng);
  var i = 0;
  let steps = BotLogic.SCRIPT_P1.size() + 4; // a few rounds past the array's end too
  while (i < steps) {
    let req : TP.MoveRequest<Rules.View, Rules.Action> = {
      tableId = 0;
      seat = #p1;
      game = state;
      mode = #simultaneous;
      step = i;
      gen = 0;
      complexity = "";
      retryReason = null;
      opponent = "p2";
      opponentLastMove = null;
      lastStepDurationNs = null;
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

// ── 2. wired live through canister_players.mo, the bot drives several rounds
//      against a human with no illegal move ─────────────────────────────────
let TIMEOUT : Int = 300_000_000_000;
let CLAIM_TIMEOUT : Int = 45_000_000_000;
let T0 : Int = 1_000_000_000_000;

// The player's first table and their view of it, or `#browsing`.
func statusOf(reg : TP.Registry<Rules.State, Rules.Action, Rules.Options>, at : Int, p : TP.PlayerId) : {
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

// A bot opening a table: seats it directly (bots open no tables
// themselves through the canister-player methods) and runs the same
// fan-out a mutation does.
func botCreates<system>(ctx : CanisterPlayers.Ctx<Rules.State, Rules.Action, Rules.View, Rules.Options>, bot : Principal.Principal, seat : TP.Seat, visibility : TP.TableVisibility, options : Rules.Options, complexity : Text) : async* TP.Res<TP.TableId> {
  switch (ctx.registry.createTable(ctx.spec, ctx.rng, T0, CanisterPlayers.idForCanister(bot, complexity), seat, visibility, options)) {
    case (#ok id) {
      await* ctx.afterMutation<system>(T0, id, true);
      #ok id;
    };
    case (#err e) #err e;
  };
};

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func atTableView(reg : TP.Registry<Rules.State, Rules.Action, Rules.Options>, at : Int, session : Text) : TP.TableView<Rules.State> = switch (statusOf(reg, at, session)) {
  case (#atTable v) v.view;
  case (#browsing _) Runtime.trap("expected " # session # " to be at a table");
};

let bot1 = Principal.fromText("aaaaa-aa");

let reg = Registry.new<Rules.State, Rules.Action, Rules.Options>();

reg.setTimeouts(TIMEOUT, CLAIM_TIMEOUT);
// The bots without the transport: every mutation settles the table
// right away, and no timers (the interpreter has none).
func settleAfter<system>(now : Int, id : TP.TableId, _ : Bool) : async* () {
  await* CanisterPlayers.settle<system, Rules.State, Rules.Action, Rules.View, Rules.Options>(ctx, now, id);
};
let ctx : CanisterPlayers.Ctx<Rules.State, Rules.Action, Rules.View, Rules.Options> = {
  registry = reg;
  spec;
  rng;
  store = CanisterPlayers.newStore();
  call = func<system>(_session : TP.PlayerId, req : TP.MoveRequest<Rules.View, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    await* k<system>(?BotLogic.chooseMove(req));
  };
  afterMutation = func<system>(now : Int, id : TP.TableId, b : Bool) : async* () {
    await* settleAfter<system>(now, id, b);
  };
  arm = func<system>(_ : TP.TableId, _ : Nat) {};
};

let id = ok(await* botCreates<system>(ctx, bot1, #p1, #open, {}, ""), "bot creates a table");
let sidBot1 = CanisterPlayers.idForCanister(bot1, "");
// The human joins directly against `reg` — standing in for `transport.mo`
// dispatching a browser's own `joinTable`, exactly as
// `backend/test/CanisterPlayers.test.mo` does for its own human sessions.
ignore ok(reg.joinTable(spec, rng, T0, "human", id, #p2, null), "human joins bot1's table");

var round = 0;
var finished = false;
while (round < BotLogic.SCRIPT_P1.size() + 2 and not finished) {
  await* CanisterPlayers.sweep<system, Rules.State, Rules.Action, Rules.View, Rules.Options>(ctx, T0);
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
    ignore ok(reg.submit(spec, rng, T0, "human", id, hv.gen, hv.step, { l = 0.0; c = 0.0 }), "human submits a no-op move; round resolves");
  };
  round += 1;
};
assert finished; // the script must actually finish the race within this many rounds
Debug.print("2. wired through canister_players.mo, the bot drives several live rounds against a human with no illegal move and finishes the race OK");

Debug.print("ALL RACING BOT CHECKS PASSED");
