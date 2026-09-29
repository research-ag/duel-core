import TP "mo:duel-game-core";
import Rules "../src/TicTacToeRules";

module {

  /// The ways this bot can play, declared once here and sent verbatim by
  /// `Bot.mo`'s `register` (see `../../../backend/README.md`'s "Canister
  /// players" section, "Bot discovery"): `Easy` is the no-lookahead pick
  /// `easyMove` makes; `Hard` is a full minimax search (`bestMove`),
  /// which on a 3x3 board never loses. `req.complexity` is whichever of
  /// these the challenger picked for this seat; anything else plays
  /// `Easy`.
  public let COMPLEXITIES : [Text] = ["Easy", "Hard"];

  public func chooseMove(req : TP.MoveRequest<Rules.State, Rules.Action>) : Rules.Action {
    if (req.complexity == "Hard") bestMove(req.game, req.seat) else easyMove(req);
  };

  /// No lookahead, no win/block detection — picked deterministically from
  /// `req.turn` and the position itself (`moves.size()` shrinks by one
  /// every ply, since a placed mark is never free again), the same shape
  /// `examples/checkers/bot/BotLogic.mo` uses.
  func easyMove(req : TP.MoveRequest<Rules.State, Rules.Action>) : Rules.Action {
    let moves = Rules.legalActions(req.game, req.seat);
    moves[req.turn % moves.size()];
  };

  func other(seat : TP.Seat) : TP.Seat = switch (seat) {
    case (#p1) #p2;
    case (#p2) #p1;
  };

  // Negamax with alpha-beta pruning: the value of `s` for `seat`, who is
  // to move — 1 a forced win, 0 a draw, -1 a forced loss. `Rules.resolve`
  // supplies every terminal verdict, so no line check is re-derived here;
  // a full board always resolves to a draw before `legalActions` could
  // ever come back empty.
  func value(s : Rules.State, seat : TP.Seat, alpha : Int, beta : Int) : Int {
    var best : Int = -2;
    var a = alpha;
    label search for (action in Rules.legalActions(s, seat).values()) {
      let r = Rules.resolve(s, seat, action);
      let v : Int = switch (r.verdict) {
        case (?#draw) 0;
        case (?_) 1; // only the seat that just placed can have completed a line
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
