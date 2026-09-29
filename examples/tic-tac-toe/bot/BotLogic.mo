import TP "mo:duel-game-core";
import Rules "../src/TicTacToeRules";

module {

  /// Sent by `Bot.mo`'s `register`. Easy: no lookahead. Hard: full
  /// negamax, never loses. Unknown values play Easy.
  public let COMPLEXITIES : [Text] = ["Easy", "Hard"];

  public func chooseMove(req : TP.MoveRequest<Rules.State, Rules.Action>) : Rules.Action {
    if (req.complexity == "Hard") bestMove(req.game, req.seat) else easyMove(req);
  };

  func easyMove(req : TP.MoveRequest<Rules.State, Rules.Action>) : Rules.Action {
    let moves = Rules.legalActions(req.game, req.seat);
    moves[req.turn % moves.size()];
  };

  func other(seat : TP.Seat) : TP.Seat = switch (seat) {
    case (#p1) #p2;
    case (#p2) #p1;
  };

  // Negamax with alpha-beta: 1 forced win, 0 draw, -1 forced loss.
  // `Rules.resolve` supplies every terminal verdict.
  func value(s : Rules.State, seat : TP.Seat, alpha : Int, beta : Int) : Int {
    var best : Int = -2;
    var a = alpha;
    label search for (action in Rules.legalActions(s, seat).values()) {
      let r = Rules.resolve(s, seat, action);
      let v : Int = switch (r.verdict) {
        case (?#draw) 0;
        case (?_) 1;
        case null - value(r.state, other(seat), -beta, -a);
      };
      if (v > best) best := v;
      if (best > a) a := best;
      if (a >= beta) break search;
    };
    best;
  };

  func bestMove(s : Rules.State, seat : TP.Seat) : Rules.Action {
    let moves = Rules.legalActions(s, seat);
    var best = moves[0];
    var bestValue : Int = -2;
    for (action in moves.values()) {
      let r = Rules.resolve(s, seat, action);
      let v : Int = switch (r.verdict) {
        case (?#draw) 0;
        case (?_) 1;
        case null - value(r.state, other(seat), -1, -bestValue);
      };
      if (v > bestValue) {
        bestValue := v;
        best := action;
      };
    };
    best;
  };

};
