// Proves the checkers bot: `chooseMove` only ever returns a
// `legalActions`-listed move (offline), and two canister-seated bots play
// several real `#turnBased` plies through `canister_players`, with
// `chooseMove` as the `callBot` continuation.
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import TP "mo:duel-game-core";
import Rng "mo:duel-game-core/rng";
import CanisterPlayers "mo:duel-game-core/canister_players";
import Registry "mo:duel-game-core/registry";

import BotLogic "../bot/BotLogic";
import Rules "../src/CheckersRules";

let rng = Rng.new(42);

let spec = Rules.spec;

func idx(r : Nat, c : Nat) : Nat = r * 8 + c;

// ── 1. chooseMove never strays outside legalActions ────────────────────────
do {
  let s0 = Rules.init({}, rng);
  for (turn in Nat.range(0, 9)) {
    let req : TP.MoveRequest<Rules.View, Rules.Action> = {
      tableId = 0;
      seat = #p1;
      game = s0;
      mode = #turnBased;
      step = turn;
      gen = 0;
      complexity = "";
      retryReason = null;
      opponent = "p2";
      opponentLastMove = null;
      lastStepDurationNs = null;
    };
    let move = BotLogic.chooseMove(req);
    let legal = Rules.legalActions(s0, #p1);
    assert legal.find<Rules.Action>(func(a) = a == move) != null;
  };

  // A position with a mandatory capture available: legalActions returns
  // exactly one #jump (see RulesUnit.test.mo's own test 6/11 for the same
  // board) — chooseMove must return that same one, whatever `turn` is.
  let chainBoard : Rules.Board = Array.tabulate<?Rules.Piece>(
    64,
    func(i) {
      if (i == idx(6, 1)) ?#manP1 else if (i == idx(5, 2)) ?#manP2 else if (i == idx(3, 4)) ?#manP2 else null;
    },
  );
  for (turn in Nat.range(0, 5)) {
    let req : TP.MoveRequest<Rules.View, Rules.Action> = {
      tableId = 0;
      seat = #p1;
      game = { board = chainBoard; toMove = #p1 };
      mode = #turnBased;
      step = turn;
      gen = 0;
      complexity = "";
      retryReason = null;
      opponent = "p2";
      opponentLastMove = null;
      lastStepDurationNs = null;
    };
    switch (BotLogic.chooseMove(req)) {
      case (#jump { path }) assert path == [idx(6, 1), idx(4, 3), idx(2, 5)];
      case (#move _) Runtime.trap("a capture is mandatory — chooseMove must not offer a #move");
    };
  };
};
Debug.print("1. BotLogic.chooseMove always picks a Rules.legalActions-listed move, mandatory capture included OK");

// ── 2. wired live through canister_players.mo, two canister seats play each
//      other through several real #turnBased plies ────────────────────────
let TIMEOUT : Int = 60_000_000_000;
let CLAIM_TIMEOUT : Int = 15_000_000_000;
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
let bot2 = Principal.fromText("2vxsx-fae");

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
let cp = CanisterPlayers.endpointOf(ctx);

let id = ok(await* botCreates<system>(ctx, bot1, #p1, #open, {}, ""), "bot1 creates a table");
let sidBot1 = CanisterPlayers.idForCanister(bot1, "");
let sidBot2 = CanisterPlayers.idForCanister(bot2, "");
// bot2's own joinTable eagerly triggers the FIRST ply with no sweep at
// all — the #turnBased counterpart to backend/test/CanisterPlayers.test.mo's
// own "bot-vs-bot: the SECOND bot's own joinTable eagerly triggers"
// check, proving #p1 moves first when canister-seated at game start.
ignore ok(await* cp.joinTable<system>(bot2, id, #p2, null, ""), "bot2 joins; game starts");
switch (atTableView(reg, T0, sidBot1)) {
  case (#inGame v) assert v.step > 0; // #p1's own opening move already resolved
  case (_) Runtime.trap("bot1 should be in-game, at least one ply in");
};

// `maybeNotifyBoth` re-reads status fresh between checking p1 and p2 (see
// `canister_players.mo`'s own doc), so one `sweep` call typically resolves
// TWO plies here (whichever seat is due, then
var round = 0;
var lastTurn = switch (atTableView(reg, T0, sidBot1)) {
  case (#inGame v) v.step;
  case (_) 0;
};
var stalled = false;
while (round < 8) {
  await* CanisterPlayers.sweep<system, Rules.State, Rules.Action, Rules.View, Rules.Options>(ctx, T0);
  switch (statusOf(reg, T0, sidBot1)) {
    case (#atTable { view = #inGame v }) {
      if (v.step == lastTurn) stalled := true; // a due seat's sweep produced no progress at all
      lastTurn := v.step;
    };
    case (_) {}; // the game already ended — see the check right below
  };
  round += 1;
};
assert not stalled;
switch (statusOf(reg, T0, sidBot1), statusOf(reg, T0, sidBot2)) {
  case (#atTable { view = #inGame v1 }, #atTable { view = #inGame v2 }) {
    assert v1.step == v2.step;
    assert v1.step > 0; // at least the opening ply, and no sweep call ever stalled
  };
  case (_, _) {
    // one seat may have already won (a real, if unlikely, outcome of two
    // rule-following-but-lookahead-free bots after this many plies)
    switch (statusOf(reg, T0, sidBot1)) {
      case (#atTable { view = #debrief _ }) {};
      case (#browsing _) {};
      case (other) Runtime.trap("expected in-game, a real debrief, or an already-settled browsing state, got " # debug_show (other));
    };
  };
};
Debug.print("2. two canister-seated bots resolve several real #turnBased plies against each other, no stall OK");

Debug.print("ALL CHECKERS BOT CHECKS PASSED");
