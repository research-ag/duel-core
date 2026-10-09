import Array "mo:core/Array";

import TP "mo:duel-game-core";
import Rules "../src/ChopsticksRules";

module {

  /// Sent by `Bot.mo`'s `register`. Bunny: no lookahead. Fox: one ply.
  /// Bear: depth-limited negamax (the position graph is cyclic).
  public let COMPLEXITIES : [Text] = ["Bunny", "Fox", "Bear"];

  let BEAR_DEPTH : Nat = 6;
  let WIN : Int = 1000;

  public func chooseMove(req : TP.MoveRequest<Rules.View, Rules.Action>) : Rules.Action {
    switch (req.complexity) {
      case ("Fox") foxMove(req);
      case ("Bear") bearMove(req.game, req.seat);
      case (_) bunnyMove(req);
    };
  };

  func pick(moves : [Rules.Action], turn : Nat) : Rules.Action = moves[turn % moves.size()];

  func winsNow(s : Rules.State, seat : TP.Seat, a : Rules.Action) : Bool = Rules.resolve(s, seat, a).verdict != null;

  func canWinNow(s : Rules.State, seat : TP.Seat) : Bool = Rules.legalActions(s, seat).any<Rules.Action>(func(a) = winsNow(s, seat, a));

  func bunnyMove(req : TP.MoveRequest<Rules.View, Rules.Action>) : Rules.Action = pick(Rules.legalActions(req.game, req.seat), req.step);

  // Take an immediate win; otherwise never hand the opponent one.
  func foxMove(req : TP.MoveRequest<Rules.View, Rules.Action>) : Rules.Action {
    let s = req.game;
    let seat = req.seat;
    let moves = Rules.legalActions(s, seat);
    switch (moves.find<Rules.Action>(func(a) = winsNow(s, seat, a))) {
      case (?a) return a;
      case null {};
    };
    let safe = moves.filter<Rules.Action>(func(a) = not canWinNow(Rules.resolve(s, seat, a).state, Rules.other(seat)));
    pick(if (safe.size() > 0) safe else moves, req.step);
  };

  func eval(s : Rules.State, seat : TP.Seat) : Int = Rules.liveHands(Rules.handsOf(s, seat)) - Rules.liveHands(Rules.handsOf(s, Rules.other(seat)));

  func scoreAfter(s : Rules.State, seat : TP.Seat, a : Rules.Action, depth : Nat, alpha : Int, beta : Int) : Int {
    let r = Rules.resolve(s, seat, a);
    switch (r.verdict) {
      case (?_) WIN + depth;
      case null - value(r.state, Rules.other(seat), depth - 1, -beta, -alpha);
    };
  };

  func value(s : Rules.State, seat : TP.Seat, depth : Nat, alpha : Int, beta : Int) : Int {
    if (depth == 0) return eval(s, seat);
    var best : Int = -2 * WIN;
    var a = alpha;
    label search for (m in Rules.legalActions(s, seat).values()) {
      let v = scoreAfter(s, seat, m, depth, a, beta);
      if (v > best) best := v;
      if (best > a) a := best;
      if (a >= beta) break search;
    };
    best;
  };

  func bearMove(s : Rules.State, seat : TP.Seat) : Rules.Action {
    let moves = Rules.legalActions(s, seat);
    var best = moves[0];
    var bestValue : Int = -2 * WIN;
    for (m in moves.values()) {
      let v = scoreAfter(s, seat, m, BEAR_DEPTH, bestValue, 2 * WIN);
      if (v > bestValue) {
        bestValue := v;
        best := m;
      };
    };
    best;
  };

};
