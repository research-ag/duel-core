// Proves the 007 bot: both complexities always return a legal move
// (offline, over every stat combination), Medium plays the intended
// tactics and out-scores Easy over full games, and two canister-seated
// bots play a full real match through `canister_players`.
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import TP "mo:duel-game-core";
import CanisterPlayers "mo:duel-game-core/canister_players";
import Registry "mo:duel-game-core/registry";

import BotLogic "../bot/BotLogic";
import Rules "../src/Duel007Rules";

let spec = Rules.spec();
let TIMEOUT : Int = 60_000_000_000;
let CLAIM_TIMEOUT : Int = 15_000_000_000;
let T0 : Int = 1_000_000_000_000;

func stats(ammo : Nat, shieldHits : Nat, mirrors : Nat, charge : Nat) : Rules.AgentStats = {
  ammo;
  shieldHits;
  mirrors;
  charge;
};

func stateOf(p1 : Rules.AgentStats, p2 : Rules.AgentStats) : Rules.State = {
  p1;
  p2;
  lastRound = null;
};

func requestFor(s : Rules.State, seat : TP.Seat, complexity : Text, last : ?Rules.Action) : TP.MoveRequest<Rules.State, Rules.Action> = {
  tableId = 0;
  seat;
  game = s;
  mode = #simultaneous;
  turn = 0;
  gen = 0;
  complexity;
  retryReason = null;
  opponent = "p2";
  opponentLastMove = last;
  lastRoundDurationNs = null;
};

func legal(s : Rules.State, seat : TP.Seat, a : Rules.Action) : Bool = Rules.validate(s, seat, a) == null;

// ── 1. every complexity, every stat combination, many entropy values:
//      the move is always one `validate` accepts ───────────────────────────
var checked = 0;
for (complexity in ["Easy", "Medium", "Mystery", ""].values()) {
  for (ammo in [0, 1, 4].values()) {
    for (hits in [0, 2, 3].values()) {
      for (mirrors in [0, 2].values()) {
        for (charge in [0, 4, 5, 6].values()) {
          for (opAmmo in [0, 3].values()) {
            for (opCharge in [0, 4, 5].values()) {
              let s = stateOf(stats(ammo, hits, mirrors, charge), stats(opAmmo, hits, mirrors, opCharge));
              for (seat in [#p1, #p2].values()) {
                for (k in Nat.range(0, 6)) {
                  let move = BotLogic.chooseMove(requestFor(s, seat, complexity, null), T0 + k * 1_000_003);
                  if (not legal(s, seat, move)) Runtime.trap(complexity # " produced an illegal move: " # debug_show (move, s));
                  checked += 1;
                };
              };
            };
          };
        };
      };
    };
  };
};
assert checked > 10_000;
Debug.print("1. Easy, Medium and unknown complexities only ever return a legal move OK");

// ── 2. Easy reaches every legal action ──────────────────────────────────────
do {
  let s = stateOf(stats(2, 0, 3, 0), stats(2, 0, 3, 0));
  var seen = [false, false, false, false];
  for (k in Nat.range(0, 200)) {
    switch (BotLogic.chooseMove(requestFor(s, #p1, "Easy", null), T0 + k * 1_000_003)) {
      case (#load) seen := [true, seen[1], seen[2], seen[3]];
      case (#shoot) seen := [seen[0], true, seen[2], seen[3]];
      case (#shield) seen := [seen[0], seen[1], true, seen[3]];
      case (#mirror) seen := [seen[0], seen[1], seen[2], true];
    };
  };
  assert seen == [true, true, true, true];
};
Debug.print("2. Easy's pick is random over the whole legal set OK");

// ── 3. Medium's tactics ─────────────────────────────────────────────────────
func always(s : Rules.State, seat : TP.Seat, last : ?Rules.Action, want : Rules.Action -> Bool, msg : Text) {
  for (k in Nat.range(0, 60)) {
    let move = BotLogic.chooseMove(requestFor(s, seat, "Medium", last), T0 + k * 1_000_003);
    if (not want(move)) Runtime.trap(msg # ": got " # debug_show (move));
  };
};

// own laser, opponent unarmed: shoot, the win is certain
always(stateOf(stats(5, 0, 3, 5), stats(0, 0, 3, 0)), #p1, null, func(a) = a == #shoot, "laser vs unarmed");
// opponent unarmed with no shield or mirror: shoot
always(stateOf(stats(2, 0, 3, 0), stats(0, 3, 0, 0)), #p1, null, func(a) = a == #shoot, "exposed unarmed opponent");
// opponent unarmed otherwise: never raise a defense, never a mirror
always(stateOf(stats(1, 0, 3, 0), stats(0, 0, 3, 0)), #p1, null, func(a) = a == #load, "unarmed opponent");
// opponent holds the laser: shoot for the draw
always(stateOf(stats(1, 0, 3, 0), stats(0, 0, 3, 5)), #p1, null, func(a) = a == #shoot, "opponent laser");
// opponent armed, no ammo of my own: a defense, LOAD only as a rare gamble
do {
  var loads = 0;
  for (k in Nat.range(0, 200)) {
    switch (BotLogic.chooseMove(requestFor(stateOf(stats(0, 0, 3, 0), stats(2, 0, 3, 0)), #p1, "Medium", null), T0 + k * 1_000_003)) {
      case (#load) loads += 1;
      case (#shoot) Runtime.trap("shot with no ammo");
      case _ {};
    };
  };
  assert loads > 0 and loads < 40;
};
// own laser and an armed opponent: mostly shoot, never LOAD
always(stateOf(stats(5, 0, 3, 5), stats(3, 0, 3, 0)), #p1, null, func(a) = a != #load, "laser vs armed");
// every defense spent: LOAD is the only legal move and is still returned
always(stateOf(stats(0, 3, 0, 0), stats(3, 0, 3, 0)), #p1, null, func(a) = a == #load, "no defense left");
// a broken shield is never raised, a spent mirror never deployed
always(stateOf(stats(2, 3, 0, 0), stats(3, 0, 3, 0)), #p1, ?#shoot, func(a) = a == #shoot or a == #load, "spent defenses");
Debug.print("3. Medium: finishing shot, no needless defense, laser draw, rarely loads into an armed opponent OK");

// ── 4. full games, Medium vs Easy (both seats): Medium out-scores Easy ──────
func playout(p1c : Text, p2c : Text, seed : Int) : ?TP.Verdict {
  var s = Rules.init("");
  var turn = 0;
  var last1 : ?Rules.Action = null;
  var last2 : ?Rules.Action = null;
  var t = seed;
  while (turn < 80) {
    t += 7_919_003;
    let a1 = BotLogic.chooseMove(requestFor(s, #p1, p1c, last2), t);
    t += 104_729;
    let a2 = BotLogic.chooseMove(requestFor(s, #p2, p2c, last1), t);
    let r = Rules.resolve(s, a1, a2);
    if (r.verdict != null) return r.verdict;
    s := r.state;
    last1 := ?a1;
    last2 := ?a2;
    turn += 1;
  };
  null;
};

var mediumWins = 0;
var easyWins = 0;
for (g in Nat.range(0, 150)) {
  let seed : Int = T0 + g * 1_000_000_007;
  switch (playout("Medium", "Easy", seed)) {
    case (?#p1Wins) mediumWins += 1;
    case (?#p2Wins) easyWins += 1;
    case _ {};
  };
  switch (playout("Easy", "Medium", seed)) {
    case (?#p2Wins) mediumWins += 1;
    case (?#p1Wins) easyWins += 1;
    case _ {};
  };
};
Debug.print("   Medium wins " # mediumWins.toText() # ", Easy wins " # easyWins.toText() # " of 300");
assert mediumWins > easyWins * 2;
Debug.print("4. Medium beats Easy decisively, seated either way OK");

// ── 5. wired live through canister_players.mo: two canister seats play a
//      full real #simultaneous match ──────────────────────────────────────────
// The player's first table and their view of it, or `#browsing`.
func statusOf(reg : TP.Registry<Rules.State, Rules.Action>, at : Int, p : TP.PlayerId) : {
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

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

let bot1 = Principal.fromText("aaaaa-aa");
let bot2 = Principal.fromText("2vxsx-fae");

var entropy : Int = T0;

func playFullMatch(c1 : Text, c2 : Text) : async* () {
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
    afterMutation = func<system>(now : Int, id : TP.TableId, b : Bool) : async* () {
      await* settleAfter<system>(now, id, b);
    };
    arm = func<system>(_ : TP.TableId, _ : Nat) {};
  };
  let cp = CanisterPlayers.endpointOf(ctx);

  let id = ok(await* cp.createTable<system>(bot1, #p1, #open, "", c1), "bot1 creates a table");
  let sidBot1 = CanisterPlayers.idForCanister(bot1, c1);
  ignore ok(await* cp.joinTable<system>(bot2, id, #p2, null, c2), "bot2 joins; game starts");

  var round = 0;
  var stalled = true;
  label loop_ while (round < 100) {
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
        stalled := false;
        break loop_;
      };
      case (other) Runtime.trap("unexpected state for bot1: " # debug_show (other));
    };
    await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx, T0);
    round += 1;
  };
  assert not stalled;
};

await* playFullMatch("Easy", "Easy");
await* playFullMatch("Medium", "Easy");
await* playFullMatch("Medium", "Medium");
Debug.print("5. canister-seated Easy/Medium bots play full real matches to a verdict OK");

Debug.print("ALL 007 BOT CHECKS PASSED");
