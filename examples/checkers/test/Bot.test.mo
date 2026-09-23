// Proves the checkers bot (`../bot/Bot.mo`/`BotLogic.mo`, the
// milestone-02 rule-following canister player) two ways: (1)
// `BotLogic.chooseMove` only ever returns a `Rules.legalActions`-listed
// move for a handful of synthetic positions, including one where a
// capture is mandatory (no engine, no actor — the "testing offline"
// pattern `../../../CLAUDE.md`'s "Canister players" note describes); and
// (2) wired live through `mo:duel-game-core/canister_players`, TWO
// canister-seated bots play each other through several real
// `#alternating` plies with no illegal move and no trap — proving the
// `#alternating` due-seat/turn-order trigger points specifically (`#p1`
// first, then whichever seat the turn just passed to), the milestone-02
// goal the canister-players design calls out. `BotLogic.chooseMove` is
// used directly as the `callBot` continuation, so no real second canister
// is needed here — same as `backend/test/CanisterPlayers.test.mo` and
// `examples/racing/test/Bot.test.mo`.
// Run: mops test Bot
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import TP "mo:duel-game-core";
import CanisterPlayers "mo:duel-game-core/canister_players";
import Registry "mo:duel-game-core/registry";

import BotLogic "../bot/BotLogic";
import Rules "../src/CheckersRules";

let spec = Rules.spec();

func idx(r : Nat, c : Nat) : Nat = r * 8 + c;

// ── 1. chooseMove never strays outside legalActions — including when a
//        capture is mandatory, where only ONE result exists at all ──────
do {
  let s0 = Rules.init();
  for (turn in Nat.range(0, 9)) {
    let req : TP.MoveRequest<Rules.State> = {
      tableId = 0;
      seat = #p1;
      game = s0;
      mode = #alternating;
      turn;
      gen = 0;
      retryReason = null;
    };
    let move = BotLogic.chooseMove(req);
    let legal = Rules.legalActions(s0, #p1);
    assert Array.find<Rules.Action>(legal, func(a) = a == move) != null;
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
    let req : TP.MoveRequest<Rules.State> = {
      tableId = 0;
      seat = #p1;
      game = { board = chainBoard };
      mode = #alternating;
      turn;
      gen = 0;
      retryReason = null;
    };
    switch (BotLogic.chooseMove(req)) {
      case (#jump { path }) assert path == [idx(6, 1), idx(4, 3), idx(2, 5)];
      case (#move _) Runtime.trap("a capture is mandatory — chooseMove must not offer a #move");
    };
  };
};
Debug.print("1. BotLogic.chooseMove always picks a Rules.legalActions-listed move, mandatory capture included OK");

// ── 2. wired live through canister_players.mo, two canister seats play
//        each other through several real #alternating plies ────────────
let TIMEOUT : Int = 60_000_000_000;
let CLAIM_TIMEOUT : Int = 15_000_000_000;
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
let bot2 = Principal.fromText("2vxsx-fae");
let sidBot1 = CanisterPlayers.sidForCanister(bot1);
let sidBot2 = CanisterPlayers.sidForCanister(bot2);

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

let id = ok(await* cp.createTable(bot1, #p1, #open), "bot1 creates a table");
// bot2's own joinTable eagerly triggers the FIRST ply with no sweep at
// all — the #alternating counterpart to backend/test/CanisterPlayers.test.mo's
// own "bot-vs-bot: the SECOND bot's own joinTable eagerly triggers"
// check, proving #p1 moves first when canister-seated at game start.
ignore ok(await* cp.joinTable(bot2, id, #p2, null), "bot2 joins; game starts");
switch (atTableView(reg, T0, sidBot1)) {
  case (#inGame v) assert v.turn > 0; // #p1's own opening move already resolved
  case (_) Runtime.trap("bot1 should be in-game, at least one ply in");
};

// `maybeNotifyBoth` re-reads status fresh between checking p1 and p2 (see
// `canister_players.mo`'s own doc), so one `sweep` call typically resolves
// TWO plies here (whichever seat is due, then — immediately due in
// turn — the other), not one; this loop doesn't depend on that exact
// count, only that #inGame never stalls (a sweep call that finds a due
// seat but makes no progress at all) across several calls.
var round = 0;
var lastTurn = switch (atTableView(reg, T0, sidBot1)) {
  case (#inGame v) v.turn;
  case (_) 0;
};
var stalled = false;
while (round < 8) {
  await* cp.sweep(T0);
  switch (reg.status(spec, T0, sidBot1)) {
    case (#atTable { view = #inGame v }) {
      if (v.turn == lastTurn) stalled := true; // a due seat's sweep produced no progress at all
      lastTurn := v.turn;
    };
    case (_) {}; // the game already ended — see the check right below
  };
  round += 1;
};
assert not stalled;
switch (reg.status(spec, T0, sidBot1), reg.status(spec, T0, sidBot2)) {
  case (#atTable { view = #inGame v1 }, #atTable { view = #inGame v2 }) {
    assert v1.turn == v2.turn;
    assert v1.turn > 0; // at least the opening ply, and no sweep call ever stalled
  };
  case (_, _) {
    // one seat may have already won (a real, if unlikely, outcome of two
    // rule-following-but-lookahead-free bots after this many plies) —
    // either a real #debrief, or (just as likely, since an all-canister
    // debrief now gets acked on both sides immediately — see
    // `canister_players.mo`'s own "canister vs canister" debrief-ack
    // note) already settled all the way back to #browsing within the
    // very same sweep call that ended it; either way, never a stuck
    // #inGame with an unmet due seat.
    switch (reg.status(spec, T0, sidBot1)) {
      case (#atTable { view = #debrief _ }) {};
      case (#browsing _) {};
      case (other) Runtime.trap("expected in-game, a real debrief, or an already-settled browsing state, got " # debug_show (other));
    };
  };
};
Debug.print("2. two canister-seated bots resolve several real #alternating plies against each other, no stall OK");

Debug.print("ALL CHECKERS BOT CHECKS PASSED");
